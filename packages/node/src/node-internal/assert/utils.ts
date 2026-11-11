// Browser-safe `internal/assert/utils` implementing Node.js v22.18.0 `innerOk`
// including guest call-site AST expression extraction via V8 CallSites + acorn.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { type Node as AcornNode, Parser } from 'acorn';
import AssertionError from 'internal/assert/assertion_error';
import { fileURLToPath } from '../../file-url';
import { BuiltinModule } from '../bootstrap/realm';
import { isErrorStackTraceLimitWritable } from '../errors';
import { activeProcess } from '../process-ref';
import { isError } from '../util';

interface CallSiteLike {
  getFileName(): string | null | undefined;
  getScriptNameOrSourceURL?(): string | null | undefined;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  toString?(): string;
}

interface CapturedLocation {
  rawFileName: string;
  oneBasedLine: number;
  oneBasedColumn: number;
  lineAlreadyUnwrapped: boolean;
  hasSourceMap: boolean;
}

interface EsmLineEdit {
  start: number;
  end: number;
  replacedLen: number;
}

// `src/loader.ts` allocates `globalThis["__guestModules_<32hex>"]` (61 chars).
const LOADER_BRIDGE_EXPRESSION_LENGTH = 61;

const escapeSequencesRegExp = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const meta = [
  '\\u0000',
  '\\u0001',
  '\\u0002',
  '\\u0003',
  '\\u0004',
  '\\u0005',
  '\\u0006',
  '\\u0007',
  '\\b',
  '',
  '',
  '\\u000b',
  '\\f',
  '',
  '\\u000e',
  '\\u000f',
  '\\u0010',
  '\\u0011',
  '\\u0012',
  '\\u0013',
  '\\u0014',
  '\\u0015',
  '\\u0016',
  '\\u0017',
  '\\u0018',
  '\\u0019',
  '\\u001a',
  '\\u001b',
  '\\u001c',
  '\\u001d',
  '\\u001e',
  '\\u001f',
];

const escapeFn = (str: string): string => meta[str.charCodeAt(0)] ?? str;

function isAcornNodeRecord(value: unknown): value is AcornNode & Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  return (
    typeof Reflect.get(value, 'type') === 'string' &&
    typeof Reflect.get(value, 'start') === 'number' &&
    typeof Reflect.get(value, 'end') === 'number'
  );
}

function findCallExpressionAround(root: AcornNode, offset: number): AcornNode | undefined {
  let found: AcornNode | undefined;

  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isAcornNodeRecord(value)) return;
    if (value.start > offset || value.end < offset) return;
    if (value.type === 'CallExpression') {
      found = value;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') {
        continue;
      }
      visit(child);
    }
  }

  visit(root);
  return found;
}

function parseCode(code: string, offset: number): [number, string] | undefined {
  for (const token of Parser.tokenizer(code, { ecmaVersion: 'latest' })) {
    const start = token.start;
    if (start > offset) break;
    try {
      const expr = Parser.parseExpressionAt(code, start, { ecmaVersion: 'latest' });
      const callNode = findCallExpressionAround(expr, offset);
      if (callNode && callNode.end >= offset) {
        return [
          callNode.start,
          code.slice(callNode.start, callNode.end).replace(escapeSequencesRegExp, escapeFn),
        ];
      }
    } catch {
      // Ignore parse failures and keep scanning earlier offsets.
    }
  }
  return undefined;
}

