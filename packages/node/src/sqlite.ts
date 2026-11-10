/*!
 * WebAssembly SQLite engine derived from node-sqlite3-wasm@0.8.61 and SQLite 3.
 *
 * MIT License (node-sqlite3-wasm)
 * Copyright (c) 2022-2024 Tobias Enderle
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---
 *
 * SQLite Is Public Domain (https://www.sqlite.org/copyright.html)
 * The authors of SQLite have dedicated the code to the public domain.
 */

import { version as nodeSqlite3WasmVersion } from 'node-sqlite3-wasm/package.json';
import path from 'path-browserify';
import { fileURLToPath } from './file-url';
import { fault, record } from './value-guards';
import { fetchWasmBytesSync, loadWasmModuleSync, readWasmCString } from './wasm-loader';

export const SQLITE_WASM_CACHE_KEY = `node-sqlite3-wasm@${nodeSqlite3WasmVersion}`;

const SQLITE_OK = 0;
const SQLITE_ERROR = 1;
const SQLITE_BUSY = 5;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;

const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;

const SQLITE_UTF8 = 1;
const SQLITE_DETERMINISTIC = 0x00000800;
const SQLITE_DIRECTONLY = 0x00080000;
const SQLITE_TRANSIENT = -1;

const SQLITE_OPEN_READONLY = 0x00000001;
const SQLITE_OPEN_READWRITE = 0x00000002;
const SQLITE_OPEN_CREATE = 0x00000004;
const SQLITE_OPEN_URI = 0x00000040;
const SQLITE_OPEN_EXCLUSIVE = 0x00000010;

const SQLITE_ACCESS_READWRITE = 1;
const SQLITE_ACCESS_READ = 2;
const SQLITE_LOCK_NONE = 0;

const SQLITE_CANTOPEN = 14;
const SQLITE_CONSTRAINT = 19;
const SQLITE_IOERR_READ = 266;
const SQLITE_IOERR_SHORT_READ = 522;
const SQLITE_IOERR_WRITE = 778;
const SQLITE_IOERR_FSYNC = 1034;
const SQLITE_IOERR_TRUNCATE = 1546;
const SQLITE_IOERR_FSTAT = 1802;
const SQLITE_IOERR_UNLOCK = 2058;
const SQLITE_IOERR_DELETE = 2570;
const SQLITE_IOERR_LOCK = 3850;
const SQLITE_IOERR_CLOSE = 4106;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const MAX_IO_CHUNK = 65536;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const SQLITE_ERROR_STRINGS: ReadonlyMap<number, string> = new Map<number, string>([
  [0, 'not an error'],
  [1, 'SQL logic error'],
  [2, 'internal logic error'],
  [3, 'access permission denied'],
  [4, 'callback requested query abort'],
  [5, 'database is locked'],
  [6, 'database table is locked'],
  [7, 'out of memory'],
  [8, 'attempt to write a readonly database'],
  [9, 'interrupted'],
  [10, 'disk I/O error'],
  [11, 'database disk image is malformed'],
  [12, 'unknown operation'],
  [13, 'database or disk is full'],
  [14, 'unable to open database file'],
  [15, 'locking protocol'],
  [16, 'table contains no data'],
  [17, 'database schema has changed'],
  [18, 'string or blob too big'],
  [19, 'constraint failed'],
  [20, 'datatype mismatch'],
  [21, 'bad parameter or other API misuse'],
  [22, 'large file support is disabled'],
  [23, 'authorization denied'],
  [24, 'auxiliary database format error'],
  [25, 'column index out of range'],
  [26, 'file is not a database'],
  [27, 'notification message'],
  [28, 'warning message'],
]);

export const SQLITE_CONSTANTS = Object.freeze({
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5,
});

export interface SqliteFs {
  constants: Record<string, unknown>;
  [method: string]: unknown;
}

function callFs(fs: SqliteFs, method: string, ...args: unknown[]): unknown {
  const fn = fs[method];
  if (typeof fn !== 'function') {
    throw fault('ENOSYS', `Missing filesystem method ${method}`);
  }
  return Reflect.apply(fn, fs, args);
}

export interface SqliteDeps {
  fs: SqliteFs;
  cwd: () => string;
}

interface RawSqliteWasmExports {
  memory: WebAssembly.Memory;
  table: WebAssembly.Table;
  initRuntime(): void;
  sqlite3_finalize(stmt: number): number;
  sqlite3_reset(stmt: number): number;
  sqlite3_clear_bindings(stmt: number): number;
  sqlite3_value_blob(val: number): number;
  sqlite3_value_text(val: number): number;
  sqlite3_value_bytes(val: number): number;
  sqlite3_value_double(val: number): number;
  sqlite3_value_int64(val: number): bigint;
  sqlite3_value_type(val: number): number;
  sqlite3_result_blob(ctx: number, ptr: number, len: number, dtor: number): void;
  sqlite3_result_blob64(ctx: number, ptr: number, len: bigint, dtor: number): void;
  sqlite3_result_double(ctx: number, val: number): void;
  sqlite3_result_error(ctx: number, ptr: number, len: number): void;
  sqlite3_result_int(ctx: number, val: number): void;
  sqlite3_result_int64(ctx: number, val: bigint): void;
  sqlite3_result_null(ctx: number): void;
  sqlite3_result_text(ctx: number, ptr: number, len: number, dtor: number): void;
  sqlite3_step(stmt: number): number;
  sqlite3_column_count(stmt: number): number;
  sqlite3_column_blob(stmt: number, col: number): number;
  sqlite3_column_bytes(stmt: number, col: number): number;
  sqlite3_column_double(stmt: number, col: number): number;
  sqlite3_column_int64(stmt: number, col: number): bigint;
  sqlite3_column_text(stmt: number, col: number): number;
  sqlite3_column_type(stmt: number, col: number): number;
  sqlite3_column_name(stmt: number, col: number): number;
  sqlite3_column_table_name(stmt: number, col: number): number;
  sqlite3_bind_blob(stmt: number, idx: number, ptr: number, len: number, dtor: number): number;
  sqlite3_bind_blob64(stmt: number, idx: number, ptr: number, len: bigint, dtor: number): number;
  sqlite3_bind_double(stmt: number, idx: number, val: number): number;
  sqlite3_bind_int(stmt: number, idx: number, val: number): number;
  sqlite3_bind_int64(stmt: number, idx: number, val: bigint): number;
  sqlite3_bind_null(stmt: number, idx: number): number;
  sqlite3_bind_text(stmt: number, idx: number, ptr: number, len: number, dtor: number): number;
  sqlite3_bind_parameter_index(stmt: number, namePtr: number): number;
  sqlite3_exec(db: number, sqlPtr: number, cb: number, arg: number, errmsgPtr: number): number;
  sqlite3_prepare_v2(
    db: number,
    sqlPtr: number,
    nByte: number,
    stmtOutPtr: number,
    tailOutPtr: number,
  ): number;
  sqlite3_errmsg(db: number): number;
  sqlite3_last_insert_rowid(db: number): bigint;
  sqlite3_changes(db: number): number;
  sqlite3_close_v2(db: number): number;
  sqlite3_create_function_v2(
    db: number,
    namePtr: number,
    nArg: number,
    eTextRep: number,
    pApp: number,
    xFunc: number,
    xStep: number,
    xFinal: number,
    xDestroy: number,
  ): number;
  sqlite3_open_v2(filenamePtr: number, dbOutPtr: number, flags: number, vfsPtr: number): number;
  sqlite3_get_autocommit(db: number): number;
  malloc(size: number): number;
  free(ptr: number): void;
}

const SQLITE_WASM_URL = new URL('sqlite.wasm', import.meta.url).href;

function expectFn<T extends (...args: never[]) => unknown>(
  exportsObj: WebAssembly.Exports,
  key: string,
): T {
  const val = exportsObj[key];
  if (typeof val !== 'function') {
    throw fault('EIO', `Missing SQLite WebAssembly export "${key}"`, { kind: 'channel' });
  }
  // Invariant: `val` is verified to be a WebAssembly exported function matching the pinned `node-sqlite3-wasm@0.8.61` binary ABI.
  return val as unknown as T;
}

function narrowSqliteWasmExports(raw: WebAssembly.Exports): RawSqliteWasmExports {
  const memory = raw.y;
  const table = raw.sa;
  if (!(memory instanceof WebAssembly.Memory) || !(table instanceof WebAssembly.Table)) {
    throw fault('EIO', 'Invalid SQLite WebAssembly memory/table exports', { kind: 'channel' });
  }
  return {
    memory,
    table,
    initRuntime: expectFn(raw, 'z'),
    sqlite3_finalize: expectFn(raw, 'A'),
    sqlite3_reset: expectFn(raw, 'B'),
    sqlite3_clear_bindings: expectFn(raw, 'C'),
    sqlite3_value_blob: expectFn(raw, 'D'),
    sqlite3_value_text: expectFn(raw, 'E'),
    sqlite3_value_bytes: expectFn(raw, 'F'),
    sqlite3_value_double: expectFn(raw, 'G'),
    sqlite3_value_int64: expectFn(raw, 'H'),
    sqlite3_value_type: expectFn(raw, 'I'),
    sqlite3_result_blob: expectFn(raw, 'J'),
    sqlite3_result_blob64: expectFn(raw, 'K'),
    sqlite3_result_double: expectFn(raw, 'L'),
    sqlite3_result_error: expectFn(raw, 'M'),
    sqlite3_result_int: expectFn(raw, 'N'),
    sqlite3_result_int64: expectFn(raw, 'O'),
    sqlite3_result_null: expectFn(raw, 'P'),
    sqlite3_result_text: expectFn(raw, 'Q'),
    sqlite3_step: expectFn(raw, 'R'),
    sqlite3_column_count: expectFn(raw, 'S'),
    sqlite3_column_blob: expectFn(raw, 'T'),
    sqlite3_column_bytes: expectFn(raw, 'U'),
    sqlite3_column_double: expectFn(raw, 'V'),
    sqlite3_column_int64: expectFn(raw, 'W'),
    sqlite3_column_text: expectFn(raw, 'X'),
    sqlite3_column_type: expectFn(raw, 'Y'),
    sqlite3_column_name: expectFn(raw, 'Z'),
    sqlite3_column_table_name: expectFn(raw, '_'),
    sqlite3_bind_blob: expectFn(raw, '$'),
    sqlite3_bind_blob64: expectFn(raw, 'aa'),
    sqlite3_bind_double: expectFn(raw, 'ba'),
    sqlite3_bind_int: expectFn(raw, 'ca'),
    sqlite3_bind_int64: expectFn(raw, 'da'),
    sqlite3_bind_null: expectFn(raw, 'ea'),
    sqlite3_bind_text: expectFn(raw, 'fa'),
    sqlite3_bind_parameter_index: expectFn(raw, 'ga'),
    sqlite3_exec: expectFn(raw, 'ha'),
    sqlite3_prepare_v2: expectFn(raw, 'ia'),
    sqlite3_errmsg: expectFn(raw, 'ja'),
    sqlite3_last_insert_rowid: expectFn(raw, 'ka'),
    sqlite3_changes: expectFn(raw, 'la'),
    sqlite3_close_v2: expectFn(raw, 'ma'),
    sqlite3_create_function_v2: expectFn(raw, 'na'),
    sqlite3_open_v2: expectFn(raw, 'oa'),
    sqlite3_get_autocommit: expectFn(raw, 'pa'),
    malloc: expectFn(raw, 'qa'),
    free: expectFn(raw, 'ra'),
  };
}

function sqliteTypeError(code: string, message: string): TypeError {
  return Object.assign(new TypeError(message), { code });
}

function sqliteStateError(message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_INVALID_STATE' });
}

function sqliteIllegalConstructor(): Error {
  return Object.assign(new Error('Illegal constructor'), { code: 'ERR_ILLEGAL_CONSTRUCTOR' });
}

function sqliteConstructCallRequired(): TypeError {
  return sqliteTypeError('ERR_CONSTRUCT_CALL_REQUIRED', 'Cannot call constructor without `new`');
}

function resolveExtendedErrcode(primaryRc: number, message: string): number {
  const base = primaryRc & 0xff;
  if (primaryRc !== base) return primaryRc;
  if (base === SQLITE_CONSTRAINT) {
    if (message.startsWith('CHECK constraint failed')) return 275;
    if (message.startsWith('FOREIGN KEY constraint failed')) return 787;
    if (message.startsWith('NOT NULL constraint failed')) return 1299;
    if (message.startsWith('PRIMARY KEY must be unique')) return 1555;
    if (message.startsWith('UNIQUE constraint failed')) return 2067;
  }
  return primaryRc;
}

function sqliteErrorFromCode(primaryRc: number, message: string): Error {
  const errcode = resolveExtendedErrcode(primaryRc, message);
  const errstr = SQLITE_ERROR_STRINGS.get(errcode & 0xff) ?? 'unknown error';
  return Object.assign(new Error(message), {
    code: 'ERR_SQLITE_ERROR',
    errcode,
    errstr,
  });
}

function fsConst(fs: SqliteFs, name: string, fallback: number): number {
  const v = fs.constants[name];
  return typeof v === 'number' ? v : fallback;
}

function safeOffset(big: bigint): number {
  if (big < 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Offset out of safe integer range');
  }
  return Number(big);
}

const MONTH_DAYS_REGULAR = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTH_DAYS_LEAP = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

interface SqlParamOccurrence {
  start: number;
  end: number;
  index: number;
}

interface ParsedSqlParameters {
  maxIndex: number;
  /** 1-based array: `paramNames[i]` is the full named token (`:foo`, `?1`, etc.) or `null` if unnamed `?`. */
  paramNames: Array<string | null>;
  namedToIndex: Map<string, number>;
  occurrences: SqlParamOccurrence[];
}

function isIdentChar(ch: number): boolean {
  return (
    (ch >= 0x30 && ch <= 0x39) ||
    (ch >= 0x41 && ch <= 0x5a) ||
    (ch >= 0x61 && ch <= 0x7a) ||
    ch === 0x5f ||
    ch === 0x24 ||
    ch >= 0x80
  );
}

function isDigitChar(ch: number): boolean {
  return ch >= 0x30 && ch <= 0x39;
}

