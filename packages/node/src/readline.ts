import { record } from './protocol';
export { createInterface, Interface } from './readline-interface';

function invalid(code: string, message: string): never {
  throw Object.assign(new TypeError(message), { code });
}

function validateCallback(callback: unknown) {
  if (callback !== undefined && typeof callback !== 'function')
    invalid('ERR_INVALID_ARG_TYPE', 'callback must be a function');
}

function write(stream: unknown, data: string, callback: unknown) {
  if (stream === null || stream === undefined) {
    if (typeof callback === 'function') queueMicrotask(() => callback(null));
    return true;
  }
  if (!record(stream) || typeof stream.write !== 'function')
    throw new TypeError('stream.write is not a function');
  return stream.write(data, callback);
}

export function cursorTo(stream: unknown, x: unknown, y?: unknown, callback?: unknown) {
  validateCallback(callback);
  if (typeof y === 'function') {
    callback = y;
    y = undefined;
  }
  if (Number.isNaN(x) || Number.isNaN(y))
    invalid('ERR_INVALID_ARG_VALUE', 'Cursor coordinates must not be NaN');
  if (stream == null || (typeof x !== 'number' && typeof y !== 'number'))
    return write(null, '', callback);
  if (typeof x !== 'number') invalid('ERR_INVALID_CURSOR_POS', 'A row requires a column');
  const data = typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`;
  return write(stream, data, callback);
}

export function clearScreenDown(stream: unknown, callback?: unknown) {
  validateCallback(callback);
  return write(stream, '\x1b[0J', callback);
}
