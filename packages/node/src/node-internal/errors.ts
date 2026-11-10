// Browser-safe port of curated Node.js v22.18.0 `internal/errors` facilities
// required by Wave 1 upstream Node `lib/` modules (`assert`, `util`, `events`).
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import { inspect as fallbackInspect } from 'util/';
import { formatWithOptions as fallbackFormatWithOptions } from '../util-format';
import { lookupUvErrorName, uvErrmapGet, validateSystemErrorCode } from './uv-errmap';

type AnyCallable = (...args: unknown[]) => unknown;
type ErrorCtor = typeof Error | typeof TypeError | typeof RangeError | typeof URIError;
type MessageFactory = string | ((this: object, ...args: unknown[]) => string);

export interface NodeErrorConstructor {
  new (...args: unknown[]): Error & { code: string };
  HideStackFramesError: new (...args: unknown[]) => Error & { code: string };
  TypeError?: NodeErrorConstructor;
  RangeError?: NodeErrorConstructor;
  Error?: NodeErrorConstructor;
}

let registeredInspect: ((value: unknown, options?: Record<string, unknown>) => string) | undefined;
let registeredFormat: ((...args: unknown[]) => string) | undefined;

export function registerErrorInspect(
  inspectFn: (value: unknown, options?: Record<string, unknown>) => string,
  formatFn: (...args: unknown[]) => string,
): void {
  registeredInspect = inspectFn;
  registeredFormat = formatFn;
}

function inspectValue(value: unknown, options?: Record<string, unknown>): string {
  if (registeredInspect) return registeredInspect(value, options);
  return fallbackInspect(value, options);
}

function formatMessage(...args: unknown[]): string {
  if (registeredFormat) return registeredFormat(...args);
  return fallbackFormatWithOptions({}, ...args);
}

export const kIsNodeError = Symbol('kIsNodeError');
export const kEnhanceStackBeforeInspector = Symbol('kEnhanceStackBeforeInspector');

export const overrideStackTrace = new WeakMap<object, (err: Error, frames: unknown[]) => string>();

export function isErrorStackTraceLimitWritable(): boolean {
  try {
    const desc = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
    if (desc === undefined) return Object.isExtensible(Error);
    return Boolean(desc.writable || desc.set !== undefined);
  } catch {
    return false;
  }
}

export class HideStackFramesError extends Error {}

export function hideStackFrames<T extends (...args: never[]) => unknown>(
  fn: T,
): T & { withoutStackTrace: T } {
  const captureStackTrace: unknown = Reflect.get(Error, 'captureStackTrace');

  function wrappedFn(this: unknown, ...args: unknown[]): unknown {
    try {
      // Invariant: `fn` is a callable function passed to `hideStackFrames`.
      return Reflect.apply(fn as unknown as AnyCallable, this, args);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        Boolean(Reflect.get(Error, 'stackTraceLimit')) &&
        typeof captureStackTrace === 'function'
      ) {
        Reflect.apply(captureStackTrace, Error, [error, wrappedFn]);
      }
      throw error;
    }
  }
  // Invariant: `wrappedFn` forwards the exact runtime arguments and return value of `fn`.
  return Object.assign(wrappedFn, { withoutStackTrace: fn }) as unknown as T & {
    withoutStackTrace: T;
  };
}

function countFormatPlaceholders(msg: string): number {
  let count = 0;
  const regex = /%[dfijoOs]/g;
  while (regex.exec(msg) !== null) count++;
  return count;
}

const messages = new Map<string, MessageFactory>();

function buildMessage(key: string, args: unknown[], self: object): string {
  const msg = messages.get(key);
  if (typeof msg === 'function') {
    return Reflect.apply(msg, self, args);
  }
  const template = msg ?? key;
  if (args.length === 0) return template;
  return formatMessage(template, ...args);
}

function setStackTraceLimit(value: number | undefined): void {
  Reflect.set(Error, 'stackTraceLimit', value);
}

function getStackTraceLimit(): number | undefined {
  const raw: unknown = Reflect.get(Error, 'stackTraceLimit');
  return typeof raw === 'number' ? raw : undefined;
}

function makeHideStackFrameSubclass(
  NodeErrClass: new (...args: unknown[]) => Error & { code: string },
  Base: ErrorCtor,
): new (
  ...args: unknown[]
) => Error & { code: string } {
  class HiddenNodeError extends NodeErrClass {
    constructor(...args: unknown[]) {
      if (isErrorStackTraceLimitWritable()) {
        const limit = getStackTraceLimit();
        setStackTraceLimit(0);
        super(...args);
        setStackTraceLimit(limit);
      } else {
        super(...args);
      }
    }

    override get ['constructor'](): ErrorCtor {
      return Base;
    }
  }
  return HiddenNodeError;
}