function parseSqlParameters(sql: string): ParsedSqlParameters {
  let maxIndex = 0;
  const paramNames: Array<string | null> = [null];
  const namedToIndex = new Map<string, number>();
  const occurrences: SqlParamOccurrence[] = [];

  const ensureSlot = (idx: number) => {
    while (paramNames.length <= idx) paramNames.push(null);
    if (idx > maxIndex) maxIndex = idx;
  };

  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql.charCodeAt(i);
    // Single-quoted string literal '...'
    if (ch === 0x27) {
      i += 1;
      while (i < len) {
        if (sql.charCodeAt(i) === 0x27) {
          i += 1;
          if (i < len && sql.charCodeAt(i) === 0x27) {
            i += 1;
            continue;
          }
          break;
        }
        i += 1;
      }
      continue;
    }
    // Double-quoted identifier "..." or backtick `...`
    if (ch === 0x22 || ch === 0x60) {
      const quote = ch;
      i += 1;
      while (i < len) {
        if (sql.charCodeAt(i) === quote) {
          i += 1;
          if (i < len && sql.charCodeAt(i) === quote) {
            i += 1;
            continue;
          }
          break;
        }
        i += 1;
      }
      continue;
    }
    // Bracketed identifier [...]
    if (ch === 0x5b) {
      i += 1;
      while (i < len && sql.charCodeAt(i) !== 0x5d) i += 1;
      if (i < len) i += 1;
      continue;
    }
    // Line comment --...
    if (ch === 0x2d && i + 1 < len && sql.charCodeAt(i + 1) === 0x2d) {
      i += 2;
      while (i < len && sql.charCodeAt(i) !== 0x0a) i += 1;
      continue;
    }
    // Block comment /*...*/
    if (ch === 0x2f && i + 1 < len && sql.charCodeAt(i + 1) === 0x2a) {
      i += 2;
      while (i + 1 < len && !(sql.charCodeAt(i) === 0x2a && sql.charCodeAt(i + 1) === 0x2f)) {
        i += 1;
      }
      i += 2;
      continue;
    }
    // Positional `?` or numbered `?NNN`
    if (ch === 0x3f) {
      const start = i;
      i += 1;
      let numEnd = i;
      while (numEnd < len && isDigitChar(sql.charCodeAt(numEnd))) numEnd += 1;
      if (numEnd > i) {
        const numStr = sql.slice(i, numEnd);
        const idx = Number.parseInt(numStr, 10);
        i = numEnd;
        if (idx >= 1) {
          ensureSlot(idx);
          const tok = `?${numStr}`;
          if (paramNames[idx] === null) paramNames[idx] = tok;
          namedToIndex.set(tok, idx);
          occurrences.push({ start, end: i, index: idx });
        }
      } else {
        const idx = maxIndex + 1;
        ensureSlot(idx);
        occurrences.push({ start, end: i, index: idx });
      }
      continue;
    }
    // Named `:name`, `@name`, `$name`
    if (ch === 0x3a || ch === 0x40 || ch === 0x24) {
      if (
        i + 1 < len &&
        isIdentChar(sql.charCodeAt(i + 1)) &&
        !isDigitChar(sql.charCodeAt(i + 1))
      ) {
        const start = i;
        i += 2;
        while (i < len && isIdentChar(sql.charCodeAt(i))) i += 1;
        const tok = sql.slice(start, i);
        let idx = namedToIndex.get(tok);
        if (idx === undefined) {
          idx = maxIndex + 1;
          ensureSlot(idx);
          paramNames[idx] = tok;
          namedToIndex.set(tok, idx);
        }
        occurrences.push({ start, end: i, index: idx });
        continue;
      }
    }
    i += 1;
  }

  return { maxIndex, paramNames, namedToIndex, occurrences };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function formatSqlDouble(value: number): string {
  if (Number.isNaN(value)) return 'NULL';
  if (!Number.isFinite(value)) return value > 0 ? 'Inf' : '-Inf';
  if (value === 0) return '0.0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const [mantRaw, expRaw] = abs.toExponential(14).split('e');
  const exp = Number.parseInt(expRaw!, 10);
  const digits = mantRaw!.replace('.', '').replace(/0+$/, '') || '0';
  if (exp < -4 || exp >= 15) {
    const frac = digits.length > 1 ? digits.slice(1) : '0';
    const expSign = exp >= 0 ? '+' : '-';
    const expAbs = String(Math.abs(exp)).padStart(2, '0');
    return `${sign}${digits[0]}.${frac}e${expSign}${expAbs}`;
  }
  const intDigitsCount = exp + 1;
  if (intDigitsCount <= 0) {
    return `${sign}0.${'0'.repeat(-intDigitsCount)}${digits}`;
  }
  if (intDigitsCount >= digits.length) {
    return `${sign}${digits}${'0'.repeat(intDigitsCount - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, intDigitsCount)}.${digits.slice(intDigitsCount)}`;
}

function formatSqlLiteral(value: null | number | bigint | string | Uint8Array): string {
  if (value === null) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return formatSqlDouble(value);
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return `x'${bytesToHex(value)}'`;
}

function unquoteSqlIdent(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if (first === '"' && last === '"') return s.slice(1, -1).replaceAll('""', '"');
    if (first === '`' && last === '`') return s.slice(1, -1).replaceAll('``', '`');
    if (first === '[' && last === ']') return s.slice(1, -1);
  }
  return s;
}

function skipSqlQuotedOrComment(sql: string, pos: number): number {
  const len = sql.length;
  const ch = sql.charCodeAt(pos);
  if (ch === 0x27 || ch === 0x22 || ch === 0x60) {
    const q = ch;
    let i = pos + 1;
    while (i < len) {
      if (sql.charCodeAt(i) === q) {
        i += 1;
        if (i < len && sql.charCodeAt(i) === q) {
          i += 1;
          continue;
        }
        break;
      }
      i += 1;
    }
    return i;
  }
  if (ch === 0x5b) {
    let i = pos + 1;
    while (i < len && sql.charCodeAt(i) !== 0x5d) i += 1;
    return i < len ? i + 1 : len;
  }
  if (ch === 0x2d && pos + 1 < len && sql.charCodeAt(pos + 1) === 0x2d) {
    let i = pos + 2;
    while (i < len && sql.charCodeAt(i) !== 0x0a) i += 1;
    return i;
  }
  if (ch === 0x2f && pos + 1 < len && sql.charCodeAt(pos + 1) === 0x2a) {
    let i = pos + 2;
    while (i + 1 < len && !(sql.charCodeAt(i) === 0x2a && sql.charCodeAt(i + 1) === 0x2f)) {
      i += 1;
    }
    return Math.min(len, i + 2);
  }
  return pos;
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  const len = sql.length;
  let start = 0;
  let pos = 0;
  let parenDepth = 0;
  let triggerBlockDepth = 0;
  let seenCreateTrigger = false;

  while (pos < len) {
    const skipped = skipSqlQuotedOrComment(sql, pos);
    if (skipped > pos) {
      pos = skipped;
      continue;
    }
    const ch = sql.charCodeAt(pos);
    if (ch === 0x28) {
      parenDepth += 1;
      pos += 1;
      continue;
    }
    if (ch === 0x29) {
      if (parenDepth > 0) parenDepth -= 1;
      pos += 1;
      continue;
    }
    if (parenDepth === 0 && isIdentChar(ch) && !isDigitChar(ch)) {
      const wStart = pos;
      pos += 1;
      while (pos < len && isIdentChar(sql.charCodeAt(pos))) pos += 1;
      const word = sql.slice(wStart, pos).toUpperCase();
      if (word === 'TRIGGER') seenCreateTrigger = true;
      else if (word === 'BEGIN' && seenCreateTrigger) triggerBlockDepth += 1;
      else if (word === 'END' && triggerBlockDepth > 0) {
        triggerBlockDepth -= 1;
        if (triggerBlockDepth === 0) seenCreateTrigger = false;
      }
      continue;
    }
    if (ch === 0x3b && parenDepth === 0 && triggerBlockDepth === 0) {
      statements.push(sql.slice(start, pos + 1));
      pos += 1;
      start = pos;
      continue;
    }
    pos += 1;
  }
  if (start < len) {
    statements.push(sql.slice(start));
  }
  return statements;
}

const DQS_MISSING_COLUMN_RE =
  /^no such column: "(.*)" - should this be a string literal in single-quotes\?$/s;

function isStandaloneUnaliasedSelectProjection(
  sql: string,
  tokStart: number,
  tokEnd: number,
): boolean {
  let left = tokStart - 1;
  while (left >= 0 && /\s/.test(sql[left]!)) left -= 1;
  if (left < 0) return false;
  let precededBySelectOrComma = false;
  if (sql[left] === ',') {
    // Ensure we are at paren depth 0 inside a SELECT projection list.
    let p = 0;
    let depth = 0;
    let inSelectProj = false;
    while (p <= left) {
      const sk = skipSqlQuotedOrComment(sql, p);
      if (sk > p) {
        p = sk;
        continue;
      }
      const c = sql.charCodeAt(p);
      if (c === 0x28) depth += 1;
      else if (c === 0x29 && depth > 0) depth -= 1;
      else if (depth === 0 && isIdentChar(c) && !isDigitChar(c)) {
        const ws = p;
        p += 1;
        while (p <= left && isIdentChar(sql.charCodeAt(p))) p += 1;
        const kw = sql.slice(ws, p).toUpperCase();
        if (kw === 'SELECT') inSelectProj = true;
        else if (kw === 'FROM' || kw === 'WHERE' || kw === 'VALUES' || kw === 'SET') {
          inSelectProj = false;
        }
        continue;
      }
      p += 1;
    }
    if (inSelectProj && depth === 0) {
      precededBySelectOrComma = true;
    }
  } else {
    const before = sql.slice(0, left + 1);
    if (/(?:^|\s)SELECT(?:\s+(?:DISTINCT|ALL))?$/i.test(before)) {
      precededBySelectOrComma = true;
    }
  }
  if (!precededBySelectOrComma) return false;

  let right = tokEnd;
  while (right < sql.length && /\s/.test(sql[right]!)) right += 1;
  if (right >= sql.length || sql[right] === ',' || sql[right] === ';') return true;
  const rem = sql.slice(right);
  return /^(?:FROM|WHERE|GROUP|HAVING|WINDOW|UNION|INTERSECT|EXCEPT|ORDER|LIMIT)(?:\s|;|$)/i.test(
    rem,
  );
}

function rewriteOneDqsIdentifier(sql: string, missingIdent: string): string | null {
  let pos = 0;
  const len = sql.length;
  while (pos < len) {
    const ch = sql.charCodeAt(pos);
    if (ch === 0x22) {
      const tokStart = pos;
      let i = pos + 1;
      while (i < len) {
        if (sql.charCodeAt(i) === 0x22) {
          i += 1;
          if (i < len && sql.charCodeAt(i) === 0x22) {
            i += 1;
            continue;
          }
          break;
        }
        i += 1;
      }
      const rawTok = sql.slice(tokStart, i);
      const inner = rawTok
        .slice(1, rawTok.endsWith('"') ? -1 : rawTok.length)
        .replaceAll('""', '"');
      let prevNonSpace = tokStart - 1;
      while (prevNonSpace >= 0 && /\s/.test(sql[prevNonSpace]!)) prevNonSpace -= 1;
      const isDotQualified = prevNonSpace >= 0 && sql[prevNonSpace] === '.';
      if (!isDotQualified && inner === missingIdent) {
        const singleLit = `'${inner.replaceAll("'", "''")}'`;
        const replacement = isStandaloneUnaliasedSelectProjection(sql, tokStart, i)
          ? `${singleLit} AS "${rawTok.replaceAll('"', '""')}"`
          : singleLit;
        return sql.slice(0, tokStart) + replacement + sql.slice(i);
      }
      pos = i;
      continue;
    }
    const skipped = skipSqlQuotedOrComment(sql, pos);
    pos = skipped > pos ? skipped : pos + 1;
  }
  return null;
}

interface TableColumnInfo {
  realName: string;
  declType: string | null;
}

interface TableMetaEntry {
  schema: string;
  byLower: Map<string, TableColumnInfo>;
  ordered: TableColumnInfo[];
}

interface ExpandedProjCol {
  alias: string | null;
  originCol: string | null;
}

const IDENT_TOKEN_RE =
  /^(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)/;

function splitCommaTopLevel(segment: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let pos = 0;
  const len = segment.length;
  while (pos < len) {
    const sk = skipSqlQuotedOrComment(segment, pos);
    if (sk > pos) {
      pos = sk;
      continue;
    }
    const ch = segment.charCodeAt(pos);
    if (ch === 0x28) depth += 1;
    else if (ch === 0x29 && depth > 0) depth -= 1;
    else if (ch === 0x2c && depth === 0) {
      items.push(segment.slice(start, pos).trim());
      start = pos + 1;
    }
    pos += 1;
  }
  const tail = segment.slice(start).trim();
  if (tail.length > 0) items.push(tail);
  return items;
}