function adjustEsmColumnOffset(
  source: string,
  lineStartOffset: number,
  lineEndOffset: number,
  columnOffset: number,
  rawFileName: string,
): number {
  const lastSlash = rawFileName.lastIndexOf('/');
  if (lastSlash === -1) return columnOffset;
  const baseDir = rawFileName.slice(0, lastSlash + 1);
  let selfIdentity: string;
  try {
    selfIdentity = decodeURIComponent(rawFileName.slice(lastSlash + 1));
  } catch {
    return columnOffset;
  }
  if (!selfIdentity.startsWith('file://')) return columnOffset;

  let ast: AcornNode;
  try {
    ast = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return columnOffset;
  }

  const edits: EsmLineEdit[] = [];
  const selfIdentityLiteralLen = JSON.stringify(selfIdentity).length;

  function resolveStaticSpecifierLength(specifier: string): number | undefined {
    let dependency: string | undefined;
    if (specifier.startsWith('node:') || BuiltinModule.exists(specifier)) {
      dependency = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
    } else if (
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.startsWith('file:')
    ) {
      try {
        dependency = new URL(specifier, selfIdentity).href;
      } catch {
        return undefined;
      }
    }
    if (!dependency) return undefined;
    return JSON.stringify(`${baseDir}${encodeURIComponent(dependency)}`).length;
  }

  function collect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (!isAcornNodeRecord(value)) return;
    if (value.end < lineStartOffset || value.start > lineEndOffset) return;

    if (
      (value.type === 'ImportDeclaration' ||
        value.type === 'ExportNamedDeclaration' ||
        value.type === 'ExportAllDeclaration') &&
      isAcornNodeRecord(value.source) &&
      typeof value.source.value === 'string' &&
      value.source.start >= lineStartOffset &&
      value.source.end <= lineEndOffset
    ) {
      const replacedLen = resolveStaticSpecifierLength(value.source.value);
      if (replacedLen !== undefined) {
        edits.push({
          start: value.source.start - lineStartOffset,
          end: value.source.end - lineStartOffset,
          replacedLen,
        });
      }
    } else if (
      value.type === 'ImportExpression' &&
      value.start >= lineStartOffset &&
      value.start + 6 <= lineEndOffset
    ) {
      edits.push({
        start: value.start - lineStartOffset,
        end: value.start + 6 - lineStartOffset,
        replacedLen: LOADER_BRIDGE_EXPRESSION_LENGTH + 18 + selfIdentityLiteralLen + 1,
      });
    } else if (
      value.type === 'MetaProperty' &&
      value.start >= lineStartOffset &&
      value.end <= lineEndOffset
    ) {
      edits.push({
        start: value.start - lineStartOffset,
        end: value.end - lineStartOffset,
        replacedLen: LOADER_BRIDGE_EXPRESSION_LENGTH + 6 + selfIdentityLiteralLen + 1,
      });
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') {
        continue;
      }
      collect(child);
    }
  }

  collect(ast);
  if (edits.length === 0) return columnOffset;
  edits.sort((a, b) => a.start - b.start);

  let shift = 0;
  for (const edit of edits) {
    const rewrittenStart = edit.start + shift;
    const rewrittenEnd = rewrittenStart + edit.replacedLen;
    if (columnOffset <= rewrittenStart) break;
    if (columnOffset < rewrittenEnd) return edit.start;
    shift += edit.replacedLen - (edit.end - edit.start);
  }
  return Math.max(0, columnOffset - shift);
}

function resolveGuestLocation(
  rawFileName: string,
  oneBasedLine: number,
  lineAlreadyUnwrapped: boolean,
): { guestPath: string; zeroBasedLine: number; isPublishedEsm: boolean } | undefined {
  if (rawFileName.startsWith('guest:')) {
    // `src/loader.ts` compiles CJS with `new Function(...)` (2-line header) and `//# sourceURL=guest:<encoded>`.
    return {
      guestPath: decodeURI(rawFileName.slice('guest:'.length)),
      zeroBasedLine: lineAlreadyUnwrapped ? oneBasedLine - 1 : oneBasedLine - 3,
      isPublishedEsm: false,
    };
  }
  if (rawFileName.startsWith('file://')) {
    return {
      guestPath: fileURLToPath(rawFileName),
      zeroBasedLine: oneBasedLine - 1,
      isPublishedEsm: false,
    };
  }
  const encodedFileIdx = rawFileName.indexOf('file%3A%2F%2F');
  if (encodedFileIdx !== -1) {
    const decoded = decodeURIComponent(rawFileName.slice(encodedFileIdx));
    return {
      guestPath: fileURLToPath(decoded),
      zeroBasedLine: oneBasedLine - 1,
      isPublishedEsm: true,
    };
  }
  if (rawFileName.startsWith('/')) {
    return {
      guestPath: rawFileName,
      zeroBasedLine: oneBasedLine - 1,
      isPublishedEsm: false,
    };
  }
  return undefined;
}

const errorCache = new Map<string, string | undefined>();

