import { Buffer } from 'buffer';
import path from 'path-browserify';
import { received, validateInteger, validatedPath } from './arg-errors';
import { ERRNO, nodeError } from './fs-errors';
import { fault, record } from './protocol';

type Filesystem = Record<string, (...args: unknown[]) => unknown>;

function invalidArgValue(name: string, value: unknown, reason = 'is invalid'): TypeError {
  return Object.assign(
    new TypeError(`The argument '${name}' ${reason}. Received ${received(value)}`),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
}

function closedHandleError(syscall: string): Error {
  return Object.assign(new Error('file closed'), { code: 'EBADF', syscall });
}

function stringToFlags(flags: unknown, constants: Record<string, number>): number {
  if (typeof flags === 'number') {
    validateInteger(flags, 'flags', -2147483648, 2147483647);
    return flags;
  }
  const O_RDONLY = constants.O_RDONLY ?? 0;
  const O_WRONLY = constants.O_WRONLY ?? 1;
  const O_RDWR = constants.O_RDWR ?? 2;
  const O_CREAT = constants.O_CREAT ?? 64;
  const O_EXCL = constants.O_EXCL ?? 128;
  const O_TRUNC = constants.O_TRUNC ?? 512;
  const O_APPEND = constants.O_APPEND ?? 1024;
  const O_SYNC = constants.O_SYNC ?? 0;
  if (flags == null) return O_RDONLY;
  switch (flags) {
    case 'r':
      return O_RDONLY;
    case 'rs':
    case 'sr':
      return O_RDONLY | O_SYNC;
    case 'r+':
      return O_RDWR;
    case 'rs+':
    case 'sr+':
      return O_RDWR | O_SYNC;
    case 'w':
      return O_TRUNC | O_CREAT | O_WRONLY;
    case 'wx':
    case 'xw':
      return O_TRUNC | O_CREAT | O_WRONLY | O_EXCL;
    case 'w+':
      return O_TRUNC | O_CREAT | O_RDWR;
    case 'wx+':
    case 'xw+':
      return O_TRUNC | O_CREAT | O_RDWR | O_EXCL;
    case 'a':
      return O_APPEND | O_CREAT | O_WRONLY;
    case 'ax':
    case 'xa':
      return O_APPEND | O_CREAT | O_WRONLY | O_EXCL;
    case 'as':
    case 'sa':
      return O_APPEND | O_CREAT | O_WRONLY | O_SYNC;
    case 'a+':
      return O_APPEND | O_CREAT | O_RDWR;
    case 'ax+':
    case 'xa+':
      return O_APPEND | O_CREAT | O_RDWR | O_EXCL;
    case 'as+':
    case 'sa+':
      return O_APPEND | O_CREAT | O_RDWR | O_SYNC;
    default:
      throw invalidArgValue('flags', flags);
  }
}

function parseFileMode(value: unknown): number {
  const resolved = value ?? 0o666;
  if (typeof resolved === 'string') {
    if (!/^[0-7]+$/.test(resolved))
      throw invalidArgValue(
        'mode',
        resolved,
        'must be a 32-bit unsigned integer or an octal string',
      );
    const parsed = Number.parseInt(resolved, 8);
    validateInteger(parsed, 'mode', 0, 4294967295);
    return parsed;
  }
  validateInteger(resolved, 'mode', 0, 4294967295);
  if (typeof resolved !== 'number') throw fault('EPROTO', 'Invalid file mode');
  return resolved;
}

/** Promise FileHandle around the process's unified kernel descriptor table. */
export function createOpen(
  fs: Filesystem,
  constants: Record<string, number> = {},
  cwd: () => string = () => '/',
  worked: () => void = () => {},
  throughFile: (target: unknown) => boolean = () => false,
) {
  class FileHandle {
    #fd: number;
    constructor(fd: number) {
      this.#fd = fd;
    }

    get fd() {
      return this.#fd;
    }

    async read(buffer: unknown, offset?: unknown, length?: unknown, position?: unknown) {
      worked();
      if (this.#fd === -1) throw closedHandleError('read');
      const bytesRead = fs.readSync(this.#fd, buffer, offset, length, position);
      return { bytesRead, buffer };
    }

    async truncate(len: unknown = 0): Promise<void> {
      worked();
      if (this.#fd === -1) throw closedHandleError('ftruncate');
      fs.ftruncateSync(this.#fd, len);
    }

    async readv(buffers: unknown, position?: unknown) {
      worked();
      if (this.#fd === -1) throw closedHandleError('readv');
      const bytesRead = fs.readvSync(this.#fd, buffers, position);
      if (typeof bytesRead !== 'number') throw fault('EPROTO', 'Invalid readv count');
      return Object.setPrototypeOf({ bytesRead, buffers }, null);
    }

    async writev(buffers: unknown, position?: unknown) {
      worked();
      if (this.#fd === -1) throw closedHandleError('writev');
      const bytesWritten = fs.writevSync(this.#fd, buffers, position);
      if (typeof bytesWritten !== 'number') throw fault('EPROTO', 'Invalid writev count');
      return Object.setPrototypeOf({ bytesWritten, buffers }, null);
    }

    async close() {
      worked();
      if (this.#fd === -1) return;
      const fd = this.#fd;
      // Invalidate before closing so a recycled descriptor cannot revive this handle.
      this.#fd = -1;
      fs.closeSync(fd);
    }
  }

  return async (target: unknown, flags: unknown = 'r', mode?: unknown) => {
    const validated = validatedPath(target, 'path');
    const flagsNumber = stringToFlags(flags, constants);
    const parsedMode = parseFileMode(mode);
    worked();
    const given = String(Buffer.from(validated));
    if (given === '') throw nodeError('ENOENT', 'open', '');
    let fd: unknown;
    try {
      fd = fs.openSync(given, flagsNumber, parsedMode);
    } catch (error) {
      const code = record(error) ? error.code : undefined;
      if (typeof code === 'string' && code in ERRNO) {
        const effective =
          code === 'ENOENT' && throughFile(path.resolve(cwd(), given)) ? 'ENOTDIR' : code;
        throw nodeError(effective, 'open', given);
      }
      throw error;
    }
    if (typeof fd !== 'number' || !Number.isSafeInteger(fd) || fd < 0)
      throw fault('EPROTO', 'Invalid opened descriptor');
    return new FileHandle(fd);
  };
}