function parseLeadingWithCtes(sql: string): { ctes: Map<string, string>; restSql: string } {
  const ctes = new Map<string, string>();
  const len = sql.length;
  let pos = 0;
  const skipWsAndComments = () => {
    while (pos < len) {
      if (/\s/.test(sql[pos]!)) {
        pos += 1;
        continue;
      }
      const sk = skipSqlQuotedOrComment(sql, pos);
      if (
        sk > pos &&
        sql[pos] !== '"' &&
        sql[pos] !== "'" &&
        sql[pos] !== '`' &&
        sql[pos] !== '['
      ) {
        pos = sk;
        continue;
      }
      break;
    }
  };

  skipWsAndComments();
  if (!/^WITH(?:\s|$)/i.test(sql.slice(pos, pos + 5))) {
    return { ctes, restSql: sql.slice(pos) };
  }
  pos += 4;
  skipWsAndComments();
  if (/^RECURSIVE(?:\s|$)/i.test(sql.slice(pos, pos + 10))) {
    pos += 9;
    skipWsAndComments();
  }

  while (pos < len) {
    skipWsAndComments();
    const idMatch = IDENT_TOKEN_RE.exec(sql.slice(pos));
    if (!idMatch) break;
    const cteName = unquoteSqlIdent(idMatch[0]).toLowerCase();
    pos += idMatch[0].length;
    skipWsAndComments();

    // Optional explicit CTE column list `(col1, col2)`
    if (pos < len && sql[pos] === '(') {
      let d = 1;
      pos += 1;
      while (pos < len && d > 0) {
        const sk = skipSqlQuotedOrComment(sql, pos);
        if (sk > pos) {
          pos = sk;
          continue;
        }
        if (sql[pos] === '(') d += 1;
        else if (sql[pos] === ')') d -= 1;
        pos += 1;
      }
      skipWsAndComments();
    }

    if (!/^AS(?:\s|\()/i.test(sql.slice(pos, pos + 3))) break;
    pos += 2;
    skipWsAndComments();
    if (/^NOT\s+MATERIALIZED(?:\s|\()/i.test(sql.slice(pos, pos + 20))) {
      pos += /^NOT\s+MATERIALIZED/i.exec(sql.slice(pos))![0].length;
      skipWsAndComments();
    } else if (/^MATERIALIZED(?:\s|\()/i.test(sql.slice(pos, pos + 14))) {
      pos += 12;
      skipWsAndComments();
    }

    if (pos >= len || sql[pos] !== '(') break;
    const bodyStart = pos + 1;
    let depth = 1;
    pos += 1;
    while (pos < len && depth > 0) {
      const sk = skipSqlQuotedOrComment(sql, pos);
      if (sk > pos) {
        pos = sk;
        continue;
      }
      if (sql[pos] === '(') depth += 1;
      else if (sql[pos] === ')') depth -= 1;
      pos += 1;
    }
    const bodyEnd = Math.max(bodyStart, pos - 1);
    ctes.set(cteName, sql.slice(bodyStart, bodyEnd));
    skipWsAndComments();
    if (pos < len && sql[pos] === ',') {
      pos += 1;
      continue;
    }
    break;
  }

  return { ctes, restSql: sql.slice(pos) };
}

function extractMainProjectionAndSources(restSql: string): {
  projItems: string[] | null;
  sources: Array<{ target: string; alias: string }>;
} {
  const sources: Array<{ target: string; alias: string }> = [];
  const trimmed = restSql.trimStart();

  if (/^SELECT(?:\s|$)/i.test(trimmed)) {
    const selHeader = /^SELECT\s+(?:DISTINCT\s+|ALL\s+)?/i.exec(trimmed)!;
    let pos = selHeader[0].length;
    const len = trimmed.length;
    let depth = 0;
    let projEnd = len;
    let fromStart = -1;

    while (pos < len) {
      const sk = skipSqlQuotedOrComment(trimmed, pos);
      if (sk > pos) {
        pos = sk;
        continue;
      }
      const ch = trimmed.charCodeAt(pos);
      if (ch === 0x28) depth += 1;
      else if (ch === 0x29 && depth > 0) depth -= 1;
      else if (depth === 0) {
        if (ch === 0x3b) {
          projEnd = pos;
          break;
        }
        if (pos === 0 || /\s|\)/.test(trimmed[pos - 1]!)) {
          const rem = trimmed.slice(pos);
          if (/^FROM(?:\s|$)/i.test(rem)) {
            projEnd = pos;
            fromStart = pos + 4;
            break;
          }
          if (
            /^(?:WHERE|GROUP|HAVING|WINDOW|UNION|INTERSECT|EXCEPT|ORDER|LIMIT)(?:\s|;|$)/i.test(rem)
          ) {
            projEnd = pos;
            break;
          }
        }
      }
      pos += 1;
    }

    if (fromStart >= 0) {
      let fp = fromStart;
      let fEnd = len;
      let fDepth = 0;
      while (fp < len) {
        const sk = skipSqlQuotedOrComment(trimmed, fp);
        if (sk > fp) {
          fp = sk;
          continue;
        }
        const c = trimmed.charCodeAt(fp);
        if (c === 0x28) fDepth += 1;
        else if (c === 0x29 && fDepth > 0) fDepth -= 1;
        else if (fDepth === 0) {
          if (c === 0x3b) {
            fEnd = fp;
            break;
          }
          if (/\s|\)/.test(trimmed[fp - 1]!)) {
            if (
              /^(?:WHERE|GROUP|HAVING|WINDOW|UNION|INTERSECT|EXCEPT|ORDER|LIMIT)(?:\s|;|$)/i.test(
                trimmed.slice(fp),
              )
            ) {
              fEnd = fp;
              break;
            }
          }
        }
        fp += 1;
      }
      const fromClause = trimmed.slice(fromStart, fEnd);
      const joinParts = fromClause.split(
        /\b(?:NATURAL\s+)?(?:LEFT\s+|RIGHT\s+|FULL\s+|INNER\s+|CROSS\s+)?(?:OUTER\s+)?JOIN\b|,/i,
      );
      for (const rawPart of joinParts) {
        const clean = rawPart.replace(/\bON\b[\s\S]*$|\bUSING\b[\s\S]*$/i, '').trim();
        if (!clean || clean.startsWith('(')) continue;
        // Optional schema prefix `schema.tbl [AS] alias`
        const m =
          /^(?:(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*\.\s*)?("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)(?:\s+(?:AS\s+)?("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*))?/i.exec(
            clean,
          );
        if (m) {
          const target = unquoteSqlIdent(m[1]!);
          const rawAlias = m[2] ? unquoteSqlIdent(m[2]) : target;
          sources.push({ target, alias: rawAlias });
        }
      }
    }

    return { projItems: splitCommaTopLevel(trimmed.slice(selHeader[0].length, projEnd)), sources };
  }

  // DML with RETURNING: INSERT / REPLACE INTO tbl, UPDATE tbl, DELETE FROM tbl
  const dmlTargetMatch =
    /^(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*\.\s*)?("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)(?:\s+AS\s+("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*))?/i.exec(
      trimmed,
    );
  if (dmlTargetMatch) {
    const target = unquoteSqlIdent(dmlTargetMatch[1]!);
    const alias = dmlTargetMatch[2] ? unquoteSqlIdent(dmlTargetMatch[2]) : target;
    sources.push({ target, alias });
  }

  let pos = 0;
  let depth = 0;
  const len = trimmed.length;
  while (pos < len) {
    const sk = skipSqlQuotedOrComment(trimmed, pos);
    if (sk > pos) {
      pos = sk;
      continue;
    }
    const ch = trimmed.charCodeAt(pos);
    if (ch === 0x28) depth += 1;
    else if (ch === 0x29 && depth > 0) depth -= 1;
    else if (depth === 0 && (pos === 0 || /\s|\)/.test(trimmed[pos - 1]!))) {
      if (/^RETURNING(?:\s|$)/i.test(trimmed.slice(pos, pos + 10))) {
        let end = pos + 9;
        let rDepth = 0;
        while (end < len) {
          const rSk = skipSqlQuotedOrComment(trimmed, end);
          if (rSk > end) {
            end = rSk;
            continue;
          }
          if (trimmed[end] === '(') rDepth += 1;
          else if (trimmed[end] === ')' && rDepth > 0) rDepth -= 1;
          else if (trimmed[end] === ';' && rDepth === 0) break;
          end += 1;
        }
        return {
          projItems: splitCommaTopLevel(trimmed.slice(pos + 9, end)),
          sources,
        };
      }
    }
    pos += 1;
  }

  return { projItems: null, sources };
}

function splitExprAndAlias(expr: string): { core: string; alias: string | null } {
  const asMatch =
    /^([\s\S]+?)\s+AS\s+("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*$/i.exec(
      expr,
    );
  if (asMatch) {
    return { core: asMatch[1]!.trim(), alias: unquoteSqlIdent(asMatch[2]!) };
  }
  return { core: expr.trim(), alias: null };
}

function resolveOriginColumnsForQuery(
  sql: string,
  lookupTable: (tblName: string) => TableMetaEntry | null,
  visitedCtes = new Set<string>(),
): ExpandedProjCol[] | null {
  const { ctes, restSql } = parseLeadingWithCtes(sql);
  const expandSqlWithCtes = (
    subSql: string,
    inheritedCtes: Map<string, string>,
  ): ExpandedProjCol[] | null => {
    const subParsed = parseLeadingWithCtes(subSql);
    const mergedCtes = new Map<string, string>(inheritedCtes);
    for (const [k, v] of subParsed.ctes) mergedCtes.set(k, v);
    const { projItems, sources } = extractMainProjectionAndSources(subParsed.restSql);
    if (!projItems) return null;

    const aliasMap = new Map<string, string>();
    for (const s of sources) {
      aliasMap.set(s.alias.toLowerCase(), s.target);
      aliasMap.set(s.target.toLowerCase(), s.target);
    }

    const getCteCols = (name: string): ExpandedProjCol[] | null => {
      const lower = name.toLowerCase();
      const cteBody = mergedCtes.get(lower);
      if (!cteBody || visitedCtes.has(lower)) return null;
      visitedCtes.add(lower);
      try {
        return expandSqlWithCtes(cteBody, mergedCtes);
      } finally {
        visitedCtes.delete(lower);
      }
    };

    const appendWildcardForTarget = (target: string, out: ExpandedProjCol[]) => {
      const cteCols = getCteCols(target);
      if (cteCols) {
        for (const c of cteCols) out.push(c);
        return;
      }
      const tbl = lookupTable(target);
      if (tbl) {
        for (const col of tbl.ordered) {
          out.push({ alias: col.realName, originCol: col.realName });
        }
      }
    };

    const expanded: ExpandedProjCol[] = [];
    for (const rawItem of projItems) {
      const { core, alias } = splitExprAndAlias(rawItem);
      if (core === '*') {
        for (const s of sources) {
          appendWildcardForTarget(s.target, expanded);
        }
        continue;
      }
      if (core.endsWith('.*')) {
        const qual = unquoteSqlIdent(core.slice(0, -2));
        const target = aliasMap.get(qual.toLowerCase()) ?? qual;
        appendWildcardForTarget(target, expanded);
        continue;
      }
      // Simple `[qual.]col` reference vs general expression
      const dotIdx = core.lastIndexOf('.');
      const qual = dotIdx >= 0 ? unquoteSqlIdent(core.slice(0, dotIdx)) : null;
      const colIdent = unquoteSqlIdent(dotIdx >= 0 ? core.slice(dotIdx + 1) : core);
      let originCol: string | null = colIdent;

      const candidateTarget =
        qual !== null
          ? (aliasMap.get(qual.toLowerCase()) ?? qual)
          : sources.length === 1
            ? sources[0]!.target
            : null;
      if (candidateTarget !== null) {
        const cteCols = getCteCols(candidateTarget);
        if (cteCols) {
          const match = cteCols.find(
            (c) =>
              (c.alias !== null && c.alias.toLowerCase() === colIdent.toLowerCase()) ||
              (c.alias === null &&
                c.originCol !== null &&
                c.originCol.toLowerCase() === colIdent.toLowerCase()),
          );
          if (match) {
            originCol = match.originCol;
          }
        }
      }
      expanded.push({ alias: alias ?? colIdent, originCol });
    }
    return expanded;
  };

  return expandSqlWithCtes(restSql, ctes);
}

class SqliteWasmRuntime {
  readonly wasm: RawSqliteWasmExports;
  private readonly fs: SqliteFs;
  private readonly cwd: () => string;
  private cachedBuffer: ArrayBufferLike | null = null;
  private heapU8!: Uint8Array;
  private heap32!: Int32Array;
  private heapU32!: Uint32Array;
  private heap64!: BigInt64Array;
  private readonly freeTableSlots: number[] = [];

  constructor(deps: SqliteDeps) {
    this.fs = deps.fs;
    this.cwd = deps.cwd;
    const mod = loadWasmModuleSync(() => fetchWasmBytesSync(SQLITE_WASM_URL), {
      cacheKey: SQLITE_WASM_CACHE_KEY,
    });
    const instance = new WebAssembly.Instance(mod, { a: this.createWasmImports() });
    this.wasm = narrowSqliteWasmExports(instance.exports);
    this.refreshViews();
    this.wasm.initRuntime();
  }

  private refreshViews(): void {
    const buf = this.wasm.memory.buffer;
    if (buf !== this.cachedBuffer) {
      this.cachedBuffer = buf;
      this.heapU8 = new Uint8Array(buf);
      this.heap32 = new Int32Array(buf);
      this.heapU32 = new Uint32Array(buf);
      this.heap64 = new BigInt64Array(buf);
    }
  }

  u8(): Uint8Array {
    this.refreshViews();
    return this.heapU8;
  }

  i32(): Int32Array {
    this.refreshViews();
    return this.heap32;
  }

  u32(): Uint32Array {
    this.refreshViews();
    return this.heapU32;
  }

  i64(): BigInt64Array {
    this.refreshViews();
    return this.heap64;
  }

  readCString(ptr: number): string {
    if (!ptr) return '';
    return readWasmCString(this.wasm.memory, ptr, '');
  }

  writeUtf8Fixed(str: string, outPtr: number, maxBytes: number): number {
    if (maxBytes <= 0) return 0;
    const bytes = utf8Encoder.encode(str);
    const u8 = this.u8();
    const base = outPtr >>> 0;
    const copyLen = Math.min(bytes.byteLength, maxBytes - 1);
    u8.set(bytes.subarray(0, copyLen), base);
    u8[base + copyLen] = 0;
    return copyLen;
  }

  allocCString(str: string): { ptr: number; byteLength: number } {
    const bytes = utf8Encoder.encode(str);
    const ptr = this.wasm.malloc(bytes.byteLength + 1);
    if (!ptr) throw fault('EIO', 'SQLite WebAssembly malloc failed', { kind: 'channel' });
    const u8 = this.u8();
    const base = ptr >>> 0;
    u8.set(bytes, base);
    u8[base + bytes.byteLength] = 0;
    return { ptr, byteLength: bytes.byteLength };
  }

  allocBytes(bytes: Uint8Array): number {
    const len = Math.max(1, bytes.byteLength);
    const ptr = this.wasm.malloc(len);
    if (!ptr) throw fault('EIO', 'SQLite WebAssembly malloc failed', { kind: 'channel' });
    if (bytes.byteLength > 0) {
      this.u8().set(bytes, ptr >>> 0);
    }
    return ptr;
  }

  addFunction(fn: (...args: number[]) => void, sig: 'viii' | 'vi'): number {
    const paramCodes = sig === 'viii' ? [0x7f, 0x7f, 0x7f] : [0x7f];
    const typeSectionPayload = [0x01, 0x60, paramCodes.length, ...paramCodes, 0x00];
    const wrapperBytes = Uint8Array.of(
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      typeSectionPayload.length,
      ...typeSectionPayload,
      0x02,
      0x07,
      0x01,
      0x01,
      0x65,
      0x01,
      0x66,
      0x00,
      0x00,
      0x07,
      0x05,
      0x01,
      0x01,
      0x66,
      0x00,
      0x00,
    );
    const wrapperMod = new WebAssembly.Module(wrapperBytes);
    const wrapperInst = new WebAssembly.Instance(wrapperMod, { e: { f: fn } });
    const exportedFn = wrapperInst.exports.f;
    const slot =
      this.freeTableSlots.length > 0 ? this.freeTableSlots.pop()! : this.wasm.table.grow(1);
    this.wasm.table.set(slot, exportedFn);
    return slot;
  }

