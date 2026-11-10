import { Buffer } from 'buffer';
import {
  invalidArgType,
  invalidArgValue,
  nodeError,
  validateInteger,
  validateObject,
} from './node-errors';
import { record } from './protocol';
import { formatWithOptions } from './util-format';
import { inspect } from './util-inspect';

export interface ConsoleProcessLike {
  stdout?: unknown;
  stderr?: unknown;
  env?: Record<string, unknown>;
  hrtime?: (time?: [number, number]) => [number, number];
  emitWarning?: (warning: string | Error, type?: string, code?: string) => void;
}

export interface ConsoleOptions {
  stdout: unknown;
  stderr?: unknown;
  ignoreErrors?: boolean;
  colorMode?: boolean | 'auto';
  inspectOptions?: Record<string, unknown>;
  groupIndentation?: number;
}

export interface ConsoleInstance {
  Console?: ConsoleConstructor;
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  dir: (value: unknown, options?: unknown) => void;
  dirxml: (...args: unknown[]) => void;
  time: (label?: unknown) => void;
  timeEnd: (label?: unknown) => void;
  timeLog: (label?: unknown, ...data: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  assert: (expression?: unknown, ...args: unknown[]) => void;
  clear: () => void;
  count: (label?: unknown) => void;
  countReset: (label?: unknown) => void;
  group: (...data: unknown[]) => void;
  groupCollapsed: (...data: unknown[]) => void;
  groupEnd: () => void;
  table: (tabularData?: unknown, properties?: unknown) => void;
  _stdout: Record<string, unknown>;
  _stderr: Record<string, unknown>;
  _ignoreErrors: boolean;
  _times: Map<string, [number, number] | number>;
}

export interface ConsoleConstructor {
  new (stdout: unknown, stderr?: unknown, ignoreErrors?: unknown): ConsoleInstance;
  new (options: ConsoleOptions): ConsoleInstance;
  (stdout: unknown, stderr?: unknown, ignoreErrors?: unknown): ConsoleInstance;
  (options: ConsoleOptions): ConsoleInstance;
  readonly prototype: ConsoleInstance;
}

const kCounts = Symbol('counts');
const kColorMode = Symbol('kColorMode');
const kIsConsole = Symbol('kIsConsole');
const kGroupIndentationWidth = Symbol('kGroupIndentWidth');
const kProcess = Symbol('kProcess');

const optionsMap = new WeakMap<object, Record<string, unknown>>();
const indentationMap = new WeakMap<object, string>();

let defaultProcess: ConsoleProcessLike | undefined;

export function setDefaultConsoleProcess(proc: ConsoleProcessLike): void {
  defaultProcess = proc;
}

function getConsoleProcess(instance: unknown): ConsoleProcessLike | undefined {
  if (record(instance)) {
    const attached: unknown = Reflect.get(instance, kProcess);
    if (record(attached)) {
      // Invariant: [kProcess] is only set by upgradeGlobalConsole from a validated ConsoleProcessLike.
      return attached as ConsoleProcessLike;
    }
  }
  if (defaultProcess) return defaultProcess;
  const hostProc: unknown = Reflect.get(globalThis, 'process');
  // Invariant: record(hostProc) narrows globalThis.process to an object matching optional ConsoleProcessLike properties.
  return record(hostProc) ? (hostProc as ConsoleProcessLike) : undefined;
}

function emitConsoleWarning(instance: unknown, message: string): void {
  const proc = getConsoleProcess(instance);
  if (proc && typeof proc.emitWarning === 'function') {
    proc.emitWarning(message);
  }
}

function startTimer(instance: unknown): [number, number] | number {
  const proc = getConsoleProcess(instance);
  if (proc && typeof proc.hrtime === 'function') {
    return proc.hrtime();
  }
  return performance.now();
}

function elapsedTimerMs(instance: unknown, started: [number, number] | number): number {
  const proc = getConsoleProcess(instance);
  if (Array.isArray(started) && proc && typeof proc.hrtime === 'function') {
    const diff = proc.hrtime(started);
    return diff[0] * 1000 + diff[1] / 1e6;
  }
  const base = typeof started === 'number' ? started : 0;
  return Math.max(0, performance.now() - base);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatTime(ms: number): string {
  const kSecond = 1000;
  const kMinute = 60 * kSecond;
  const kHour = 60 * kMinute;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (ms >= kSecond) {
    if (ms >= kMinute) {
      if (ms >= kHour) {
        hours = Math.floor(ms / kHour);
        ms %= kHour;
      }
      minutes = Math.floor(ms / kMinute);
      ms %= kMinute;
    }
    seconds = ms / kSecond;
  }

  if (hours !== 0 || minutes !== 0) {
    const [secPart = '0', msPart = '000'] = seconds.toFixed(3).split('.', 2);
    const res = hours !== 0 ? `${hours}:${pad2(minutes)}` : `${minutes}`;
    return `${res}:${pad2(Number(secPart))}.${msPart} (${hours !== 0 ? 'h:m' : ''}m:ss.mmm)`;
  }

  if (seconds !== 0) {
    return `${seconds.toFixed(3)}s`;
  }

  return `${Number(ms.toFixed(3))}ms`;
}

export function getEnvColorDepth(env: Record<string, unknown> | undefined): number {
  if (!env) return 1;
  if (env.FORCE_COLOR !== undefined) {
    const fc = String(env.FORCE_COLOR);
    switch (fc) {
      case '':
      case '1':
      case 'true':
        return 4;
      case '2':
        return 8;
      case '3':
        return 24;
      case '0':
      case 'false':
        return 1;
      default:
        return 4;
    }
  }
  if (
    (env.NODE_DISABLE_COLORS !== undefined && String(env.NODE_DISABLE_COLORS) !== '') ||
    (env.NO_COLOR !== undefined && String(env.NO_COLOR) !== '') ||
    env.TERM === 'dumb'
  ) {
    return 1;
  }
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') {
    return 24;
  }
  const term = typeof env.TERM === 'string' ? env.TERM : '';
  if (/256(color)?$/i.test(term)) return 8;
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(term)) return 4;
  return 4;
}

