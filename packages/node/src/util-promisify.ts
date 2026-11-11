// util.promisify and util.deprecate after Node.js v22.18.0 lib/internal/util.js
// (Copyright Joyent, Inc. and other Node contributors, MIT license). The `util`
// 0.12 package's versions use a private promisify symbol, warn through
// console.error, and know no codes; these use the registry symbol
// `Symbol.for('nodejs.util.promisify.custom')`, `process.emitWarning`, and warn
// once per code.
import { invalidArgType } from './node-errors';

type Callable = (...args: never[]) => unknown;

interface WarningProcess {
  emitWarning?: unknown;
  noDeprecation?: unknown;
}

// Looked up at each call: guests replace process.emitWarning.
function warn(process: WarningProcess, ...args: unknown[]) {
  Reflect.apply(process.emitWarning as Callable, process, args);
}

export const kCustomPromisifiedSymbol = Symbol.for('nodejs.util.promisify.custom');
// Internal in Node (`customPromisifyArgs`); kept for the runtime's own use.
export const kCustomPromisifyArgsSymbol = Symbol('customPromisifyArgs');

// The bundler may rename declarations; these names are observable.
function named<T extends Callable>(fn: T, name: string): T {
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

function validateFunction(value: unknown, name: string): asserts value is Callable {
  if (typeof value !== 'function') throw invalidArgType(name, 'of type function', value);
}

export function createPromisify(getProcess: () => object) {
  const promisify = named(function promisify(original: unknown) {
    validateFunction(original, 'original');
    const source = original as Callable & Record<symbol, unknown>;
    if (source[kCustomPromisifiedSymbol]) {
      const fn = source[kCustomPromisifiedSymbol];
      validateFunction(fn, 'util.promisify.custom');
      return Object.defineProperty(fn, kCustomPromisifiedSymbol, {
        value: fn,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }

    // Names to build an object from when the callback receives several values.
    const argumentNames = source[kCustomPromisifyArgsSymbol] as string[] | undefined;

    function fn(this: unknown, ...args: unknown[]) {
      return new Promise((resolve, reject) => {
        args.push((err: unknown, ...values: unknown[]) => {
          if (err) return reject(err);
          if (argumentNames !== undefined && values.length > 1) {
            const obj: Record<string, unknown> = {};
            for (let i = 0; i < argumentNames.length; i++) obj[argumentNames[i]] = values[i];
            resolve(obj);
          } else {
            resolve(values[0]);
          }
        });
        if (Reflect.apply(source, this, args) instanceof Promise) {
          warn(
            getProcess() as WarningProcess,
            'Calling promisify on a function that returns a Promise is likely a mistake.',
            'DeprecationWarning',
            'DEP0174',
          );
        }
      });
    }

    Object.setPrototypeOf(fn, Object.getPrototypeOf(source));
    Object.defineProperty(fn, kCustomPromisifiedSymbol, {
      value: fn,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    const descriptors = Object.getOwnPropertyDescriptors(source);
    for (const descriptor of Object.values(descriptors)) Object.setPrototypeOf(descriptor, null);
    return Object.defineProperties(fn, descriptors);
  }, 'promisify');
  Object.defineProperty(promisify, 'custom', {
    value: kCustomPromisifiedSymbol,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return promisify;
}

export function createDeprecate(getProcess: () => object) {
  const codesWarned = new Set<string>();
  // `useEmitSync` is internal; it only counts toward `deprecate.length`.
  return named(function deprecate(
    fn: Callable,
    msg: unknown,
    code?: unknown,
    _useEmitSync?: unknown,
  ) {
    if (code !== undefined && typeof code !== 'string')
      throw invalidArgType('code', 'of type string', code);
    const codeText = code as string | undefined;

    let warned = false;
    function deprecated(this: unknown, ...args: unknown[]) {
      // The guest process; `emitWarning` and `noDeprecation` are read per call.
      const process = getProcess() as WarningProcess;
      if (!process.noDeprecation && !warned) {
        warned = true;
        if (codeText !== undefined) {
          if (!codesWarned.has(codeText)) {
            warn(process, msg, 'DeprecationWarning', codeText, deprecated);
            codesWarned.add(codeText);
          }
        } else {
          warn(process, msg, 'DeprecationWarning', deprecated);
        }
      }
      if (new.target) return Reflect.construct(fn, args, new.target);
      return Reflect.apply(fn, this, args);
    }

    // The wrapper keeps fn's prototype chain.
    Object.setPrototypeOf(deprecated, fn);
    if (fn.prototype) {
      // Assigned, not set as a prototype, so the unwrapped constructor's instances
      // are instances of the wrapper.
      deprecated.prototype = fn.prototype;
    }
    Object.defineProperty(deprecated, 'length', {
      ...Object.getOwnPropertyDescriptor(fn, 'length'),
    });
    return deprecated;
  }, 'deprecate');
}