  removeFunction(slot: number): void {
    if (slot > 0) {
      this.wasm.table.set(slot, null);
      this.freeTableSlots.push(slot);
    }
  }

  private fileFd(fi: number): number {
    return this.i32()[(fi + 4) >>> 2]!;
  }

  private fileIsLocked(fi: number): boolean {
    return this.i32()[(fi + 8) >>> 2] !== 0;
  }

  private setFileLocked(fi: number, locked: boolean): void {
    this.i32()[(fi + 8) >>> 2] = locked ? 1 : 0;
  }

  private filePath(fi: number): string {
    const pathPtr = this.u32()[(fi + 12) >>> 2]!;
    return this.readCString(pathPtr);
  }

  private unlockFile(fi: number, level: number): number {
    if (level === SQLITE_LOCK_NONE && this.fileIsLocked(fi)) {
      try {
        callFs(this.fs, 'rmdirSync', `${this.filePath(fi)}.lock`);
      } catch (err) {
        if (!record(err) || err.code !== 'ENOENT') return SQLITE_IOERR_UNLOCK;
      }
      this.setFileLocked(fi, false);
    }
    return SQLITE_OK;
  }

  private createWasmImports(): WebAssembly.ModuleImports {
    return {
      // _emscripten_get_now
      a: () => performance.now(),
      // _nodejsSync
      b: (fi: number, _flags: number): number => {
        try {
          callFs(this.fs, 'fsyncSync', this.fileFd(fi));
          return SQLITE_OK;
        } catch {
          return SQLITE_IOERR_FSYNC;
        }
      },
      // _nodejsTruncate
      c: (fi: number, size: bigint): number => {
        try {
          callFs(this.fs, 'ftruncateSync', this.fileFd(fi), safeOffset(size));
          return SQLITE_OK;
        } catch {
          return SQLITE_IOERR_TRUNCATE;
        }
      },
      // _nodejsWrite
      d: (fi: number, bufPtr: number, bytes: number, offset: bigint): number => {
        try {
          const fd = this.fileFd(fi);
          let pos = safeOffset(offset);
          let remaining = bytes >>> 0;
          let ptr = bufPtr >>> 0;
          while (remaining > 0) {
            const chunk = Math.min(remaining, MAX_IO_CHUNK);
            const sub = this.u8().subarray(ptr, ptr + chunk);
            const written = callFs(this.fs, 'writeSync', fd, sub, 0, chunk, pos);
            if (typeof written !== 'number' || written !== chunk) return SQLITE_IOERR_WRITE;
            ptr += chunk;
            pos += chunk;
            remaining -= chunk;
          }
          return SQLITE_OK;
        } catch {
          return SQLITE_IOERR_WRITE;
        }
      },
      // _nodejsRead
      e: (fi: number, outPtr: number, bytes: number, offset: bigint): number => {
        try {
          const fd = this.fileFd(fi);
          const pos = safeOffset(offset);
          const totalTarget = bytes >>> 0;
          let totalRead = 0;
          while (totalRead < totalTarget) {
            const chunk = Math.min(totalTarget - totalRead, MAX_IO_CHUNK);
            const dest = this.u8().subarray(
              (outPtr >>> 0) + totalRead,
              (outPtr >>> 0) + totalRead + chunk,
            );
            const n = callFs(this.fs, 'readSync', fd, dest, 0, chunk, pos + totalRead);
            if (typeof n !== 'number' || n < 0) return SQLITE_IOERR_READ;
            totalRead += n;
            if (n < chunk) break;
          }
          if (totalRead === totalTarget) return SQLITE_OK;
          this.u8().fill(0, (outPtr >>> 0) + totalRead, (outPtr >>> 0) + totalTarget);
          return SQLITE_IOERR_SHORT_READ;
        } catch {
          return SQLITE_IOERR_READ;
        }
      },
      // _nodejsClose
      f: (fi: number): number => {
        this.unlockFile(fi, SQLITE_LOCK_NONE);
        try {
          callFs(this.fs, 'closeSync', this.fileFd(fi));
          return SQLITE_OK;
        } catch {
          return SQLITE_IOERR_CLOSE;
        }
      },
      // _nodejs_max_path_length
      g: (): number => 4096,
      // _nodejsRandomness
      h: (_vfs: number, bytes: number, outPtr: number): number => {
        const len = bytes >>> 0;
        const view = this.u8().subarray(outPtr >>> 0, (outPtr >>> 0) + len);
        for (let off = 0; off < len; off += MAX_IO_CHUNK) {
          globalThis.crypto.getRandomValues(view.subarray(off, Math.min(off + MAX_IO_CHUNK, len)));
        }
        return len;
      },
      // __setitimer_js
      i: (): number => 0,
      // _emscripten_resize_heap
      j: (requestedSize: number): number => {
        const req = requestedSize >>> 0;
        const maxHeap = 2147483648;
        if (req > maxHeap) return 0;
        const oldSize = this.wasm.memory.buffer.byteLength;
        const overGrown = Math.min(oldSize * 1.2, req + 100663296);
        const aligned = Math.min(maxHeap, Math.ceil(Math.max(req, overGrown) / 65536) * 65536);
        const pages = Math.max(1, ((aligned - oldSize + 65535) / 65536) | 0);
        try {
          this.wasm.memory.grow(pages);
          this.refreshViews();
          return 1;
        } catch {
          return 0;
        }
      },
      // _proc_exit
      k: (code: number): never => {
        throw fault('EIO', `SQLite WebAssembly exited unexpectedly (${code})`, { kind: 'channel' });
      },
      // __emscripten_runtime_keepalive_clear
      l: (): void => {},
      // _nodejsFullPathname
      m: (_vfs: number, relPathPtr: number, sizeFullPath: number, outFullPath: number): number => {
        const rel = this.readCString(relPathPtr);
        const full = path.resolve(this.cwd(), rel);
        const encodedLen = utf8Encoder.encode(full).byteLength;
        if (encodedLen >= sizeFullPath) return SQLITE_CANTOPEN;
        this.writeUtf8Fixed(full, outFullPath, sizeFullPath);
        return SQLITE_OK;
      },
      // __abort_js
      n: (): never => {
        throw fault('EIO', 'SQLite WebAssembly aborted', { kind: 'channel' });
      },
      // __localtime_js
      o: (time: bigint, tmPtr: number): number => {
        const secs = Number(time);
        if (!Number.isFinite(secs)) return 1;
        const date = new Date(secs * 1000);
        if (Number.isNaN(date.getTime())) return 1;
        const i32 = this.i32();
        const base = tmPtr >>> 2;
        i32[base] = date.getSeconds();
        i32[base + 1] = date.getMinutes();
        i32[base + 2] = date.getHours();
        i32[base + 3] = date.getDate();
        i32[base + 4] = date.getMonth();
        i32[base + 5] = date.getFullYear() - 1900;
        i32[base + 6] = date.getDay();
        const table = isLeapYear(date.getFullYear()) ? MONTH_DAYS_LEAP : MONTH_DAYS_REGULAR;
        i32[base + 7] = (table[date.getMonth()] ?? 0) + date.getDate() - 1;
        const winterOffset = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
        const summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
        const dst =
          summerOffset !== winterOffset &&
          date.getTimezoneOffset() === Math.min(winterOffset, summerOffset)
            ? 1
            : 0;
        i32[base + 8] = dst;
        i32[base + 9] = -(date.getTimezoneOffset() * 60);
        return 0;
      },
      // __tzset_js
      p: (timezone: number, daylight: number, stdName: number, dstName: number): void => {
        const year = new Date().getFullYear();
        const winter = new Date(year, 0, 1).getTimezoneOffset();
        const summer = new Date(year, 6, 1).getTimezoneOffset();
        this.u32()[timezone >>> 2] = Math.max(winter, summer) * 60;
        this.i32()[daylight >>> 2] = winter !== summer ? 1 : 0;
        const fmt = (off: number) => {
          const sign = off >= 0 ? '-' : '+';
          const abs = Math.abs(off);
          return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
        };
        const wName = fmt(winter);
        const sName = fmt(summer);
        if (summer < winter) {
          this.writeUtf8Fixed(wName, stdName, 17);
          this.writeUtf8Fixed(sName, dstName, 17);
        } else {
          this.writeUtf8Fixed(wName, dstName, 17);
          this.writeUtf8Fixed(sName, stdName, 17);
        }
      },
      // _emscripten_date_now
      q: (): number => Date.now(),
      // _nodejs_open
      r: (filePathPtr: number, flags: number, mode: number): number => {
        let oflags = 0;
        if (flags & SQLITE_OPEN_EXCLUSIVE) oflags |= fsConst(this.fs, 'O_EXCL', 128);
        if (flags & SQLITE_OPEN_CREATE) oflags |= fsConst(this.fs, 'O_CREAT', 64);
        if (flags & SQLITE_OPEN_READONLY) oflags |= fsConst(this.fs, 'O_RDONLY', 0);
        if (flags & SQLITE_OPEN_READWRITE) oflags |= fsConst(this.fs, 'O_RDWR', 2);
        try {
          const fd = callFs(this.fs, 'openSync', this.readCString(filePathPtr), oflags, mode);
          return typeof fd === 'number' ? fd : -1;
        } catch {
          return -1;
        }
      },
      // _nodejsCheckReservedLock
      s: (fi: number, outResult: number): number => {
        try {
          callFs(this.fs, 'accessSync', `${this.filePath(fi)}.lock`, fsConst(this.fs, 'F_OK', 0));
          this.i32()[outResult >>> 2] = 1;
        } catch {
          this.i32()[outResult >>> 2] = 0;
        }
        return SQLITE_OK;
      },
      // _nodejsUnlock
      t: (fi: number, level: number): number => this.unlockFile(fi, level),
      // _nodejsLock
      u: (fi: number, _level: number): number => {
        if (!this.fileIsLocked(fi)) {
          try {
            callFs(this.fs, 'mkdirSync', `${this.filePath(fi)}.lock`);
          } catch (err) {
            return record(err) && err.code === 'EEXIST' ? SQLITE_BUSY : SQLITE_IOERR_LOCK;
          }
          this.setFileLocked(fi, true);
        }
        return SQLITE_OK;
      },
      // _nodejsFileSize
      v: (fi: number, outSize: number): number => {
        try {
          const st = callFs(this.fs, 'fstatSync', this.fileFd(fi));
          const size = record(st) && typeof st.size === 'number' ? st.size : 0;
          this.i64()[outSize >>> 3] = BigInt(size);
          return SQLITE_OK;
        } catch {
          return SQLITE_IOERR_FSTAT;
        }
      },
      // _nodejsAccess
      w: (_vfs: number, filePathPtr: number, flags: number, outResult: number): number => {
        let aflags = fsConst(this.fs, 'F_OK', 0);
        if (flags === SQLITE_ACCESS_READWRITE) {
          aflags = fsConst(this.fs, 'R_OK', 4) | fsConst(this.fs, 'W_OK', 2);
        } else if (flags === SQLITE_ACCESS_READ) {
          aflags = fsConst(this.fs, 'R_OK', 4);
        }
        try {
          callFs(this.fs, 'accessSync', this.readCString(filePathPtr), aflags);
          this.i32()[outResult >>> 2] = 1;
        } catch {
          this.i32()[outResult >>> 2] = 0;
        }
        return SQLITE_OK;
      },
      // _nodejsDelete
      x: (_vfs: number, filePathPtr: number, dirSync: number): number => {
        const target = this.readCString(filePathPtr);
        try {
          callFs(this.fs, 'unlinkSync', target);
        } catch (err) {
          if (!record(err) || err.code !== 'ENOENT') return SQLITE_IOERR_DELETE;
        }
        if (dirSync) {
          try {
            callFs(this.fs, 'accessSync', path.dirname(target), fsConst(this.fs, 'F_OK', 0));
          } catch {
            return SQLITE_IOERR_FSYNC;
          }
        }
        return SQLITE_OK;
      },
    };
  }
}

const NO_PENDING_ERROR = Symbol('no-pending-error');
const kInternalStatementConstruct = Symbol('kInternalStatementConstruct');

const IteratorPrototype: object = Object.getPrototypeOf(
  Object.getPrototypeOf([][Symbol.iterator]()),
);

interface StatementIteratorState {
  nextRow: () => { value: unknown; done: boolean };
  finish: () => void;
  done: boolean;
}

const iteratorStates = new WeakMap<object, StatementIteratorState>();

function StatementIteratorConstructor(): void {
  throw sqliteIllegalConstructor();
}

const statementIteratorProto: object = Object.create(IteratorPrototype, {
  constructor: {
    value: StatementIteratorConstructor,
    writable: true,
    enumerable: false,
    configurable: true,
  },
  next: {
    value: function next(this: object): { value: unknown; done: boolean } {
      const st = iteratorStates.get(this);
      if (!st || st.done) return { value: undefined, done: true };
      return st.nextRow();
    },
    writable: true,
    enumerable: true,
    configurable: true,
  },
  return: {
    value: function iterReturn(this: object, value?: unknown): { value: unknown; done: true } {
      const st = iteratorStates.get(this);
      if (st && !st.done) {
        st.done = true;
        st.finish();
      }
      return { value, done: true };
    },
    writable: true,
    enumerable: true,
    configurable: true,
  },
});

function validateDbPath(input: unknown): string {
  let resolved: string;
  if (typeof input === 'string') {
    resolved = input;
  } else if (input instanceof Uint8Array) {
    resolved = utf8Decoder.decode(input);
  } else if (input instanceof URL) {
    resolved = fileURLToPath(input);
  } else {
    throw sqliteTypeError(
      'ERR_INVALID_ARG_TYPE',
      'The "path" argument must be a string, Uint8Array, or URL without null bytes.',
    );
  }
  if (resolved.includes('\0')) {
    throw sqliteTypeError(
      'ERR_INVALID_ARG_TYPE',
      'The "path" argument must be a string, Uint8Array, or URL without null bytes.',
    );
  }
  return resolved;
}

