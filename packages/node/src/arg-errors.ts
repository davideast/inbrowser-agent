// Node-shaped argument errors (lib/internal/errors.js and lib/internal/validators.js)
// shared by the fs APIs that validate in the guest. Guest programs read `code` and
// the message text, so both follow Node 22.18.

import { Buffer } from 'buffer';
import { fileURLToPath } from './file-url';

function inspect(value: unknown): string {
  if (typeof value === 'string')
    return `'${value.length > 28 ? value.slice(0, 25) + '...' : value}'`;
  if (typeof value === 'bigint') return `${value}n`;
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

/** The `Received ...` suffix of Node's argument errors. */
export function received(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (typeof value === 'function') return `function ${value.name}`;
  // A bundled Buffer class can carry a renamed constructor name.
  if (Buffer.isBuffer(value)) return 'an instance of Buffer';
  if (typeof value === 'object') {
    const ctor: unknown = Reflect.get(value, 'constructor');
    return typeof ctor === 'function' && ctor.name
      ? `an instance of ${ctor.name}`
      : 'an instance of Object';
  }
  return `type ${typeof value} (${inspect(value)})`;
}

export function invalidArgType(name: string, expected: string, value: unknown): TypeError {
  const kind = name.includes('.') ? 'property' : 'argument';
  return Object.assign(
    new TypeError(`The "${name}" ${kind} must be ${expected}. Received ${received(value)}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

export function outOfRange(name: string, range: string, value: unknown): RangeError {
  return Object.assign(
    new RangeError(
      `The value of "${name}" is out of range. It must be ${range}. Received ${value}`,
    ),
    { code: 'ERR_OUT_OF_RANGE' },
  );
}

/** validateObject without flags: null, arrays and non-objects are rejected. */
export function validateObject(value: unknown, name: string): void {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw invalidArgType(name, 'of type object', value);
}

export function validateBoolean(value: unknown, name: string): void {
  if (typeof value !== 'boolean') throw invalidArgType(name, 'of type boolean', value);
}

export function validateFunction(value: unknown, name: string): void {
  if (typeof value !== 'function') throw invalidArgType(name, 'of type function', value);
}

export function validateInteger(value: unknown, name: string, min: number, max: number): void {
  if (typeof value !== 'number') throw invalidArgType(name, 'of type number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}

/** Node's getValidatedPath: URLs become paths; strings and Buffers pass through. */
export function validatedPath(value: unknown, name: string): string | Uint8Array {
  const converted = value instanceof URL ? fileURLToPath(value) : value;
  if (typeof converted !== 'string' && !(converted instanceof Uint8Array))
    throw invalidArgType(name, 'of type string or an instance of Buffer or URL', converted);
  if (typeof converted === 'string' && converted.includes('\u0000'))
    throw Object.assign(
      new TypeError(
        `The argument '${name}' must be a string, Uint8Array, or URL without null bytes. Received '${converted.replaceAll('\u0000', '\\x00')}'`,
      ),
      { code: 'ERR_INVALID_ARG_VALUE' },
    );
  return converted;
}