function makeNodeErrorWithCode(Base: ErrorCtor, key: string): NodeErrorConstructor {
  // Invariant: `ErrorCtor` (`Error`, `TypeError`, `RangeError`) accepts an optional string message.
  const BaseClass = Base as new (message?: string) => Error;
  const msg = messages.get(key);
  const expectedLength = typeof msg !== 'string' ? -1 : countFormatPlaceholders(msg);

  if (expectedLength === 0 && typeof msg === 'string') {
    const fixedMessage = msg;
    class NodeErrorZero extends BaseClass {
      code = key;
      constructor() {
        super(fixedMessage);
      }
      get ['constructor'](): ErrorCtor {
        return Base;
      }
      get [kIsNodeError](): boolean {
        return true;
      }
      override toString(): string {
        return `${this.name} [${key}]: ${this.message}`;
      }
    }
    return Object.assign(NodeErrorZero, {
      HideStackFramesError: makeHideStackFrameSubclass(NodeErrorZero, Base),
    });
  }

  class NodeError extends BaseClass {
    code = key;
    constructor(...args: unknown[]) {
      super();
      const text = buildMessage(key, args, this);
      Object.defineProperty(this, 'message', {
        value: text,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    get ['constructor'](): ErrorCtor {
      return Base;
    }
    get [kIsNodeError](): boolean {
      return true;
    }
    override toString(): string {
      return `${this.name} [${key}]: ${this.message}`;
    }
  }
  return Object.assign(NodeError, {
    HideStackFramesError: makeHideStackFrameSubclass(NodeError, Base),
  });
}

// Invariant: `Object.create(null)` initializes a prototype-free map of error constructors keyed by `ERR_*` code.
export const codes: Record<string, NodeErrorConstructor> = Object.create(null) as Record<
  string,
  NodeErrorConstructor
>;

export function E(
  sym: string,
  val: MessageFactory,
  def: ErrorCtor,
  ...otherClasses: Array<ErrorCtor | typeof HideStackFramesError>
): void {
  messages.set(sym, val);
  const ErrClass = makeNodeErrorWithCode(def, sym);
  for (const clazz of otherClasses) {
    if (clazz !== HideStackFramesError) {
      // Invariant: `clazz !== HideStackFramesError` narrows `clazz` to `ErrorCtor`.
      const Sub = makeNodeErrorWithCode(clazz as ErrorCtor, sym);
      Reflect.set(ErrClass, clazz.name, Sub);
    }
  }
  codes[sym] = ErrClass;
}

export function formatList(array: string[], type = 'and'): string {
  switch (array.length) {
    case 0:
      return '';
    case 1:
      return `${array[0]}`;
    case 2:
      return `${array[0]} ${type} ${array[1]}`;
    case 3:
      return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

export function determineSpecificType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0)
        return 1 / value === Number.NEGATIVE_INFINITY ? 'type number (-0)' : 'type number (0)';
      if (Number.isNaN(value)) return 'type number (NaN)';
      if (value === Number.POSITIVE_INFINITY) return 'type number (Infinity)';
      if (value === Number.NEGATIVE_INFINITY) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean':
      return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object': {
      const ctor: unknown = Reflect.get(value, 'constructor');
      if (ctor && typeof ctor === 'object' && 'name' in ctor) {
        return `an instance of ${String(ctor.name)}`;
      }
      if (typeof ctor === 'function' && 'name' in ctor) {
        return `an instance of ${ctor.name}`;
      }
      return `${inspectValue(value, { depth: -1 })}`;
    }
    case 'string': {
      const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      if (!shown.includes("'")) return `type string ('${shown}')`;
      return `type string (${JSON.stringify(shown)})`;
    }
    default: {
      let inspected = inspectValue(value, { colors: false });
      if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
      return `type ${typeof value} (${inspected})`;
    }
  }
}

function addNumericalSeparator(val: string): string {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    res = `_${val.slice(i - 3, i)}${res}`;
  }
  return `${val.slice(0, i)}${res}`;
}

const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;
const kTypes = [
  'string',
  'function',
  'number',
  'object',
  'Function',
  'Object',
  'boolean',
  'bigint',
  'symbol',
];