function validateBooleanOption(
  obj: Record<string, unknown>,
  key: string,
  defaultVal: boolean,
): boolean {
  const val = obj[key];
  if (val === undefined) return defaultVal;
  if (typeof val !== 'boolean') {
    throw sqliteTypeError(
      'ERR_INVALID_ARG_TYPE',
      `The "options.${key}" argument must be a boolean.`,
    );
  }
  return val;
}

function validateBoolArg(val: unknown, name: string): boolean {
  if (typeof val !== 'boolean') {
    throw sqliteTypeError('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be a boolean.`);
  }
  return val;
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' &&
      value !== null &&
      typeof Reflect.get(value, 'then') === 'function') ||
    (typeof value === 'function' && typeof Reflect.get(value, 'then') === 'function')
  );
}

function toOptionRecord(options: unknown): Record<string, unknown> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw sqliteTypeError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be an object.');
  }
  const rec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) rec[k] = v;
  return rec;
}

function narrowSafeSqlInt(big: bigint, readBigInts: boolean): bigint | number {
  if (readBigInts) return big;
  if (big < BigInt(Number.MIN_SAFE_INTEGER) || big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Object.assign(
      new RangeError(`Value is too large to be represented as a JavaScript number: ${big}`),
      { code: 'ERR_OUT_OF_RANGE' },
    );
  }
  return Number(big);
}

interface DatabaseConfigOptions {
  open: boolean;
  readOnly: boolean;
  enableForeignKeyConstraints: boolean;
  enableDoubleQuotedStringLiterals: boolean;
  allowExtension: boolean;
  timeout: number;
  readBigInts: boolean;
  returnArrays: boolean;
  allowBareNamedParameters: boolean;
  allowUnknownNamedParameters: boolean;
}

function parseDatabaseOptions(options: unknown): DatabaseConfigOptions {
  if (options === undefined) {
    return {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 0,
      readBigInts: false,
      returnArrays: false,
      allowBareNamedParameters: true,
      allowUnknownNamedParameters: false,
    };
  }
  const rec = toOptionRecord(options);

  const open = validateBooleanOption(rec, 'open', true);
  const readOnly = validateBooleanOption(rec, 'readOnly', false);
  const enableForeignKeyConstraints = validateBooleanOption(
    rec,
    'enableForeignKeyConstraints',
    true,
  );
  const enableDoubleQuotedStringLiterals = validateBooleanOption(
    rec,
    'enableDoubleQuotedStringLiterals',
    false,
  );
  const allowExtension = validateBooleanOption(rec, 'allowExtension', false);
  let timeout = 0;
  if (rec.timeout !== undefined) {
    if (typeof rec.timeout !== 'number' || !Number.isInteger(rec.timeout)) {
      throw sqliteTypeError(
        'ERR_INVALID_ARG_TYPE',
        'The "options.timeout" argument must be an integer.',
      );
    }
    if (rec.timeout < 0 || rec.timeout > INT32_MAX) {
      throw Object.assign(new RangeError('The value of "options.timeout" is out of range.'), {
        code: 'ERR_OUT_OF_RANGE',
      });
    }
    timeout = rec.timeout;
  }
  const readBigInts = validateBooleanOption(rec, 'readBigInts', false);
  const returnArrays = validateBooleanOption(rec, 'returnArrays', false);
  const allowBareNamedParameters = validateBooleanOption(rec, 'allowBareNamedParameters', true);
  const allowUnknownNamedParameters = validateBooleanOption(
    rec,
    'allowUnknownNamedParameters',
    false,
  );
  return {
    open,
    readOnly,
    enableForeignKeyConstraints,
    enableDoubleQuotedStringLiterals,
    allowExtension,
    timeout,
    readBigInts,
    returnArrays,
    allowBareNamedParameters,
    allowUnknownNamedParameters,
  };
}