function mapFrameWithPrepare(
  savedPrepare: (err: Error, stack: CallSiteLike[]) => unknown,
  rawFileName: string,
  rawLine: number,
  rawColumn: number,
):
  | { line: number; column: number; lineAlreadyUnwrapped: boolean; hasSourceMap: boolean }
  | 'generated'
  | undefined {
  try {
    const zeroProbe: CallSiteLike = {
      getFileName: () => rawFileName,
      getScriptNameOrSourceURL: () => rawFileName,
      getLineNumber: () => 0,
      getColumnNumber: () => 1,
      toString: () => `${rawFileName}:0:1`,
    };
    const zeroFormatted = savedPrepare(new Error(''), [zeroProbe]);
    if (typeof zeroFormatted !== 'string') return undefined;
    const hasSourceMap = zeroFormatted === 'Error';
    const lineAlreadyUnwrapped =
      hasSourceMap || zeroFormatted !== `Error\n    at ${rawFileName}:0:1`;

    const siteProbe: CallSiteLike = {
      getFileName: () => rawFileName,
      getScriptNameOrSourceURL: () => rawFileName,
      getLineNumber: () => rawLine,
      getColumnNumber: () => rawColumn,
      toString: () => `${rawFileName}:${rawLine}:${rawColumn}`,
    };
    const formatted = savedPrepare(new Error(''), [siteProbe]);
    if (formatted === 'Error') return 'generated';
    const prefix = `Error\n    at ${rawFileName}:`;
    if (typeof formatted === 'string' && formatted.startsWith(prefix)) {
      const rest = formatted.slice(prefix.length);
      const colonIdx = rest.indexOf(':');
      if (colonIdx > 0) {
        const mappedLine = Number(rest.slice(0, colonIdx));
        const mappedColumn = Number(rest.slice(colonIdx + 1));
        if (Number.isInteger(mappedLine) && Number.isInteger(mappedColumn)) {
          return {
            line: mappedLine,
            column: mappedColumn,
            lineAlreadyUnwrapped,
            hasSourceMap,
          };
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function captureTopLocation(fn: (...args: never[]) => unknown): CapturedLocation | undefined {
  // Invariant: V8's `Error` constructor hosts optional `stackTraceLimit`, `prepareStackTrace`, and `captureStackTrace` hooks.
  const ErrCtor = Error as ErrorConstructor & {
    stackTraceLimit?: number;
    prepareStackTrace?: (err: Error, stack: CallSiteLike[]) => unknown;
    captureStackTrace?: (target: object, ctor?: (...args: never[]) => unknown) => void;
  };
  if (typeof ErrCtor.captureStackTrace !== 'function') return undefined;

  const limitWritable = isErrorStackTraceLimitWritable();
  const savedLimit = ErrCtor.stackTraceLimit;
  const hadPrepare = Object.prototype.hasOwnProperty.call(ErrCtor, 'prepareStackTrace');
  const savedPrepare = ErrCtor.prepareStackTrace;

  let frames: CallSiteLike[] | undefined;
  try {
    if (limitWritable) ErrCtor.stackTraceLimit = 10;
    ErrCtor.prepareStackTrace = (_err, stack) => stack;
    const holder: { stack?: unknown } = {};
    ErrCtor.captureStackTrace(holder, fn);
    if (Array.isArray(holder.stack) && holder.stack.length > 0) {
      // Invariant: `ErrCtor.prepareStackTrace` above returns V8's `CallSite[]` array directly.
      frames = holder.stack as CallSiteLike[];
    }
  } catch {
    return undefined;
  } finally {
    if (hadPrepare) {
      ErrCtor.prepareStackTrace = savedPrepare;
    } else {
      Reflect.deleteProperty(ErrCtor, 'prepareStackTrace');
    }
    if (limitWritable) ErrCtor.stackTraceLimit = savedLimit;
  }

  if (!frames) return undefined;

  for (const call of frames) {
    const rawFileName = call.getFileName() || call.getScriptNameOrSourceURL?.();
    const rawLine = call.getLineNumber();
    const rawColumn = call.getColumnNumber();
    if (!rawFileName || rawLine === null || rawColumn === null) continue;

    if (typeof savedPrepare === 'function') {
      const mapped = mapFrameWithPrepare(savedPrepare, rawFileName, rawLine, rawColumn);
      if (mapped === 'generated') continue;
      if (mapped) {
        return {
          rawFileName,
          oneBasedLine: mapped.line,
          oneBasedColumn: mapped.column,
          lineAlreadyUnwrapped: mapped.lineAlreadyUnwrapped,
          hasSourceMap: mapped.hasSourceMap,
        };
      }
    }

    return {
      rawFileName,
      oneBasedLine: rawLine,
      oneBasedColumn: rawColumn,
      lineAlreadyUnwrapped: false,
      hasSourceMap: false,
    };
  }

  return undefined;
}

function getErrMessage(
  message: string | undefined,
  fn: (...args: never[]) => unknown,
): string | undefined {
  const loc = captureTopLocation(fn);
  if (!loc) return message;

  const { rawFileName, oneBasedLine, oneBasedColumn, lineAlreadyUnwrapped, hasSourceMap } = loc;
  if (rawFileName.startsWith('node:') && BuiltinModule.exists(rawFileName.slice(5))) {
    return undefined;
  }

  const identifier = `${rawFileName}:${oneBasedLine}:${oneBasedColumn}:${lineAlreadyUnwrapped ? 1 : 0}:${hasSourceMap ? 1 : 0}`;
  if (errorCache.has(identifier)) {
    return errorCache.get(identifier);
  }

  const resolved = resolveGuestLocation(rawFileName, oneBasedLine, lineAlreadyUnwrapped);
  if (!resolved || resolved.zeroBasedLine < 0) {
    errorCache.set(identifier, undefined);
    return undefined;
  }

  try {
    const fsCandidate: unknown = activeProcess().getBuiltinModule?.('fs');
    const readFileSync =
      typeof fsCandidate === 'object' && fsCandidate !== null && 'readFileSync' in fsCandidate
        ? fsCandidate.readFileSync
        : undefined;
    if (typeof readFileSync !== 'function') {
      errorCache.set(identifier, undefined);
      return undefined;
    }
    const source = String(
      Reflect.apply(readFileSync, fsCandidate, [resolved.guestPath, 'utf8']),
    ).replace(/^#![^\n]*/, '');
    const lines = source.split('\n');
    if (resolved.zeroBasedLine >= lines.length) {
      errorCache.set(identifier, undefined);
      return undefined;
    }

    let lineStartOffset = 0;
    for (let i = 0; i < resolved.zeroBasedLine; i++) {
      lineStartOffset += lines[i].length + 1;
    }
    const lineEndOffset = lineStartOffset + lines[resolved.zeroBasedLine].length;

    let columnOffset = Math.max(0, oneBasedColumn - 1);
    if (resolved.isPublishedEsm && !hasSourceMap) {
      columnOffset = adjustEsmColumnOffset(
        source,
        lineStartOffset,
        lineEndOffset,
        columnOffset,
        rawFileName,
      );
    }

    const tail = lines.slice(resolved.zeroBasedLine).join('\n');
    const parsed = parseCode(tail, columnOffset);
    if (!parsed) {
      errorCache.set(identifier, undefined);
      return undefined;
    }
    const [col, rawExpr] = parsed;
    let formatted = rawExpr;
    if (formatted.includes('\n')) {
      const exprLines = formatted.replace(/\r\n/g, '\n').split('\n');
      formatted = exprLines.shift() ?? '';
      for (const frame of exprLines) {
        let pos = 0;
        while (pos < col && (frame[pos] === ' ' || frame[pos] === '\t')) pos++;
        formatted += `\n  ${frame.slice(pos)}`;
      }
    }
    const built = `The expression evaluated to a falsy value:\n\n  ${formatted}\n`;
    errorCache.set(identifier, built);
    return built;
  } catch {
    errorCache.set(identifier, undefined);
    return undefined;
  }
}

export function innerOk(
  fn: (...args: never[]) => unknown,
  argLen: number,
  value: unknown,
  message?: unknown,
): void {
  if (!value) {
    let generatedMessage = false;
    let resolvedMessage: string | undefined;

    if (argLen === 0) {
      generatedMessage = true;
      resolvedMessage = 'No value argument passed to `assert.ok()`';
    } else if (message == null) {
      generatedMessage = true;
      resolvedMessage = getErrMessage(undefined, fn);
    } else if (isError(message)) {
      throw message;
    } else {
      resolvedMessage = String(message);
    }

    const err = new AssertionError({
      actual: value,
      expected: true,
      message: resolvedMessage,
      operator: '==',
      stackStartFn: fn,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}