E('ERR_AMBIGUOUS_ARGUMENT', 'The "%s" argument is ambiguous. %s', TypeError);
E('ERR_ASSERTION', '%s', Error);
E(
  'ERR_FALSY_VALUE_REJECTION',
  function (this: { reason?: unknown }, reason: unknown) {
    this.reason = reason;
    return 'Promise was rejected with falsy value';
  },
  Error,
  HideStackFramesError,
);
E(
  'ERR_INTERNAL_ASSERTION',
  (message?: unknown) => {
    const suffix =
      'This is caused by either a bug in Node.js ' +
      'or incorrect usage of Node.js internals.\n' +
      'Please open an issue with this stack trace at ' +
      'https://github.com/nodejs/node/issues\n';
    return message === undefined ? suffix : `${String(message)}\n${suffix}`;
  },
  Error,
);
E(
  'ERR_INVALID_ARG_TYPE',
  (name: unknown, expected: unknown, actual: unknown) => {
    const argName = String(name);
    const list = (Array.isArray(expected) ? expected : [expected]).map(String);
    let msg = 'The ';
    if (argName.endsWith(' argument')) {
      msg += `${argName} `;
    } else {
      const kind = argName.includes('.') ? 'property' : 'argument';
      msg += `"${argName}" ${kind} `;
    }
    msg += 'must be ';
    const types: string[] = [];
    const instances: string[] = [];
    const other: string[] = [];
    for (const value of list) {
      if (kTypes.includes(value)) types.push(value.toLowerCase());
      else if (classRegExp.test(value) && value !== 'object') instances.push(value);
      else other.push(value);
    }
    if (instances.length > 0) {
      const pos = types.indexOf('object');
      if (pos !== -1) {
        types.splice(pos, 1);
        instances.push('Object');
      }
    }
    if (types.length > 0) {
      msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
      if (instances.length > 0 || other.length > 0) msg += ' or ';
    }
    if (instances.length > 0) {
      msg += `an instance of ${formatList(instances, 'or')}`;
      if (other.length > 0) messageAddOr();
    }
    function messageAddOr() {
      msg += ' or ';
    }
    if (other.length > 0) {
      if (other.length > 1) {
        msg += `one of ${formatList(other, 'or')}`;
      } else {
        if (other[0].toLowerCase() !== other[0]) msg += 'an ';
        msg += `${other[0]}`;
      }
    }
    msg += `. Received ${determineSpecificType(actual)}`;
    return msg;
  },
  TypeError,
  RangeError,
  HideStackFramesError,
);
E(
  'ERR_INVALID_ARG_VALUE',
  (name: unknown, value: unknown, reason: unknown = 'is invalid') => {
    let inspected = inspectValue(value);
    if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
    const kind = String(name).includes('.') ? 'property' : 'argument';
    return `The ${kind} '${String(name)}' ${String(reason)}. Received ${inspected}`;
  },
  TypeError,
  RangeError,
  HideStackFramesError,
);
E('ERR_INVALID_CURSOR_POS', 'Cannot set cursor row without setting its column', TypeError);
E(
  'ERR_INVALID_MIME_SYNTAX',
  (production: unknown, str: unknown, invalidIndex: unknown) => {
    const idx = invalidIndex !== -1 ? ` at ${String(invalidIndex)}` : '';
    return `The MIME syntax for a ${String(production)} in "${String(str)}" is invalid${idx}`;
  },
  TypeError,
);
E(
  'ERR_INVALID_RETURN_VALUE',
  (input: unknown, name: unknown, value: unknown) =>
    `Expected ${String(input)} to be returned from the "${String(name)}" function but got ${determineSpecificType(value)}.`,
  TypeError,
  RangeError,
);
E('ERR_INVALID_THIS', 'Value of "this" must be of type %s', TypeError, HideStackFramesError);
E('ERR_INVALID_URI', 'URI malformed', URIError);
E(
  'ERR_MISSING_ARGS',
  (...args: unknown[]) => {
    const len = args.length;
    const wrap = (a: unknown) => `"${String(a)}"`;
    const wrapped = args.map((a) => (Array.isArray(a) ? a.map(wrap).join(' or ') : wrap(a)));
    return `The ${formatList(wrapped)} argument${len > 1 ? 's' : ''} must be specified`;
  },
  TypeError,
);
E(
  'ERR_OUT_OF_RANGE',
  (str: unknown, range: unknown, input: unknown, replaceDefaultBoolean: unknown = false) => {
    const msg = replaceDefaultBoolean
      ? String(str)
      : `The value of "${String(str)}" is out of range.`;
    let received: string;
    if (typeof input === 'number' && Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
      received = addNumericalSeparator(String(input));
    } else if (typeof input === 'bigint') {
      received = String(input);
      if (input > 2n ** 32n || input < -(2n ** 32n)) {
        received = addNumericalSeparator(received);
      }
      received += 'n';
    } else {
      received = inspectValue(input);
    }
    return `${msg} It must be ${String(range)}. Received ${received}`;
  },
  RangeError,
  HideStackFramesError,
);
E('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', '%s', TypeError);
E(
  'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
  "Unexpected argument '%s'. This command does not take positional arguments",
  TypeError,
);
E(
  'ERR_PARSE_ARGS_UNKNOWN_OPTION',
  (option: unknown, allowPositionals: unknown) => {
    const optStr = String(option);
    const suggestDashDash = allowPositionals
      ? ". To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- " +
        JSON.stringify(optStr)
      : '';
    return `Unknown option '${optStr}'${suggestDashDash}`;
  },
  TypeError,
);
E(
  'ERR_SOCKET_BAD_PORT',
  (name: unknown, port: unknown, allowZero: unknown = true) => {
    const operator = allowZero ? '>=' : '>';
    return `${String(name)} should be ${operator} 0 and < 65536. Received ${determineSpecificType(port)}.`;
  },
  RangeError,
  HideStackFramesError,
);
E('ERR_UNAVAILABLE_DURING_EXIT', 'Cannot call function in process exit handler', Error);
E(
  'ERR_UNHANDLED_ERROR',
  (err: unknown = undefined) => {
    const msg = 'Unhandled error.';
    if (err === undefined) return msg;
    return `${msg} (${String(err)})`;
  },
  Error,
);
E('ERR_UNKNOWN_ENCODING', 'Unknown encoding: %s', TypeError);
E('ERR_UNKNOWN_SIGNAL', 'Unknown signal: %s', TypeError, HideStackFramesError);
E('ERR_USE_AFTER_CLOSE', '%s was closed', Error);

