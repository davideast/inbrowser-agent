import { inspect } from 'util/';

// Node-shaped argument errors for guest-visible APIs, mirroring the messages in
// Node 22.18 lib/internal/errors.js (ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE).
// Guest code receives plain TypeError/RangeError instances with an own `code`, as
// Node throws.

type NodeErrorClass = typeof TypeError | typeof RangeError | typeof Error;

export function nodeError(Class: NodeErrorClass, code: string, message: string) {
  return Object.assign(new Class(message), { code });
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

function formatList(array: string[], type = 'and'): string {
  switch (array.length) {
    case 0:
      return '';
    case 1:
      return array[0];
    case 2:
      return `${array[0]} ${type} ${array[1]}`;
    case 3:
      return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

/** Node's determineSpecificType: the "Received ..." text of argument errors. */
export function determineSpecificType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0)
        return 1 / value === Number.NEGATIVE_INFINITY ? 'type number (-0)' : 'type number (0)';
      return `type number (${value})`;
    case 'boolean':
      return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object': {
      const ctor: unknown = (value as { constructor?: unknown }).constructor;
      if (ctor && 'name' in (ctor as object))
        return `an instance of ${(ctor as { name: string }).name}`;
      return inspect(value, { depth: -1 });
    }
    case 'string': {
      const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return shown.includes("'")
        ? `type string (${JSON.stringify(shown)})`
        : `type string ('${shown}')`;
    }
    default: {
      const text = inspect(value, { colors: false });
      return `type ${typeof value} (${text.length > 28 ? `${text.slice(0, 25)}...` : text})`;
    }
  }
}

export function invalidArgType(name: string, expected: string | string[], actual: unknown) {
  const list = Array.isArray(expected) ? expected : [expected];
  let message = 'The ';
  if (name.endsWith(' argument')) message += `${name} `;
  else message += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  message += 'must be ';
  const types: string[] = [];
  const instances: string[] = [];
  const other: string[] = [];
  for (const value of list) {
    if (kTypes.includes(value)) types.push(value.toLowerCase());
    else if (classRegExp.test(value)) instances.push(value);
    else other.push(value);
  }
  if (instances.length > 0) {
    const position = types.indexOf('object');
    if (position !== -1) {
      types.splice(position, 1);
      instances.push('Object');
    }
  }
  if (types.length > 0) {
    message += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) message += ' or ';
  }
  if (instances.length > 0) {
    message += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) message += ' or ';
  }
  if (other.length > 0) {
    if (other.length > 1) message += `one of ${formatList(other, 'or')}`;
    else {
      if (other[0].toLowerCase() !== other[0]) message += 'an ';
      message += other[0];
    }
  }
  message += `. Received ${determineSpecificType(actual)}`;
  return nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', message);
}

export function invalidArgValue(name: string, value: unknown, reason = 'is invalid') {
  let inspected = inspect(value);
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  const type = name.includes('.') ? 'property' : 'argument';
  return nodeError(
    TypeError,
    'ERR_INVALID_ARG_VALUE',
    `The ${type} '${name}' ${reason}. Received ${inspected}`,
  );
}

function addNumericalSeparator(value: string): string {
  let result = '';
  let i = value.length;
  const start = value[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) result = `_${value.slice(i - 3, i)}${result}`;
  return `${value.slice(0, i)}${result}`;
}

/** ERR_OUT_OF_RANGE: `The value of "name" is out of range. It must be <range>. Received ...`. */
export function outOfRange(name: string, range: string, input: unknown) {
  let received: string;
  if (Number.isInteger(input) && Math.abs(input as number) > 2 ** 32) {
    received = addNumericalSeparator(String(input));
  } else if (typeof input === 'bigint') {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received);
    received += 'n';
  } else {
    received = inspect(input);
  }
  return nodeError(
    RangeError,
    'ERR_OUT_OF_RANGE',
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
  );
}

/** Node's validateObject(value, name). */
export function validateObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value === 'function'
  ) {
    throw invalidArgType(name, 'Object', value);
  }
}

/** Node's validateNumber(value, name, min). */
export function validateNumber(value: unknown, name: string, min?: number): void {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if (min !== undefined && (value < min || Number.isNaN(value)))
    throw outOfRange(name, `>= ${min}`, value);
}

/** Node's validateInteger(value, name, min, max). */
export function validateInteger(
  value: unknown,
  name: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}

/** Node's AbortError (internal/errors): `code` is assigned before `name`. */
export function abortError(message = 'The operation was aborted', ...options: [] | [object]) {
  const error = new Error(message, ...options);
  Object.assign(error, { code: 'ABORT_ERR' });
  Object.assign(error, { name: 'AbortError' });
  return error;
}