export function createSqliteModule(deps: SqliteDeps) {
  let runtime: SqliteWasmRuntime | undefined;

  const getRuntime = (): SqliteWasmRuntime => {
    if (!runtime) {
      runtime = new SqliteWasmRuntime(deps);
    }
    return runtime;
  };

  interface InternalStatementHandle {
    finalizeFromDbClose(): void;
  }

  interface StatementDefaults {
    readBigInts: boolean;
    returnArrays: boolean;
    allowBareNamed: boolean;
    allowUnknownNamed: boolean;
  }

  interface InternalDbContext {
    readonly rt: SqliteWasmRuntime;
    readonly dbPtr: number;
    readonly dqsEnabled: boolean;
    readonly stmtDefaults: StatementDefaults;
    consumePendingError(): unknown;
    throwDbError(rc: number): never;
    registerStatement(stmt: InternalStatementHandle): void;
    clearAggregates(): void;
    queryPragmaRows(sql: string): Array<Record<string, unknown>>;
  }

  interface StatementState {
    dbCtx: InternalDbContext | null;
    stmtPtr: number;
    sourceSQL: string;
    parsedParams: ParsedSqlParameters;
    boundLiterals: Array<string | null>;
    allowBareNamed: boolean;
    allowUnknownNamed: boolean;
    readBigInts: boolean;
    returnArrays: boolean;
    stepping: boolean;
  }

  const stmtStates = new WeakMap<object, StatementState>();

  function getStmtState(self: unknown): StatementState {
    if (typeof self !== 'object' || self === null) {
      throw sqliteTypeError('ERR_INVALID_THIS', 'Value of "this" must be of type StatementSync');
    }
    const st = stmtStates.get(self);
    if (!st) {
      throw sqliteTypeError('ERR_INVALID_THIS', 'Value of "this" must be of type StatementSync');
    }
    if (!st.dbCtx || st.stmtPtr === 0) {
      throw sqliteStateError('statement has been finalized');
    }
    return st;
  }

  function resetStmt(st: StatementState): void {
    if (!st.dbCtx || st.stmtPtr === 0) return;
    if (st.stepping) {
      st.stepping = false;
      st.dbCtx.clearAggregates();
    }
    st.dbCtx.rt.wasm.sqlite3_reset(st.stmtPtr);
  }

  function bindParameters(st: StatementState, args: unknown[]): void {
    const dbCtx = st.dbCtx!;
    const { rt } = dbCtx;
    resetStmt(st);
    rt.wasm.sqlite3_clear_bindings(st.stmtPtr);
    st.boundLiterals = new Array<string | null>(st.parsedParams.maxIndex + 1).fill(null);

    const bindAtIndex = (paramIdx: number, value: unknown): void => {
      let rc: number;
      if (value === null) {
        if (paramIdx <= st.parsedParams.maxIndex) st.boundLiterals[paramIdx] = 'NULL';
        rc = rt.wasm.sqlite3_bind_null(st.stmtPtr, paramIdx);
      } else if (typeof value === 'number') {
        if (paramIdx <= st.parsedParams.maxIndex)
          st.boundLiterals[paramIdx] = formatSqlLiteral(value);
        rc = Number.isNaN(value)
          ? rt.wasm.sqlite3_bind_null(st.stmtPtr, paramIdx)
          : rt.wasm.sqlite3_bind_double(st.stmtPtr, paramIdx, value);
      } else if (typeof value === 'bigint') {
        if (value < INT64_MIN || value > INT64_MAX) {
          throw sqliteTypeError('ERR_INVALID_ARG_VALUE', 'BigInt value is too large to bind.');
        }
        if (paramIdx <= st.parsedParams.maxIndex)
          st.boundLiterals[paramIdx] = formatSqlLiteral(value);
        rc = rt.wasm.sqlite3_bind_int64(st.stmtPtr, paramIdx, value);
      } else if (typeof value === 'string') {
        if (paramIdx <= st.parsedParams.maxIndex)
          st.boundLiterals[paramIdx] = formatSqlLiteral(value);
        const { ptr, byteLength } = rt.allocCString(value);
        try {
          rc = rt.wasm.sqlite3_bind_text(st.stmtPtr, paramIdx, ptr, byteLength, SQLITE_TRANSIENT);
        } finally {
          rt.wasm.free(ptr);
        }
      } else if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (paramIdx <= st.parsedParams.maxIndex)
          st.boundLiterals[paramIdx] = formatSqlLiteral(bytes);
        const ptr = rt.allocBytes(bytes);
        try {
          rc =
            bytes.byteLength <= INT32_MAX
              ? rt.wasm.sqlite3_bind_blob(
                  st.stmtPtr,
                  paramIdx,
                  ptr,
                  bytes.byteLength,
                  SQLITE_TRANSIENT,
                )
              : rt.wasm.sqlite3_bind_blob64(
                  st.stmtPtr,
                  paramIdx,
                  ptr,
                  BigInt(bytes.byteLength),
                  SQLITE_TRANSIENT,
                );
        } finally {
          rt.wasm.free(ptr);
        }
      } else {
        throw sqliteTypeError(
          'ERR_INVALID_ARG_TYPE',
          `Provided value cannot be bound to SQLite parameter ${paramIdx}.`,
        );
      }
      if (rc !== SQLITE_OK) {
        dbCtx.throwDbError(rc);
      }
    };

    let anonStart = 0;
    if (
      args.length > 0 &&
      typeof args[0] === 'object' &&
      args[0] !== null &&
      !ArrayBuffer.isView(args[0])
    ) {
      anonStart = 1;
      let bareToIndex: Map<string, number> | null = null;
      if (st.allowBareNamed) {
        bareToIndex = new Map<string, number>();
        const bareFirstFull = new Map<string, string>();
        for (let p = 1; p <= st.parsedParams.maxIndex; p += 1) {
          const fullName = st.parsedParams.paramNames[p];
          if (!fullName || fullName.startsWith('?')) continue;
          const bare = fullName.slice(1);
          const existingFull = bareFirstFull.get(bare);
          if (existingFull !== undefined && existingFull !== fullName) {
            throw sqliteStateError(
              `Cannot create bare named parameter '${bare}' because of conflicting names '${existingFull}' and '${fullName}'.`,
            );
          }
          bareFirstFull.set(bare, fullName);
          bareToIndex.set(bare, p);
        }
      }
      for (const [key, val] of Object.entries(args[0])) {
        let idx = st.parsedParams.namedToIndex.get(key);
        if (idx === undefined && bareToIndex !== null) {
          idx = bareToIndex.get(key);
        }
        if (idx === undefined) {
          if (st.allowUnknownNamed) continue;
          throw sqliteStateError(`Unknown named parameter '${key}'`);
        }
        bindAtIndex(idx, val);
      }
    }

    let anonIdx = 1;
    for (let i = anonStart; i < args.length; i += 1) {
      while (anonIdx <= st.parsedParams.maxIndex && st.parsedParams.paramNames[anonIdx] !== null) {
        anonIdx += 1;
      }
      bindAtIndex(anonIdx, args[i]);
      anonIdx += 1;
    }
  }

  function readColumnValue(st: StatementState, col: number): unknown {
    const { rt } = st.dbCtx!;
    const colType = rt.wasm.sqlite3_column_type(st.stmtPtr, col);
    switch (colType) {
      case SQLITE_NULL:
        return null;
      case SQLITE_INTEGER:
        return narrowSafeSqlInt(rt.wasm.sqlite3_column_int64(st.stmtPtr, col), st.readBigInts);
      case SQLITE_FLOAT:
        return rt.wasm.sqlite3_column_double(st.stmtPtr, col);
      case SQLITE_TEXT: {
        const ptr = rt.wasm.sqlite3_column_text(st.stmtPtr, col);
        const byteLen = rt.wasm.sqlite3_column_bytes(st.stmtPtr, col);
        if (!ptr || byteLen <= 0) return '';
        return utf8Decoder.decode(rt.u8().subarray(ptr >>> 0, (ptr >>> 0) + byteLen));
      }
      case SQLITE_BLOB: {
        const ptr = rt.wasm.sqlite3_column_blob(st.stmtPtr, col);
        const byteLen = rt.wasm.sqlite3_column_bytes(st.stmtPtr, col);
        if (!ptr || byteLen <= 0) return new Uint8Array(0);
        return rt.u8().slice(ptr >>> 0, (ptr >>> 0) + byteLen);
      }
      default:
        return null;
    }
  }

  function readCurrentRow(st: StatementState, colNames: string[]): unknown {
    if (st.returnArrays) {
      const arr = new Array<unknown>(colNames.length);
      for (let i = 0; i < colNames.length; i += 1) {
        arr[i] = readColumnValue(st, i);
      }
      return arr;
    }
    const row: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < colNames.length; i += 1) {
      row[colNames[i]!] = readColumnValue(st, i);
    }
    return row;
  }

  function stepChecked(st: StatementState): number {
    const dbCtx = st.dbCtx!;
    st.stepping = true;
    const rc = dbCtx.rt.wasm.sqlite3_step(st.stmtPtr);
    const pending = dbCtx.consumePendingError();
    if (pending !== NO_PENDING_ERROR) {
      st.stepping = false;
      dbCtx.clearAggregates();
      dbCtx.rt.wasm.sqlite3_reset(st.stmtPtr);
      throw pending;
    }
    if (rc !== SQLITE_ROW && rc !== SQLITE_DONE) {
      st.stepping = false;
      dbCtx.clearAggregates();
      dbCtx.rt.wasm.sqlite3_reset(st.stmtPtr);
      dbCtx.throwDbError(rc);
    }
    if (rc === SQLITE_DONE) {
      st.stepping = false;
    }
    return rc;
  }

  function StatementSync(
    this: object,
    token?: symbol,
    dbCtx?: InternalDbContext | null,
    stmtPtr?: number,
    sourceSQL?: string,
  ): void {
    if (token !== kInternalStatementConstruct) {
      throw sqliteIllegalConstructor();
    }
    const sqlText = sourceSQL ?? '';
    const parsedParams = parseSqlParameters(sqlText);
    const defaults = dbCtx?.stmtDefaults;
    const state: StatementState = {
      dbCtx: stmtPtr ? (dbCtx ?? null) : null,
      stmtPtr: stmtPtr ?? 0,
      sourceSQL: sqlText,
      parsedParams,
      boundLiterals: new Array<string | null>(parsedParams.maxIndex + 1).fill(null),
      allowBareNamed: defaults?.allowBareNamed ?? true,
      allowUnknownNamed: defaults?.allowUnknownNamed ?? false,
      readBigInts: defaults?.readBigInts ?? false,
      returnArrays: defaults?.returnArrays ?? false,
      stepping: false,
    };
    stmtStates.set(this, state);

    if (state.dbCtx && state.stmtPtr !== 0) {
      const handle: InternalStatementHandle = {
        finalizeFromDbClose: () => {
          if (state.dbCtx && state.stmtPtr !== 0) {
            if (state.stepping) {
              state.stepping = false;
              state.dbCtx.clearAggregates();
            }
            state.dbCtx.rt.wasm.sqlite3_finalize(state.stmtPtr);
            state.stmtPtr = 0;
            state.dbCtx = null;
          }
        },
      };
      state.dbCtx.registerStatement(handle);
    }

    Object.defineProperties(this, {
      sourceSQL: {
        enumerable: true,
        configurable: true,
        get: () => getStmtState(this).sourceSQL,
      },
      expandedSQL: {
        enumerable: true,
        configurable: true,
        get: () => {
          const st = getStmtState(this);
          const { occurrences } = st.parsedParams;
          if (occurrences.length === 0) return st.sourceSQL;
          let out = '';
          let cursor = 0;
          for (const occ of occurrences) {
            out += st.sourceSQL.slice(cursor, occ.start);
            out += st.boundLiterals[occ.index] ?? 'NULL';
            cursor = occ.end;
          }
          out += st.sourceSQL.slice(cursor);
          return out;
        },
      },
    });
  }

  Object.defineProperties(StatementSync.prototype, {
    run: {
      value: function run(this: unknown, ...anonymousParameters: unknown[]) {
        const st = getStmtState(this);
        const dbCtx = st.dbCtx!;
        bindParameters(st, anonymousParameters);
        try {
          stepChecked(st);
        } finally {
          resetStmt(st);
        }
        const rawRowid = dbCtx.rt.wasm.sqlite3_last_insert_rowid(dbCtx.dbPtr);
        const rawChanges = dbCtx.rt.wasm.sqlite3_changes(dbCtx.dbPtr);
        if (st.readBigInts) {
          return {
            lastInsertRowid: rawRowid,
            changes: BigInt(rawChanges),
          };
        }
        return {
          lastInsertRowid: Number(rawRowid),
          changes: rawChanges,
        };
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    get: {
      value: function get(this: unknown, ...anonymousParameters: unknown[]) {
        const st = getStmtState(this);
        const { rt } = st.dbCtx!;
        bindParameters(st, anonymousParameters);
        try {
          const rc = stepChecked(st);
          if (rc !== SQLITE_ROW) return undefined;
          const count = rt.wasm.sqlite3_column_count(st.stmtPtr);
          const colNames = new Array<string>(count);
          for (let i = 0; i < count; i += 1) {
            colNames[i] = rt.readCString(rt.wasm.sqlite3_column_name(st.stmtPtr, i));
          }
          return readCurrentRow(st, colNames);
        } finally {
          resetStmt(st);
        }
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    all: {
      value: function all(this: unknown, ...anonymousParameters: unknown[]) {
        const st = getStmtState(this);
        const { rt } = st.dbCtx!;
        bindParameters(st, anonymousParameters);
        const count = rt.wasm.sqlite3_column_count(st.stmtPtr);
        const colNames = new Array<string>(count);
        for (let i = 0; i < count; i += 1) {
          colNames[i] = rt.readCString(rt.wasm.sqlite3_column_name(st.stmtPtr, i));
        }
        const rows: unknown[] = [];
        try {
          while (stepChecked(st) === SQLITE_ROW) {
            rows.push(readCurrentRow(st, colNames));
          }
          return rows;
        } finally {
          resetStmt(st);
        }
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    iterate: {
      value: function iterate(this: unknown, ...anonymousParameters: unknown[]) {
        const st = getStmtState(this);
        const { rt } = st.dbCtx!;
        bindParameters(st, anonymousParameters);
        const count = rt.wasm.sqlite3_column_count(st.stmtPtr);
        const colNames = new Array<string>(count);
        for (let i = 0; i < count; i += 1) {
          colNames[i] = rt.readCString(rt.wasm.sqlite3_column_name(st.stmtPtr, i));
        }
        const iter: object = Object.create(statementIteratorProto);
        const iterState: StatementIteratorState = {
          done: false,
          finish: () => {
            resetStmt(st);
          },
          nextRow: () => {
            if (!st.dbCtx || st.stmtPtr === 0) {
              iterState.done = true;
              throw sqliteStateError('statement has been finalized');
            }
            try {
              const rc = stepChecked(st);
              if (rc === SQLITE_ROW) {
                return { value: readCurrentRow(st, colNames), done: false };
              }
              iterState.done = true;
              resetStmt(st);
              return { value: undefined, done: true };
            } catch (err) {
              iterState.done = true;
              resetStmt(st);
              throw err;
            }
          },
        };
        iteratorStates.set(iter, iterState);
        return iter;
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    columns: {
      value: function columns(this: unknown) {
        const st = getStmtState(this);
        const dbCtx = st.dbCtx!;
        const { rt } = dbCtx;
        const count = rt.wasm.sqlite3_column_count(st.stmtPtr);
        const dbSchemas = dbCtx
          .queryPragmaRows('PRAGMA database_list')
          .map((r) => (typeof r.name === 'string' ? r.name : 'main'));

        const tableMetaCache = new Map<string, TableMetaEntry | null>();

        const lookupTable = (tblName: string): TableMetaEntry | null => {
          const cached = tableMetaCache.get(tblName);
          if (cached !== undefined) return cached;
          const escapedTbl = tblName.replaceAll('"', '""');
          for (const schema of dbSchemas) {
            const escapedSchema = schema.replaceAll('"', '""');
            const infoRows = dbCtx.queryPragmaRows(
              `PRAGMA "${escapedSchema}".table_info("${escapedTbl}")`,
            );
            if (infoRows.length > 0) {
              const byLower = new Map<string, TableColumnInfo>();
              const ordered: TableColumnInfo[] = [];
              for (const r of infoRows) {
                const colNameStr = typeof r.name === 'string' ? r.name : '';
                const rawType = typeof r.type === 'string' ? r.type : '';
                const info: TableColumnInfo = {
                  realName: colNameStr,
                  declType: rawType.length > 0 ? rawType : null,
                };
                byLower.set(colNameStr.toLowerCase(), info);
                ordered.push(info);
              }
              const entry: TableMetaEntry = { schema, byLower, ordered };
              tableMetaCache.set(tblName, entry);
              return entry;
            }
          }
          tableMetaCache.set(tblName, null);
          return null;
        };

        const expandedProj = resolveOriginColumnsForQuery(st.sourceSQL, lookupTable);

        const out = new Array<Record<string, string | null>>(count);
        for (let i = 0; i < count; i += 1) {
          const name = rt.readCString(rt.wasm.sqlite3_column_name(st.stmtPtr, i));
          const tblPtr = rt.wasm.sqlite3_column_table_name(st.stmtPtr, i);
          const tblName = tblPtr ? rt.readCString(tblPtr) : '';
          const meta: Record<string, string | null> = Object.create(null);
          if (!tblName) {
            meta.column = null;
            meta.database = null;
            meta.name = name;
            meta.table = null;
            meta.type = null;
          } else {
            const tblInfo = lookupTable(tblName);
            const candidate = expandedProj?.[i]?.originCol ?? name;
            const colInfo =
              tblInfo?.byLower.get(candidate.toLowerCase()) ??
              tblInfo?.byLower.get(name.toLowerCase()) ??
              null;
            meta.column = colInfo ? colInfo.realName : candidate;
            meta.database = tblInfo ? tblInfo.schema : 'main';
            meta.name = name;
            meta.table = tblName;
            meta.type = colInfo ? colInfo.declType : null;
          }
          out[i] = meta;
        }
        return out;
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    setAllowBareNamedParameters: {
      value: function setAllowBareNamedParameters(this: unknown, enabled: unknown): void {
        const st = getStmtState(this);
        st.allowBareNamed = validateBoolArg(enabled, 'allowBareNamedParameters');
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    setAllowUnknownNamedParameters: {
      value: function setAllowUnknownNamedParameters(this: unknown, enabled: unknown): void {
        const st = getStmtState(this);
        st.allowUnknownNamed = validateBoolArg(enabled, 'allowUnknownNamedParameters');
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    setReadBigInts: {
      value: function setReadBigInts(this: unknown, enabled: unknown): void {
        const st = getStmtState(this);
        st.readBigInts = validateBoolArg(enabled, 'readBigInts');
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    setReturnArrays: {
      value: function setReturnArrays(this: unknown, enabled: unknown): void {
        const st = getStmtState(this);
        st.returnArrays = validateBoolArg(enabled, 'returnArrays');
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });

  interface RegisteredUdfEntry {
    slots: number[];
    accumulators?: Map<number, unknown>;
  }

  interface DatabaseState {
    locationPath: string;
    config: DatabaseConfigOptions;
    dbPtr: number;
    pendingError: unknown;
    statements: Set<InternalStatementHandle>;
    functionsByKey: Map<string, RegisteredUdfEntry>;
    aggregateMaps: Set<Map<number, unknown>>;
    ctx: InternalDbContext | null;
  }

  const dbStates = new WeakMap<object, DatabaseState>();

  function getDbState(self: unknown): DatabaseState {
    if (typeof self !== 'object' || self === null) {
      throw sqliteTypeError('ERR_INVALID_THIS', 'Value of "this" must be of type DatabaseSync');
    }
    const st = dbStates.get(self);
    if (!st) {
      throw sqliteTypeError('ERR_INVALID_THIS', 'Value of "this" must be of type DatabaseSync');
    }
    return st;
  }

  function requireOpenDb(self: unknown): DatabaseState {
    const st = getDbState(self);
    if (st.dbPtr === 0 || !st.ctx) {
      throw sqliteStateError('database is not open');
    }
    return st;
  }

  function prepareSingleStatementWithDqs(
    dbCtx: InternalDbContext,
    rawSql: string,
  ): { stmtPtr: number; sourceSQL: string } {
    const { rt, dbPtr, dqsEnabled } = dbCtx;

    const tryPrepareOnce = (
      candidateSql: string,
    ): {
      rc: number;
      stmtPtr: number;
      consumedBytes: number;
      byteLength: number;
      sqlPtr: number;
    } => {
      const { ptr: sqlPtr, byteLength } = rt.allocCString(candidateSql);
      const stmtOut = rt.wasm.malloc(4);
      const tailOut = rt.wasm.malloc(4);
      if (!stmtOut || !tailOut) {
        if (stmtOut) rt.wasm.free(stmtOut);
        if (tailOut) rt.wasm.free(tailOut);
        rt.wasm.free(sqlPtr);
        throw fault('EIO', 'SQLite WebAssembly malloc failed', { kind: 'channel' });
      }
      try {
        const rc = rt.wasm.sqlite3_prepare_v2(dbPtr, sqlPtr, byteLength, stmtOut, tailOut);
        const stmtPtr = rt.u32()[stmtOut >>> 2]!;
        if (rc !== SQLITE_OK) {
          if (stmtPtr) rt.wasm.sqlite3_finalize(stmtPtr);
          rt.wasm.free(sqlPtr);
          return { rc, stmtPtr: 0, consumedBytes: 0, byteLength: 0, sqlPtr: 0 };
        }
        const tailPtr = rt.u32()[tailOut >>> 2]!;
        const consumedBytes =
          stmtPtr !== 0 ? Math.max(0, Math.min(byteLength, (tailPtr >>> 0) - (sqlPtr >>> 0))) : 0;
        return { rc, stmtPtr, consumedBytes, byteLength, sqlPtr };
      } finally {
        rt.wasm.free(tailOut);
        rt.wasm.free(stmtOut);
      }
    };

    const firstAttempt = tryPrepareOnce(rawSql);
    if (firstAttempt.rc === SQLITE_OK) {
      try {
        const sourceSQL =
          firstAttempt.stmtPtr !== 0
            ? utf8Decoder.decode(
                rt
                  .u8()
                  .subarray(
                    firstAttempt.sqlPtr >>> 0,
                    (firstAttempt.sqlPtr >>> 0) + firstAttempt.consumedBytes,
                  ),
              )
            : '';
        return { stmtPtr: firstAttempt.stmtPtr, sourceSQL };
      } finally {
        if (firstAttempt.sqlPtr) rt.wasm.free(firstAttempt.sqlPtr);
      }
    }

    if (!dqsEnabled) {
      dbCtx.throwDbError(firstAttempt.rc);
    }

    const parts = splitSqlStatements(rawSql);
    const originalFirstStmt = parts[0] ?? rawSql;
    let currentSql = originalFirstStmt;
    let lastRc = firstAttempt.rc;

    for (let iter = 0; iter < 64; iter += 1) {
      const errmsg = rt.readCString(rt.wasm.sqlite3_errmsg(dbPtr));
      const m = DQS_MISSING_COLUMN_RE.exec(errmsg);
      if (!m) {
        dbCtx.throwDbError(lastRc);
      }
      const rewritten = rewriteOneDqsIdentifier(currentSql, m[1]!);
      if (rewritten === null || rewritten === currentSql) {
        dbCtx.throwDbError(lastRc);
      }
      currentSql = rewritten;
      const attempt = tryPrepareOnce(currentSql);
      if (attempt.rc === SQLITE_OK) {
        if (attempt.sqlPtr) rt.wasm.free(attempt.sqlPtr);
        return {
          stmtPtr: attempt.stmtPtr,
          sourceSQL: attempt.stmtPtr !== 0 ? originalFirstStmt : '',
        };
      }
      lastRc = attempt.rc;
    }

    dbCtx.throwDbError(lastRc);
  }

  function registerDbFunctionSlots(
    st: DatabaseState,
    name: string,
    nArg: number,
    eTextRep: number,
    scalarSlot: number,
    stepSlot: number,
    finalSlot: number,
    accumulators?: Map<number, unknown>,
  ): void {
    const dbCtx = st.ctx!;
    const { rt } = dbCtx;
    const newSlots = scalarSlot !== 0 ? [scalarSlot] : [stepSlot, finalSlot];
    let namePtr = 0;
    try {
      namePtr = rt.allocCString(name).ptr;
      const rc = rt.wasm.sqlite3_create_function_v2(
        st.dbPtr,
        namePtr,
        nArg,
        eTextRep,
        0,
        scalarSlot,
        stepSlot,
        finalSlot,
        0,
      );
      if (rc !== SQLITE_OK) {
        dbCtx.throwDbError(rc);
      }
    } catch (err) {
      for (const s of newSlots) rt.removeFunction(s);
      throw err;
    } finally {
      if (namePtr) rt.wasm.free(namePtr);
    }

    const key = `${name.toLowerCase()}:${nArg}`;
    const prev = st.functionsByKey.get(key);
    if (prev) {
      for (const s of prev.slots) rt.removeFunction(s);
      if (prev.accumulators) {
        prev.accumulators.clear();
        st.aggregateMaps.delete(prev.accumulators);
      }
    }
    if (accumulators) {
      st.aggregateMaps.add(accumulators);
    }
    st.functionsByKey.set(key, { slots: newSlots, accumulators });
  }

  function openDatabaseState(st: DatabaseState): void {
    if (st.dbPtr !== 0) {
      throw sqliteStateError('database is already open');
    }
    const rt = getRuntime();
    let flags = SQLITE_OPEN_URI;
    if (st.config.readOnly) {
      flags |= SQLITE_OPEN_READONLY;
    } else {
      flags |= SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
    }
    const { ptr: namePtr } = rt.allocCString(st.locationPath);
    const dbOutPtr = rt.wasm.malloc(4);
    if (!dbOutPtr) {
      rt.wasm.free(namePtr);
      throw fault('EIO', 'SQLite WebAssembly malloc failed', { kind: 'channel' });
    }
    let dbPtr = 0;
    try {
      const rc = rt.wasm.sqlite3_open_v2(namePtr, dbOutPtr, flags, 0);
      dbPtr = rt.u32()[dbOutPtr >>> 2]!;
      if (rc !== SQLITE_OK) {
        const msg = dbPtr
          ? rt.readCString(rt.wasm.sqlite3_errmsg(dbPtr))
          : 'unable to open database file';
        if (dbPtr) rt.wasm.sqlite3_close_v2(dbPtr);
        throw sqliteErrorFromCode(rc, msg);
      }
    } finally {
      rt.wasm.free(namePtr);
      rt.wasm.free(dbOutPtr);
    }

    st.dbPtr = dbPtr;
    st.pendingError = NO_PENDING_ERROR;

    const execInternal = (pragmaSql: string): void => {
      const { ptr } = rt.allocCString(pragmaSql);
      try {
        rt.wasm.sqlite3_exec(dbPtr, ptr, 0, 0, 0);
      } finally {
        rt.wasm.free(ptr);
      }
    };

    if (st.config.timeout > 0) {
      execInternal(`PRAGMA busy_timeout = ${st.config.timeout};`);
    }
    execInternal(`PRAGMA foreign_keys = ${st.config.enableForeignKeyConstraints ? 'ON' : 'OFF'};`);

    st.ctx = {
      rt,
      dbPtr,
      dqsEnabled: st.config.enableDoubleQuotedStringLiterals,
      stmtDefaults: {
        readBigInts: st.config.readBigInts,
        returnArrays: st.config.returnArrays,
        allowBareNamed: st.config.allowBareNamedParameters,
        allowUnknownNamed: st.config.allowUnknownNamedParameters,
      },
      consumePendingError: () => {
        const err = st.pendingError;
        st.pendingError = NO_PENDING_ERROR;
        return err;
      },
      throwDbError: (rc: number): never => {
        const msg = rt.readCString(rt.wasm.sqlite3_errmsg(dbPtr));
        throw sqliteErrorFromCode(rc, msg || 'SQL logic error');
      },
      registerStatement: (stmt) => {
        st.statements.add(stmt);
      },
      clearAggregates: () => {
        for (const map of st.aggregateMaps) {
          map.clear();
        }
      },
      queryPragmaRows: (pragmaSql: string): Array<Record<string, unknown>> => {
        const { ptr: sqlPtr, byteLength } = rt.allocCString(pragmaSql);
        const stmtOut = rt.wasm.malloc(4);
        if (!stmtOut) {
          rt.wasm.free(sqlPtr);
          return [];
        }
        let sPtr = 0;
        try {
          const rc = rt.wasm.sqlite3_prepare_v2(dbPtr, sqlPtr, byteLength, stmtOut, 0);
          sPtr = rt.u32()[stmtOut >>> 2]!;
          if (rc !== SQLITE_OK || !sPtr) return [];
          const colCount = rt.wasm.sqlite3_column_count(sPtr);
          const names = new Array<string>(colCount);
          for (let i = 0; i < colCount; i += 1) {
            names[i] = rt.readCString(rt.wasm.sqlite3_column_name(sPtr, i));
          }
          const rows: Array<Record<string, unknown>> = [];
          while (rt.wasm.sqlite3_step(sPtr) === SQLITE_ROW) {
            const row: Record<string, unknown> = {};
            for (let i = 0; i < colCount; i += 1) {
              const t = rt.wasm.sqlite3_column_type(sPtr, i);
              if (t === SQLITE_INTEGER) {
                row[names[i]!] = Number(rt.wasm.sqlite3_column_int64(sPtr, i));
              } else if (t === SQLITE_TEXT) {
                const p = rt.wasm.sqlite3_column_text(sPtr, i);
                const len = rt.wasm.sqlite3_column_bytes(sPtr, i);
                row[names[i]!] =
                  p && len > 0
                    ? utf8Decoder.decode(rt.u8().subarray(p >>> 0, (p >>> 0) + len))
                    : '';
              } else {
                row[names[i]!] = null;
              }
            }
            rows.push(row);
          }
          return rows;
        } finally {
          if (sPtr) rt.wasm.sqlite3_finalize(sPtr);
          rt.wasm.free(stmtOut);
          rt.wasm.free(sqlPtr);
        }
      },
    };
  }

  function decodeUdfArguments(
    rt: SqliteWasmRuntime,
    argc: number,
    argv: number,
    useBigIntArguments: boolean,
  ): unknown[] {
    const args = new Array<unknown>(argc);
    for (let i = 0; i < argc; i += 1) {
      const valPtr = rt.u32()[(argv >>> 2) + i]!;
      const t = rt.wasm.sqlite3_value_type(valPtr);
      switch (t) {
        case SQLITE_NULL:
          args[i] = null;
          break;
        case SQLITE_INTEGER:
          args[i] = narrowSafeSqlInt(rt.wasm.sqlite3_value_int64(valPtr), useBigIntArguments);
          break;
        case SQLITE_FLOAT:
          args[i] = rt.wasm.sqlite3_value_double(valPtr);
          break;
        case SQLITE_TEXT: {
          const p = rt.wasm.sqlite3_value_text(valPtr);
          const len = rt.wasm.sqlite3_value_bytes(valPtr);
          args[i] =
            p && len > 0 ? utf8Decoder.decode(rt.u8().subarray(p >>> 0, (p >>> 0) + len)) : '';
          break;
        }
        case SQLITE_BLOB: {
          const p = rt.wasm.sqlite3_value_blob(valPtr);
          const len = rt.wasm.sqlite3_value_bytes(valPtr);
          args[i] = p && len > 0 ? rt.u8().slice(p >>> 0, (p >>> 0) + len) : new Uint8Array(0);
          break;
        }
        default:
          args[i] = null;
      }
    }
    return args;
  }

  function writeUdfResult(rt: SqliteWasmRuntime, cx: number, result: unknown): void {
    if (result === null || result === undefined) {
      rt.wasm.sqlite3_result_null(cx);
      return;
    }
    if (typeof result === 'number') {
      rt.wasm.sqlite3_result_double(cx, result);
      return;
    }
    if (typeof result === 'bigint') {
      if (result < INT64_MIN || result > INT64_MAX) {
        throw sqliteTypeError('ERR_INVALID_ARG_VALUE', 'BigInt value is too large to bind.');
      }
      rt.wasm.sqlite3_result_int64(cx, result);
      return;
    }
    if (typeof result === 'string') {
      const { ptr, byteLength } = rt.allocCString(result);
      try {
        rt.wasm.sqlite3_result_text(cx, ptr, byteLength, SQLITE_TRANSIENT);
      } finally {
        rt.wasm.free(ptr);
      }
      return;
    }
    if (ArrayBuffer.isView(result)) {
      const bytes = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
      const ptr = rt.allocBytes(bytes);
      try {
        if (bytes.byteLength <= INT32_MAX) {
          rt.wasm.sqlite3_result_blob(cx, ptr, bytes.byteLength, SQLITE_TRANSIENT);
        } else {
          rt.wasm.sqlite3_result_blob64(cx, ptr, BigInt(bytes.byteLength), SQLITE_TRANSIENT);
        }
      } finally {
        rt.wasm.free(ptr);
      }
      return;
    }
    if (isThenable(result)) {
      throw sqliteErrorFromCode(
        SQLITE_ERROR,
        'Asynchronous user-defined functions are not supported',
      );
    }
    throw sqliteErrorFromCode(
      SQLITE_ERROR,
      'Returned JavaScript value cannot be converted to a SQLite value',
    );
  }

  function signalCError(rt: SqliteWasmRuntime, cx: number, message: string): void {
    const { ptr, byteLength } = rt.allocCString(message);
    try {
      rt.wasm.sqlite3_result_error(cx, ptr, byteLength);
    } finally {
      rt.wasm.free(ptr);
    }
  }

  function DatabaseSync(this: object, location?: unknown, options?: unknown): void {
    if (!new.target) {
      throw sqliteConstructCallRequired();
    }
    const locationPath = validateDbPath(location);
    const config = parseDatabaseOptions(options);
    const state: DatabaseState = {
      locationPath,
      config,
      dbPtr: 0,
      pendingError: NO_PENDING_ERROR,
      statements: new Set(),
      functionsByKey: new Map(),
      aggregateMaps: new Set(),
      ctx: null,
    };
    dbStates.set(this, state);

    Object.defineProperties(this, {
      isOpen: {
        enumerable: true,
        configurable: true,
        get: () => getDbState(this).dbPtr !== 0,
      },
      isTransaction: {
        enumerable: true,
        configurable: true,
        get: () => {
          const st = requireOpenDb(this);
          return st.ctx!.rt.wasm.sqlite3_get_autocommit(st.dbPtr) === 0;
        },
      },
    });

    if (config.open) {
      openDatabaseState(state);
    }
  }

  function disposeDatabase(this: unknown): void {
    const st = getDbState(this);
    if (st.dbPtr !== 0) {
      try {
        Reflect.apply(DatabaseSync.prototype.close, this, []);
      } catch {
        // Node's DatabaseSync[Symbol.dispose] ignores close errors during disposal.
      }
    }
  }

  const nodejsDisposeSymbol = Symbol.for('nodejs.dispose');

  Object.defineProperties(DatabaseSync.prototype, {
    open: {
      value: function open(this: unknown): void {
        const st = getDbState(this);
        openDatabaseState(st);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    close: {
      value: function close(this: unknown): void {
        const st = requireOpenDb(this);
        const dbCtx = st.ctx!;
        const { rt } = dbCtx;
        for (const stmt of st.statements) {
          stmt.finalizeFromDbClose();
        }
        st.statements.clear();
        dbCtx.clearAggregates();
        st.aggregateMaps.clear();
        for (const entry of st.functionsByKey.values()) {
          for (const slot of entry.slots) {
            rt.removeFunction(slot);
          }
        }
        st.functionsByKey.clear();
        const rc = rt.wasm.sqlite3_close_v2(st.dbPtr);
        if (rc !== SQLITE_OK) {
          dbCtx.throwDbError(rc);
        }
        st.dbPtr = 0;
        st.ctx = null;
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    exec: {
      value: function exec(this: unknown, sql: unknown): void {
        const st = requireOpenDb(this);
        if (typeof sql !== 'string') {
          throw sqliteTypeError('ERR_INVALID_ARG_TYPE', 'The "sql" argument must be a string.');
        }
        const dbCtx = st.ctx!;
        const { rt } = dbCtx;
        if (!dbCtx.dqsEnabled) {
          const { ptr } = rt.allocCString(sql);
          try {
            const rc = rt.wasm.sqlite3_exec(st.dbPtr, ptr, 0, 0, 0);
            const pending = dbCtx.consumePendingError();
            if (pending !== NO_PENDING_ERROR) {
              dbCtx.clearAggregates();
              throw pending;
            }
            if (rc !== SQLITE_OK) {
              dbCtx.clearAggregates();
              dbCtx.throwDbError(rc);
            }
          } finally {
            rt.wasm.free(ptr);
          }
          return;
        }

        for (const stmtSql of splitSqlStatements(sql)) {
          if (stmtSql.trim().length === 0) continue;
          const { stmtPtr } = prepareSingleStatementWithDqs(dbCtx, stmtSql);
          if (stmtPtr === 0) continue;
          try {
            while (true) {
              const rc = rt.wasm.sqlite3_step(stmtPtr);
              const pending = dbCtx.consumePendingError();
              if (pending !== NO_PENDING_ERROR) {
                dbCtx.clearAggregates();
                throw pending;
              }
              if (rc === SQLITE_ROW) continue;
              if (rc === SQLITE_DONE) break;
              dbCtx.clearAggregates();
              dbCtx.throwDbError(rc);
            }
          } finally {
            rt.wasm.sqlite3_finalize(stmtPtr);
          }
        }
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    prepare: {
      value: function prepare(this: unknown, sql: unknown) {
        const st = requireOpenDb(this);
        if (typeof sql !== 'string') {
          throw sqliteTypeError('ERR_INVALID_ARG_TYPE', 'The "sql" argument must be a string.');
        }
        const dbCtx = st.ctx!;
        const { stmtPtr, sourceSQL } = prepareSingleStatementWithDqs(dbCtx, sql);
        // Invariant: `StatementSync` is invoked as a constructor with the internal token.
        return Reflect.construct(StatementSync, [
          kInternalStatementConstruct,
          dbCtx,
          stmtPtr,
          sourceSQL,
        ]);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    location: {
      value: function location(this: unknown, dbName?: unknown): string | null {
        const st = requireOpenDb(this);
        const target = dbName === undefined ? 'main' : dbName;
        if (typeof target !== 'string') {
          throw sqliteTypeError('ERR_INVALID_ARG_TYPE', 'The "dbName" argument must be a string.');
        }
        const rows = st.ctx!.queryPragmaRows('PRAGMA database_list');
        for (const r of rows) {
          if (r.name === target) {
            return typeof r.file === 'string' && r.file.length > 0 ? r.file : null;
          }
        }
        return null;
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    function: {
      value: function registerFunction(
        this: unknown,
        name: unknown,
        optionsOrFn: unknown,
        maybeFn?: unknown,
      ): void {
        const st = requireOpenDb(this);
        if (typeof name !== 'string') {
          throw sqliteTypeError('ERR_INVALID_ARG_TYPE', 'The "name" argument must be a string.');
        }
        let fn: unknown = optionsOrFn;
        let rawOpts: unknown;
        if (maybeFn !== undefined) {
          rawOpts = optionsOrFn;
          fn = maybeFn;
        }
        let deterministic = false;
        let directOnly = false;
        let useBigIntArguments = false;
        let varargs = false;
        if (rawOpts !== undefined) {
          const rec = toOptionRecord(rawOpts);
          deterministic = validateBooleanOption(rec, 'deterministic', false);
          directOnly = validateBooleanOption(rec, 'directOnly', false);
          useBigIntArguments = validateBooleanOption(rec, 'useBigIntArguments', false);
          varargs = validateBooleanOption(rec, 'varargs', false);
        }
        if (typeof fn !== 'function') {
          throw sqliteTypeError(
            'ERR_INVALID_ARG_TYPE',
            'The "function" argument must be a function.',
          );
        }

        const { rt } = st.ctx!;
        const slot = rt.addFunction((cx: number, argc: number, argv: number) => {
          try {
            const jsArgs = decodeUdfArguments(rt, argc, argv, useBigIntArguments);
            const res: unknown = Reflect.apply(fn, undefined, jsArgs);
            writeUdfResult(rt, cx, res);
          } catch (err) {
            if (st.pendingError === NO_PENDING_ERROR) st.pendingError = err;
            signalCError(rt, cx, err instanceof Error ? err.message : 'JavaScript UDF error');
          }
        }, 'viii');

        let eTextRep = SQLITE_UTF8;
        if (deterministic) eTextRep |= SQLITE_DETERMINISTIC;
        if (directOnly) eTextRep |= SQLITE_DIRECTONLY;
        const nArg = varargs ? -1 : fn.length;
        registerDbFunctionSlots(st, name, nArg, eTextRep, slot, 0, 0);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    aggregate: {
      value: function registerAggregate(this: unknown, name: unknown, options: unknown): void {
        const st = requireOpenDb(this);
        if (typeof name !== 'string') {
          throw sqliteTypeError('ERR_INVALID_ARG_TYPE', 'The "name" argument must be a string.');
        }
        const rec = toOptionRecord(options);
        if (!Object.hasOwn(rec, 'start')) {
          throw sqliteTypeError(
            'ERR_INVALID_ARG_TYPE',
            'The "options.start" property must be a function or a primitive value.',
          );
        }
        const startOpt = rec.start;
        const stepFn = rec.step;
        const resultFn = rec.result;
        const inverseFn = rec.inverse;
        if (typeof stepFn !== 'function') {
          throw sqliteTypeError(
            'ERR_INVALID_ARG_TYPE',
            'The "options.step" property must be a function.',
          );
        }
        if (resultFn !== undefined && typeof resultFn !== 'function') {
          throw sqliteTypeError(
            'ERR_INVALID_ARG_TYPE',
            'The "options.result" property must be a function.',
          );
        }
        if (inverseFn !== undefined && typeof inverseFn !== 'function') {
          throw sqliteTypeError(
            'ERR_INVALID_ARG_TYPE',
            'The "options.inverse" argument must be a function.',
          );
        }
        const deterministic = validateBooleanOption(rec, 'deterministic', false);
        const directOnly = validateBooleanOption(rec, 'directOnly', false);
        const useBigIntArguments = validateBooleanOption(rec, 'useBigIntArguments', false);
        const varargs = validateBooleanOption(rec, 'varargs', false);

        if (typeof inverseFn === 'function') {
          throw fault(
            'ENOSYS',
            'SQLite window aggregate functions (options.inverse) are not supported by the bundled SQLite WASM build',
          );
        }

        const { rt } = st.ctx!;
        const accumulators = new Map<number, unknown>();

        const initStart = (): unknown =>
          typeof startOpt === 'function' ? Reflect.apply(startOpt, undefined, []) : startOpt;

        const stepSlot = rt.addFunction((cx: number, argc: number, argv: number) => {
          try {
            // Word 2 (byte offset 8) of sqlite3_context is `Mem *pMem`, unique per aggregate site/group.
            const pMem = rt.u32()[(cx >>> 2) + 2]!;
            const acc = accumulators.has(pMem) ? accumulators.get(pMem) : initStart();
            const jsArgs = decodeUdfArguments(rt, argc, argv, useBigIntArguments);
            const nextAcc: unknown = Reflect.apply(stepFn, undefined, [acc, ...jsArgs]);
            if (isThenable(nextAcc)) {
              throw sqliteErrorFromCode(
                SQLITE_ERROR,
                'Asynchronous user-defined functions are not supported',
              );
            }
            accumulators.set(pMem, nextAcc);
          } catch (err) {
            accumulators.clear();
            if (st.pendingError === NO_PENDING_ERROR) st.pendingError = err;
            signalCError(rt, cx, err instanceof Error ? err.message : 'JavaScript aggregate error');
          }
        }, 'viii');

        const finalSlot = rt.addFunction((cx: number) => {
          const pMem = rt.u32()[(cx >>> 2) + 2]!;
          try {
            const acc = pMem !== 0 && accumulators.has(pMem) ? accumulators.get(pMem) : initStart();
            if (pMem !== 0) accumulators.delete(pMem);
            const out: unknown =
              typeof resultFn === 'function' ? Reflect.apply(resultFn, undefined, [acc]) : acc;
            writeUdfResult(rt, cx, out);
          } catch (err) {
            if (pMem !== 0) accumulators.delete(pMem);
            if (st.pendingError === NO_PENDING_ERROR) st.pendingError = err;
            signalCError(rt, cx, err instanceof Error ? err.message : 'JavaScript aggregate error');
          }
        }, 'vi');

        let eTextRep = SQLITE_UTF8;
        if (deterministic) eTextRep |= SQLITE_DETERMINISTIC;
        if (directOnly) eTextRep |= SQLITE_DIRECTONLY;
        const nArg = varargs ? -1 : Math.max(0, stepFn.length - 1);
        registerDbFunctionSlots(st, name, nArg, eTextRep, 0, stepSlot, finalSlot, accumulators);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    enableLoadExtension: {
      value: function enableLoadExtension(this: unknown, allow: unknown): void {
        const st = requireOpenDb(this);
        const allowBool = validateBoolArg(allow, 'allow');
        if (!st.config.allowExtension && allowBool) {
          throw sqliteStateError(
            'Cannot enable extension loading because it is disabled at database creation.',
          );
        }
        if (allowBool) {
          throw fault(
            'ENOSYS',
            'Dynamic SQLite native extensions are not supported in browser Workers',
          );
        }
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    loadExtension: {
      value: function loadExtension(this: unknown, extPath: unknown): void {
        const st = requireOpenDb(this);
        if (typeof extPath !== 'string') {
          throw sqliteTypeError('ERR_INVALID_ARG_TYPE', 'The "path" argument must be a string.');
        }
        if (!st.config.allowExtension) {
          throw sqliteStateError('Extension loading is not allowed.');
        }
        throw fault(
          'ENOSYS',
          'Dynamic SQLite native extensions are not supported in browser Workers',
        );
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    createSession: {
      value: function createSession(this: unknown): never {
        requireOpenDb(this);
        throw fault('ENOSYS', 'SQLite session extension is not supported in browser Workers');
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    applyChangeset: {
      value: function applyChangeset(this: unknown): never {
        requireOpenDb(this);
        throw fault('ENOSYS', 'SQLite session extension is not supported in browser Workers');
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    [nodejsDisposeSymbol]: {
      value: disposeDatabase,
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });

  if (typeof Symbol.dispose === 'symbol' && !Object.is(Symbol.dispose, nodejsDisposeSymbol)) {
    Object.defineProperty(DatabaseSync.prototype, Symbol.dispose, {
      value: disposeDatabase,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  let backupSeq = 0;

  function backup(sourceDb: unknown, destination: unknown, options?: unknown): Promise<number> {
    if (typeof sourceDb !== 'object' || sourceDb === null) {
      throw sqliteTypeError('ERR_INVALID_ARG_TYPE', 'The "sourceDb" argument must be an object.');
    }
    const st = requireOpenDb(sourceDb);
    if (typeof destination !== 'string') {
      throw sqliteTypeError('ERR_INVALID_ARG_TYPE', 'The "destination" argument must be a string.');
    }
    if (destination.includes('\0')) {
      throw sqliteTypeError(
        'ERR_INVALID_ARG_VALUE',
        "The argument 'destination' must be a string without null bytes.",
      );
    }

    let rate = 100;
    let sourceName = 'main';
    let targetName = 'main';
    let progressFn: unknown;

    if (options !== undefined) {
      const rec = toOptionRecord(options);
      if (rec.rate !== undefined) {
        if (typeof rec.rate !== 'number' || !Number.isInteger(rec.rate)) {
          throw sqliteTypeError(
            'ERR_INVALID_ARG_TYPE',
            'The "options.rate" argument must be an integer.',
          );
        }
        if (rec.rate < INT32_MIN || rec.rate > INT32_MAX) {
          throw Object.assign(new RangeError('The value of "options.rate" is out of range.'), {
            code: 'ERR_OUT_OF_RANGE',
          });
        }
        rate = rec.rate;
      }
      if (rec.source !== undefined) {
        if (typeof rec.source !== 'string') {
          throw sqliteTypeError(
            'ERR_INVALID_ARG_TYPE',
            'The "options.source" argument must be a string.',
          );
        }
        sourceName = rec.source;
      }
      if (rec.target !== undefined) {
        if (typeof rec.target !== 'string') {
          throw sqliteTypeError(
            'ERR_INVALID_ARG_TYPE',
            'The "options.target" argument must be a string.',
          );
        }
        targetName = rec.target;
      }
      if (rec.progress !== undefined) {
        if (typeof rec.progress !== 'function') {
          throw sqliteTypeError(
            'ERR_INVALID_ARG_TYPE',
            'The "options.progress" argument must be a function.',
          );
        }
        progressFn = rec.progress;
      }
    }

    return (async () => {
      if (st.dbPtr === 0 || !st.ctx) {
        throw sqliteStateError('database is not open');
      }
      const dbCtx = st.ctx;
      const { rt } = dbCtx;

      const attachedNames = dbCtx
        .queryPragmaRows('PRAGMA database_list')
        .map((r) => (typeof r.name === 'string' ? r.name : ''));
      if (sourceName !== 'temp' && !attachedNames.includes(sourceName)) {
        throw sqliteErrorFromCode(SQLITE_ERROR, `unknown database ${sourceName}`);
      }
      if (targetName !== 'main' && targetName !== 'temp') {
        throw sqliteErrorFromCode(SQLITE_ERROR, `unknown database ${targetName}`);
      }

      const escapedSource = sourceName.replaceAll('"', '""');
      const pageRows = dbCtx.queryPragmaRows(`PRAGMA "${escapedSource}".page_count`);
      const totalPages = typeof pageRows[0]?.page_count === 'number' ? pageRows[0].page_count : 0;

      if (destination !== ':memory:') {
        const resolvedDest = path.resolve(deps.cwd(), destination);
        if (targetName === 'temp') {
          const creatFlags = fsConst(deps.fs, 'O_CREAT', 64) | fsConst(deps.fs, 'O_RDWR', 2);
          const fd = callFs(deps.fs, 'openSync', resolvedDest, creatFlags, 0o666);
          if (typeof fd === 'number' && fd >= 0) {
            callFs(deps.fs, 'closeSync', fd);
          }
        } else {
          backupSeq += 1;
          const stagePath = `${resolvedDest}.bkp-${Date.now()}-${backupSeq}.tmp`;
          try {
            callFs(deps.fs, 'unlinkSync', stagePath);
          } catch {
            // Ignore ENOENT before staging.
          }
          const escapedStage = stagePath.replaceAll("'", "''");
          const { ptr: vacPtr } = rt.allocCString(
            `VACUUM "${escapedSource}" INTO '${escapedStage}'`,
          );
          try {
            const rc = rt.wasm.sqlite3_exec(st.dbPtr, vacPtr, 0, 0, 0);
            if (rc !== SQLITE_OK) {
              dbCtx.throwDbError(rc);
            }
            callFs(deps.fs, 'renameSync', stagePath, resolvedDest);
          } catch (err) {
            try {
              callFs(deps.fs, 'unlinkSync', stagePath);
            } catch {
              // Best-effort cleanup of staging file.
            }
            throw err;
          } finally {
            rt.wasm.free(vacPtr);
          }
        }
      }

      if (typeof progressFn === 'function' && rate > 0) {
        for (let remainingPages = totalPages - rate; remainingPages > 0; remainingPages -= rate) {
          await Promise.resolve();
          Reflect.apply(progressFn, undefined, [{ totalPages, remainingPages }]);
        }
      }

      return totalPages;
    })();
  }

  return {
    // Invariant: DatabaseSync is a callable constructor function validated via new.target that constructs DatabaseSync instances.
    DatabaseSync: DatabaseSync as unknown as {
      new (
        location: string | Uint8Array | URL,
        options?: Record<string, unknown>,
      ): {
        readonly isOpen: boolean;
        readonly isTransaction: boolean;
        open(): void;
        close(): void;
        exec(sql: string): void;
        prepare(sql: string): {
          readonly sourceSQL: string;
          readonly expandedSQL: string;
          run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
          get(...params: unknown[]): Record<string, unknown> | unknown[] | undefined;
          all(...params: unknown[]): Array<Record<string, unknown> | unknown[]>;
          iterate(...params: unknown[]): IterableIterator<Record<string, unknown> | unknown[]>;
          columns(): Array<Record<string, string | null>>;
          setAllowBareNamedParameters(enabled: boolean): void;
          setAllowUnknownNamedParameters(enabled: boolean): void;
          setReadBigInts(enabled: boolean): void;
          setReturnArrays(enabled: boolean): void;
        };
        location(dbName?: string): string | null;
        function(name: string, optionsOrFn: unknown, maybeFn?: unknown): void;
        aggregate(name: string, options: Record<string, unknown>): void;
      };
    },
    StatementSync,
    constants: SQLITE_CONSTANTS,
    backup,
  };
}