export { uvErrmapGet };

export function validateSystemErrorNumber(err: unknown): asserts err is number {
  validateSystemErrorCode(
    err,
    (actual) => new codes.ERR_INVALID_ARG_TYPE('err', 'number', actual),
    (actual) => new codes.ERR_OUT_OF_RANGE('err', 'a negative integer', actual),
  );
}

function lookupSystemErrorName(err: unknown): string {
  validateSystemErrorNumber(err);
  return lookupUvErrorName(err);
}

export class AbortError extends Error {
  code: string;
  constructor(message = 'The operation was aborted', options?: ErrorOptions) {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw new codes.ERR_INVALID_ARG_TYPE('options', 'Object', options);
    }
    super(message, options);
    this.code = 'ABORT_ERR';
    this.name = 'AbortError';
  }
}

export class ErrnoException extends Error {
  errno: number;
  code: string;
  syscall: string;
  constructor(err: number, syscall: string, original?: string) {
    const code = lookupSystemErrorName(err);
    const message = original ? `${syscall} ${code} ${original}` : `${syscall} ${code}`;
    super(message);
    this.errno = err;
    this.code = code;
    this.syscall = syscall;
  }
  get ['constructor'](): ErrorConstructor {
    return Error;
  }
}

export class ExceptionWithHostPort extends Error {
  errno: number;
  code: string;
  syscall: string;
  address: string;
  port?: number;
  constructor(err: number, syscall: string, address: string, port?: number, additional?: string) {
    const code = lookupSystemErrorName(err);
    let details = '';
    if (port && port > 0) details = ` ${address}:${port}`;
    else if (address) details = ` ${address}`;
    if (additional) details += ` - Local (${additional})`;
    super(`${syscall} ${code}${details}`);
    this.errno = err;
    this.code = code;
    this.syscall = syscall;
    this.address = address;
    if (port) this.port = port;
  }
  get ['constructor'](): ErrorConstructor {
    return Error;
  }
}

export const genericNodeError = hideStackFrames(function genericNodeError(
  message: string,
  errorProperties: Record<string, unknown>,
): Error {
  const err = new Error(message);
  Object.assign(err, errorProperties);
  return err;
});

let maxStackErrorName: string | undefined;
let maxStackErrorMessage: string | undefined;

export function isStackOverflowError(err: unknown): boolean {
  if (maxStackErrorMessage === undefined) {
    try {
      const overflowStack = (): void => overflowStack();
      overflowStack();
    } catch (probe) {
      if (probe instanceof Error) {
        maxStackErrorMessage = probe.message;
        maxStackErrorName = probe.name;
      }
    }
  }
  return (
    err !== null &&
    typeof err === 'object' &&
    Reflect.get(err, 'name') === maxStackErrorName &&
    Reflect.get(err, 'message') === maxStackErrorMessage
  );
}