function shouldColorize(instance: unknown, stream: unknown): boolean {
  const env = getConsoleProcess(instance)?.env;
  if (env && env.FORCE_COLOR !== undefined) {
    return getEnvColorDepth(env) > 2;
  }
  if (!record(stream) || !stream.isTTY) return false;
  if (typeof stream.getColorDepth === 'function') {
    const depth: unknown = stream.getColorDepth();
    return typeof depth === 'number' ? depth > 2 : true;
  }
  return getEnvColorDepth(env) > 2;
}

function getInspectOptions(instance: object, stream: unknown): Record<string, unknown> {
  const rawMode: unknown = Reflect.get(instance, kColorMode);
  const color = rawMode === 'auto' ? shouldColorize(instance, stream) : Boolean(rawMode);
  const saved = optionsMap.get(instance);
  if (saved) {
    if (saved.colors === undefined) {
      return { ...saved, colors: color };
    }
    return saved;
  }
  return color ? { colors: true } : {};
}

const ansiPattern = /\u001b\[[0-9;]*[a-zA-Z]/g;

function getStringWidth(str: string): number {
  const clean = str.replace(ansiPattern, '');
  let width = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue;
    // Combining diacritical marks
    if (cp >= 0x0300 && cp <= 0x036f) continue;
    // Fullwidth / wide CJK & emoji blocks
    if (
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        cp === 0x2329 ||
        cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
        (cp >= 0x3250 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0xa4c6) ||
        (cp >= 0xa960 && cp <= 0xa97c) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe10 && cp <= 0xfe19) ||
        (cp >= 0xfe30 && cp <= 0xfe6b) ||
        (cp >= 0xff01 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1faff) ||
        (cp >= 0x20000 && cp <= 0x3fffd))
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

const tableChars = {
  middleMiddle: '─',
  rowMiddle: '┼',
  topRight: '┐',
  topLeft: '┌',
  leftMiddle: '├',
  topMiddle: '┬',
  bottomRight: '┘',
  bottomLeft: '└',
  bottomMiddle: '┴',
  rightMiddle: '┤',
  left: '│ ',
  right: ' │',
  middle: ' │ ',
};

function renderTableRow(row: string[], columnWidths: number[]): string {
  let out = tableChars.left;
  for (let i = 0; i < row.length; i++) {
    const cell = row[i] ?? '';
    const len = getStringWidth(cell);
    const needed = Math.max(0, (columnWidths[i] ?? 0) - len);
    out += cell + ' '.repeat(Math.ceil(needed));
    if (i !== row.length - 1) out += tableChars.middle;
  }
  out += tableChars.right;
  return out;
}

function renderCliTable(head: string[], columns: string[][]): string {
  const rows: string[][] = [];
  const columnWidths = head.map((h) => getStringWidth(h));
  const longestColumn = Math.max(0, ...columns.map((col) => col.length));

  for (let i = 0; i < head.length; i++) {
    const column = columns[i] ?? [];
    for (let j = 0; j < longestColumn; j++) {
      let row = rows[j];
      if (!row) {
        row = [];
        rows[j] = row;
      }
      const value = Object.prototype.hasOwnProperty.call(column, j) ? (column[j] ?? '') : '';
      row[i] = value;
      columnWidths[i] = Math.max(columnWidths[i] ?? 0, getStringWidth(value));
    }
  }

  const divider = columnWidths.map((w) => tableChars.middleMiddle.repeat(w + 2));
  let result =
    tableChars.topLeft +
    divider.join(tableChars.topMiddle) +
    tableChars.topRight +
    '\n' +
    renderTableRow(head, columnWidths) +
    '\n' +
    tableChars.leftMiddle +
    divider.join(tableChars.rowMiddle) +
    tableChars.rightMiddle +
    '\n';

  for (const row of rows) {
    result += `${renderTableRow(row, columnWidths)}\n`;
  }

  result += tableChars.bottomLeft + divider.join(tableChars.bottomMiddle) + tableChars.bottomRight;
  return result;
}

function isArrayLikeTableValue(v: unknown): boolean {
  return Array.isArray(v) || ArrayBuffer.isView(v) || Buffer.isBuffer(v);
}

function writeToConsole(instance: ConsoleInstance, useStdout: boolean, text: string): void {
  const stream = useStdout ? instance._stdout : instance._stderr;
  if (!record(stream) || typeof stream.write !== 'function') {
    throw nodeError(
      TypeError,
      'ERR_CONSOLE_WRITABLE_STREAM',
      `Console expects a writable stream instance for ${useStdout ? 'stdout' : 'stderr'}`,
    );
  }
  const groupIndent = indentationMap.get(instance) ?? '';
  let formatted = text;
  if (groupIndent.length !== 0) {
    if (formatted.includes('\n')) {
      formatted = formatted.replace(/\n/g, `\n${groupIndent}`);
    }
    formatted = groupIndent + formatted;
  }
  formatted += '\n';

  if (instance._ignoreErrors === false) {
    stream.write(formatted);
    return;
  }

  const noop = () => {};

  try {
    if (
      typeof stream.once === 'function' &&
      (typeof stream.listenerCount !== 'function' || stream.listenerCount('error') === 0)
    ) {
      stream.once('error', noop);
    }
    stream.write(formatted, (err?: unknown) => {
      if (err != null) {
        const ws = stream._writableState;
        const alreadyEmitted = record(ws) && ws.errorEmitted === true;
        if (
          !alreadyEmitted &&
          typeof stream.once === 'function' &&
          (typeof stream.listenerCount !== 'function' || stream.listenerCount('error') === 0)
        ) {
          const swallowAsync = () => {};
          stream.once('error', swallowAsync);
          if (!record(ws) && typeof stream.removeListener === 'function') {
            queueMicrotask(() => {
              if (typeof stream.removeListener === 'function') {
                stream.removeListener('error', swallowAsync);
              }
            });
          }
        }
      }
    });
  } catch (err) {
    if (err instanceof RangeError && /call stack/i.test(err.message)) {
      throw err;
    }
  } finally {
    if (typeof stream.removeListener === 'function') {
      stream.removeListener('error', noop);
    }
  }
}

export function writeConsoleAssertion(
  condition: unknown,
  args: unknown[],
  warn: (...args: unknown[]) => void,
): void {
  if (condition) return;
  if (args.length > 0 && typeof args[0] === 'string') {
    args[0] = `Assertion failed: ${args[0]}`;
  } else {
    args.unshift('Assertion failed');
  }
  warn(...args);
}

const consolePropAttributes = {
  writable: true,
  enumerable: false,
  configurable: true,
} as const;

function getCountsMap(instance: ConsoleInstance): Map<string, number> {
  const existing: unknown = Reflect.get(instance, kCounts);
  if (existing instanceof Map) return existing;
  const created = new Map<string, number>();
  Object.defineProperty(instance, kCounts, { ...consolePropAttributes, value: created });
  return created;
}

function getTimesMap(instance: ConsoleInstance): Map<string, [number, number] | number> {
  if (instance._times instanceof Map) return instance._times;
  const created = new Map<string, [number, number] | number>();
  Object.defineProperty(instance, '_times', { ...consolePropAttributes, value: created });
  return created;
}

function bindConsoleState(
  target: object,
  ignoreErrors: boolean,
  colorMode: boolean | 'auto',
  groupIndentation = 2,
): void {
  Object.defineProperties(target, {
    _ignoreErrors: { ...consolePropAttributes, value: Boolean(ignoreErrors) },
    _times: { ...consolePropAttributes, value: new Map<string, [number, number] | number>() },
    [kCounts]: { ...consolePropAttributes, value: new Map<string, number>() },
    [kColorMode]: { ...consolePropAttributes, value: colorMode },
    [kIsConsole]: { ...consolePropAttributes, value: true },
    [kGroupIndentationWidth]: { ...consolePropAttributes, value: groupIndentation },
    [Symbol.toStringTag]: {
      writable: false,
      enumerable: false,
      configurable: true,
      value: 'console',
    },
  });
}

// Shorthand methods ensure constructible === false on Console.prototype, except `trace`
// which Node defines as `function trace(...args)` (constructible === true).
const consoleMethods = {
  log(this: ConsoleInstance, ...args: unknown[]) {
    writeToConsole(this, true, formatWithOptions(getInspectOptions(this, this._stdout), ...args));
  },
  info(this: ConsoleInstance, ...args: unknown[]) {
    writeToConsole(this, true, formatWithOptions(getInspectOptions(this, this._stdout), ...args));
  },
  debug(this: ConsoleInstance, ...args: unknown[]) {
    writeToConsole(this, true, formatWithOptions(getInspectOptions(this, this._stdout), ...args));
  },
  warn(this: ConsoleInstance, ...args: unknown[]) {
    writeToConsole(this, false, formatWithOptions(getInspectOptions(this, this._stderr), ...args));
  },
  error(this: ConsoleInstance, ...args: unknown[]) {
    writeToConsole(this, false, formatWithOptions(getInspectOptions(this, this._stderr), ...args));
  },
  dir(this: ConsoleInstance, object: unknown, options?: unknown) {
    const extra = record(options) ? options : {};
    writeToConsole(
      this,
      true,
      inspect(object, {
        customInspect: false,
        ...getInspectOptions(this, this._stdout),
        ...extra,
      }),
    );
  },
  time(this: ConsoleInstance, label: unknown = 'default') {
    const key = `${label}`;
    const times = getTimesMap(this);
    if (times.has(key)) {
      emitConsoleWarning(this, `Label '${key}' already exists for console.time()`);
      return;
    }
    times.set(key, startTimer(this));
  },
  timeEnd(this: ConsoleInstance, label: unknown = 'default') {
    const key = `${label}`;
    const times = getTimesMap(this);
    const started = times.get(key);
    if (started === undefined) {
      emitConsoleWarning(this, `No such label '${key}' for console.timeEnd()`);
      return;
    }
    const formatted = formatTime(elapsedTimerMs(this, started));
    this.log('%s: %s', key, formatted);
    times.delete(key);
  },
  timeLog(this: ConsoleInstance, label: unknown = 'default', ...data: unknown[]) {
    const key = `${label}`;
    const times = getTimesMap(this);
    const started = times.get(key);
    if (started === undefined) {
      emitConsoleWarning(this, `No such label '${key}' for console.timeLog()`);
      return;
    }
    const formatted = formatTime(elapsedTimerMs(this, started));
    this.log('%s: %s', key, formatted, ...data);
  },
  trace: function trace(this: ConsoleInstance, ...args: unknown[]) {
    const formatted = formatWithOptions(getInspectOptions(this, this._stderr), ...args);
    const holder: { name: string; message: string; stack?: string } = {
      name: 'Trace',
      message: formatted,
    };
    if (typeof Error.captureStackTrace === 'function') {
      const caller = typeof this.trace === 'function' ? this.trace : trace;
      Error.captureStackTrace(holder, caller);
    } else {
      const fallback = new Error(formatted).stack ?? '';
      holder.stack = fallback ? fallback.replace(/^Error/, 'Trace') : `Trace: ${formatted}`;
    }
    this.error(holder.stack);
  },
  assert(this: ConsoleInstance, expression?: unknown, ...args: unknown[]) {
    writeConsoleAssertion(expression, args, (...values) => {
      Reflect.apply(this.warn, this, values);
    });
  },
  clear(this: ConsoleInstance) {
    const stdout = this._stdout;
    const env = getConsoleProcess(this)?.env;
    if (
      record(stdout) &&
      stdout.isTTY &&
      typeof stdout.write === 'function' &&
      env?.TERM !== 'dumb'
    ) {
      stdout.write('\u001b[1;1H');
      stdout.write('\u001b[0J');
    }
  },
  count(this: ConsoleInstance, label: unknown = 'default') {
    const key = `${label}`;
    const counts = getCountsMap(this);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    this.log(`${key}: ${next}`);
  },
  countReset(this: ConsoleInstance, label: unknown = 'default') {
    const key = `${label}`;
    const counts = getCountsMap(this);
    if (!counts.has(key)) {
      emitConsoleWarning(this, `Count for '${key}' does not exist`);
      return;
    }
    counts.delete(key);
  },
  group(this: ConsoleInstance, ...data: unknown[]) {
    if (data.length > 0) {
      Reflect.apply(this.log, this, data);
    }
    const rawWidth: unknown = Reflect.get(this, kGroupIndentationWidth);
    const width = typeof rawWidth === 'number' ? rawWidth : 2;
    const current = indentationMap.get(this) ?? '';
    indentationMap.set(this, current + ' '.repeat(width));
  },
  groupEnd(this: ConsoleInstance) {
    const rawWidth: unknown = Reflect.get(this, kGroupIndentationWidth);
    const width = typeof rawWidth === 'number' ? rawWidth : 2;
    const current = indentationMap.get(this) ?? '';
    indentationMap.set(this, current.slice(0, Math.max(0, current.length - width)));
  },
  table(this: ConsoleInstance, tabularData?: unknown, properties?: unknown) {
    if (properties !== undefined && !Array.isArray(properties)) {
      throw invalidArgType('properties', 'Array', properties);
    }
    if (tabularData === null || typeof tabularData !== 'object') {
      this.log(tabularData);
      return;
    }

    const baseInspect = getInspectOptions(this, this._stdout);
    const formatCell = (v: unknown): string => {
      const depth =
        v !== null &&
        typeof v === 'object' &&
        !isArrayLikeTableValue(v) &&
        Object.keys(v).length > 2
          ? -1
          : 0;
      return inspect(v, {
        depth,
        maxArrayLength: 3,
        breakLength: Number.POSITIVE_INFINITY,
        ...baseInspect,
      });
    };
    const getIndexArray = (length: number) => Array.from({ length }, (_, idx) => formatCell(idx));

    if (tabularData instanceof Map) {
      const keys: string[] = [];
      const values: string[] = [];
      for (const [k, v] of tabularData) {
        keys.push(formatCell(k));
        values.push(formatCell(v));
      }
      this.log(
        renderCliTable(
          ['(iteration index)', 'Key', 'Values'],
          [getIndexArray(keys.length), keys, values],
        ),
      );
      return;
    }

    if (tabularData instanceof Set) {
      const values: string[] = [];
      for (const v of tabularData) {
        values.push(formatCell(v));
      }
      this.log(
        renderCliTable(['(iteration index)', 'Values'], [getIndexArray(values.length), values]),
      );
      return;
    }

    // Invariant: Object.create(null) creates an empty null-prototype string-array dictionary.
    const columnMap: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    let hasPrimitives = false;
    const valuesKeyArray: string[] = [];
    const indexKeyArray = Object.keys(tabularData);

    for (let i = 0; i < indexKeyArray.length; i++) {
      const rowKey = indexKeyArray[i]!;
      const item: unknown = Reflect.get(tabularData, rowKey);
      const primitive = item === null || (typeof item !== 'function' && typeof item !== 'object');
      if (properties === undefined && primitive) {
        hasPrimitives = true;
        valuesKeyArray[i] = formatCell(item);
      } else {
        const propKeys = properties
          ? properties.map((p) => String(p))
          : record(item) || typeof item === 'function'
            ? Object.keys(item)
            : [];
        for (const propKey of propKeys) {
          let col = columnMap[propKey];
          if (!col) {
            col = [];
            columnMap[propKey] = col;
          }
          if (
            (primitive && properties !== undefined) ||
            (typeof item !== 'object' && typeof item !== 'function') ||
            item === null ||
            !Object.prototype.hasOwnProperty.call(item, propKey)
          ) {
            col[i] = '';
          } else {
            col[i] = formatCell(Reflect.get(item, propKey));
          }
        }
      }
    }

    const head = ['(index)', ...Object.keys(columnMap)];
    const cols: string[][] = [indexKeyArray, ...Object.values(columnMap)];
    if (hasPrimitives) {
      head.push('Values');
      cols.push(valuesKeyArray);
    }
    this.log(renderCliTable(head, cols));
  },
};

function ConsoleImpl(
  this: unknown,
  stdoutOrOptions?: unknown,
  stderrArg?: unknown,
  ignoreErrorsArg?: unknown,
): ConsoleInstance {
  if (new.target === undefined) {
    // Invariant: ConsoleImpl is exported as ConsoleConstructor and supports call without `new`.
    return new (ConsoleImpl as unknown as ConsoleConstructor)(
      stdoutOrOptions,
      stderrArg,
      ignoreErrorsArg,
    );
  }

  const rawOptions: Record<string, unknown> =
    !record(stdoutOrOptions) || typeof stdoutOrOptions.write === 'function'
      ? { stdout: stdoutOrOptions, stderr: stderrArg, ignoreErrors: ignoreErrorsArg }
      : stdoutOrOptions;

  const stdout = rawOptions.stdout;
  const stderr = rawOptions.stderr === undefined ? stdout : rawOptions.stderr;
  const ignoreErrors =
    rawOptions.ignoreErrors === undefined ? true : Boolean(rawOptions.ignoreErrors);
  const colorMode = rawOptions.colorMode === undefined ? 'auto' : rawOptions.colorMode;
  const inspectOptions = rawOptions.inspectOptions;
  const groupIndentation = rawOptions.groupIndentation;

  if (!record(stdout) || typeof stdout.write !== 'function') {
    throw nodeError(
      TypeError,
      'ERR_CONSOLE_WRITABLE_STREAM',
      'Console expects a writable stream instance for stdout',
    );
  }
  if (!record(stderr) || typeof stderr.write !== 'function') {
    throw nodeError(
      TypeError,
      'ERR_CONSOLE_WRITABLE_STREAM',
      'Console expects a writable stream instance for stderr',
    );
  }

  if (colorMode !== 'auto' && colorMode !== true && colorMode !== false) {
    throw invalidArgValue('colorMode', colorMode, "must be one of: 'auto', true, false");
  }

  if (groupIndentation !== undefined) {
    validateInteger(groupIndentation, 'groupIndentation', 0, 1000);
  }

  // Invariant: `this` inside `new ConsoleImpl(...)` is the newly constructed ConsoleInstance object.
  const self = this as ConsoleInstance;

  if (inspectOptions !== undefined) {
    validateObject(inspectOptions, 'options.inspectOptions');
    if (inspectOptions.colors !== undefined && rawOptions.colorMode !== undefined) {
      throw nodeError(
        TypeError,
        'ERR_INCOMPATIBLE_OPTION_PAIR',
        'Option "options.inspectOptions.color" cannot be used in combination with option "colorMode"',
      );
    }
    optionsMap.set(self, { ...inspectOptions });
  }

  for (const key of Object.keys(ConsoleImpl.prototype)) {
    const fn: unknown = Reflect.get(self, key);
    if (typeof fn === 'function') {
      const bound = fn.bind(self);
      Object.defineProperty(bound, 'name', { configurable: true, value: key });
      Reflect.set(self, key, bound);
    }
  }

  Object.defineProperties(self, {
    _stdout: { ...consolePropAttributes, value: stdout },
    _stderr: { ...consolePropAttributes, value: stderr },
  });
  bindConsoleState(
    self,
    ignoreErrors,
    colorMode,
    typeof groupIndentation === 'number' ? groupIndentation : 2,
  );
  return self;
}

Object.defineProperty(ConsoleImpl, 'name', { configurable: true, value: 'Console' });
Object.defineProperty(ConsoleImpl, Symbol.hasInstance, {
  configurable: true,
  value(instance: unknown): boolean {
    return Boolean(record(instance) && Reflect.get(instance, kIsConsole) === true);
  },
});

for (const key of Reflect.ownKeys(consoleMethods)) {
  const desc = Object.getOwnPropertyDescriptor(consoleMethods, key);
  if (desc) {
    Object.defineProperty(ConsoleImpl.prototype, key, desc);
  }
}
ConsoleImpl.prototype.dirxml = ConsoleImpl.prototype.log;
ConsoleImpl.prototype.groupCollapsed = ConsoleImpl.prototype.group;

// Invariant: ConsoleImpl initializes all ConsoleInstance fields and prototype methods matching Node 22.18.0.
export const Console: ConsoleConstructor = ConsoleImpl as unknown as ConsoleConstructor;
export const GuestConsole = Console;
export type GuestConsole = ConsoleInstance;

const inspectorNoopMethods = {
  profile() {},
  profileEnd() {},
  timeStamp() {},
};

export function upgradeGlobalConsole<TConsole extends Record<string, unknown>>(
  guestConsole: TConsole,
  proc: ConsoleProcessLike,
): TConsole {
  setDefaultConsoleProcess(proc);

  let stdoutCache: unknown;
  let stderrCache: unknown;
  Object.defineProperties(guestConsole, {
    [kProcess]: { ...consolePropAttributes, value: proc },
    _stdout: {
      enumerable: false,
      configurable: true,
      get() {
        if (stdoutCache === undefined) stdoutCache = proc.stdout;
        return stdoutCache;
      },
      set(value: unknown) {
        stdoutCache = value;
      },
    },
    _stderr: {
      enumerable: false,
      configurable: true,
      get() {
        if (stderrCache === undefined) stderrCache = proc.stderr;
        return stderrCache;
      },
      set(value: unknown) {
        stderrCache = value;
      },
    },
  });

  bindConsoleState(guestConsole, true, 'auto', 2);

  for (const prop of Reflect.ownKeys(Console.prototype)) {
    if (prop === 'constructor') continue;
    const desc = Object.getOwnPropertyDescriptor(Console.prototype, prop);
    if (!desc) continue;
    if (typeof desc.value === 'function') {
      const fnName = desc.value.name || String(prop);
      const bound = desc.value.bind(guestConsole);
      Object.defineProperty(bound, 'name', { configurable: true, value: fnName });
      Object.defineProperty(guestConsole, prop, {
        ...desc,
        value: bound,
      });
    } else {
      Object.defineProperty(guestConsole, prop, desc);
    }
  }

  for (const key of ['profile', 'profileEnd', 'timeStamp'] as const) {
    const desc = Object.getOwnPropertyDescriptor(inspectorNoopMethods, key);
    if (desc) {
      Object.defineProperty(guestConsole, key, desc);
    }
  }

  Object.defineProperty(guestConsole, 'Console', {
    writable: true,
    enumerable: true,
    configurable: true,
    value: Console,
  });

  return guestConsole;
}
