// `process.emitWarning` and Node's `warning` reporter, after Node 22.18's
// lib/internal/process/warning.js. The reporter is the first `warning` listener,
// so it prints every warning the process emits: the guest's own and the
// lifecycle's rejection warnings.

/** The part of the guest `process` object the warning machinery reads. */
export interface WarningProcess {
  pid: number;
  emit(name: string, ...args: unknown[]): boolean;
  on(name: string, listener: (...args: unknown[]) => void): unknown;
  nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]): void;
  /** Read live, as in Node: guest assignments change what is printed or thrown. */
  noDeprecation?: unknown;
  throwDeprecation?: unknown;
  traceDeprecation?: unknown;
  traceProcessWarnings?: unknown;
  emitWarning?: unknown;
}

export interface WarningHost {
  process: WarningProcess;
  /** False under `--no-warnings` or NODE_NO_WARNINGS=1: warnings are emitted, not printed. */
  print: boolean;
  /** Writes to the process's stderr binding; a closed stderr is not an error. */
  diagnostic(text: string): void;
}

/** Node's `determineSpecificType`, which ends an ERR_INVALID_ARG_TYPE message. */
function received(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'function') return value.name ? `function ${value.name}` : 'function';
  if (typeof value === 'object') {
    const ctor: unknown = Reflect.get(value, 'constructor');
    return typeof ctor === 'function' && ctor.name
      ? `an instance of ${ctor.name}`
      : 'an instance of Object';
  }
  let shown =
    typeof value === 'string'
      ? `'${value}'`
      : typeof value === 'bigint'
        ? `${value}n`
        : String(value);
  if (shown.length > 28) shown = `${shown.slice(0, 25)}...`;
  return `type ${typeof value} (${shown})`;
}

/** Node's ERR_INVALID_ARG_TYPE, e.g. `The "obj" argument must be of type object. Received null`. */
export function invalidArgType(name: string, expected: string, value: unknown): TypeError {
  return Object.assign(
    new TypeError(`The "${name}" argument must be ${expected}. Received ${received(value)}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw invalidArgType(name, 'of type string', value);
}

export function createWarnings(host: WarningHost) {
  const { process } = host;
  let hintShown = false;

  function onWarning(warning: unknown): void {
    if (!(warning instanceof Error)) return;
    const deprecation = warning.name === 'DeprecationWarning';
    if (deprecation && process.noDeprecation) return;
    const trace = Boolean(
      process.traceProcessWarnings || (deprecation && process.traceDeprecation),
    );
    let text = `(node:${process.pid}) `;
    const code: unknown = Reflect.get(warning, 'code');
    if (code) text += `[${String(code)}] `;
    if (trace && warning.stack) text += warning.stack;
    else
      text +=
        typeof warning.toString === 'function'
          ? String(warning.toString())
          : Error.prototype.toString.call(warning);
    const detail: unknown = Reflect.get(warning, 'detail');
    if (typeof detail === 'string') text += `\n${detail}`;
    if (!trace && !hintShown) {
      hintShown = true;
      const flag = deprecation ? '--trace-deprecation' : '--trace-warnings';
      text += `\n(Use \`node ${flag} ...\` to show where the warning was created)`;
    }
    host.diagnostic(text + '\n');
  }
  if (host.print) process.on('warning', onWarning);

  function createWarning(
    message: string,
    type: string | undefined,
    code: string | undefined,
    ctor: unknown,
    detail: string | undefined,
  ): Error {
    // The frames are captured below, from `ctor` outward; skip them here.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const warning = new Error(message);
    Error.stackTraceLimit = limit;
    warning.name = String(type || 'Warning');
    if (code !== undefined) Object.assign(warning, { code });
    if (detail !== undefined) Object.assign(warning, { detail });
    const limitBy = typeof ctor === 'function' ? ctor : process.emitWarning;
    // Checked callable above; V8 accepts any function as the frame boundary.
    Error.captureStackTrace(
      warning,
      typeof limitBy === 'function' ? (limitBy as (...args: unknown[]) => unknown) : emitWarning,
    );
    return warning;
  }

  // process.emitWarning(error)
  // process.emitWarning(string[, type[, code]][, ctor])
  // process.emitWarning(string[, options])
  function emitWarning(warning: unknown, type?: unknown, code?: unknown, ctor?: unknown): void {
    if (process.noDeprecation && type === 'DeprecationWarning') return;
    let detail: string | undefined;
    if (type !== null && typeof type === 'object' && !Array.isArray(type)) {
      // A non-null, non-array object is read as a property bag, as Node does.
      const options = type as Record<string, unknown>;
      ctor = options.ctor;
      code = options.code;
      if (typeof options.detail === 'string') detail = options.detail;
      type = options.type || 'Warning';
    } else if (typeof type === 'function') {
      ctor = type;
      code = undefined;
      type = 'Warning';
    }
    if (type !== undefined) validateString(type, 'type');
    if (typeof code === 'function') {
      ctor = code;
      code = undefined;
    } else if (code !== undefined) validateString(code, 'code');
    let emitted: Error;
    if (typeof warning === 'string')
      emitted = createWarning(
        warning,
        type as string | undefined,
        code as string | undefined,
        ctor,
        detail,
      );
    else if (warning instanceof Error) emitted = warning;
    else throw invalidArgType('warning', 'of type string or an instance of Error', warning);
    if (emitted.name === 'DeprecationWarning') {
      if (process.noDeprecation) return;
      // Thrown on a later tick, after the warnings emitted before it were printed.
      if (process.throwDeprecation) {
        process.nextTick(() => {
          throw emitted;
        });
        return;
      }
    }
    process.nextTick(() => {
      process.emit('warning', emitted);
    });
  }

  return { emitWarning };
}
