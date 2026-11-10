import type { EventEmitter } from 'events';
import { createOpen } from '../file-handle';
import type { createFs } from '../fs';
import {
  UV_DIRENT_BLOCK,
  UV_DIRENT_CHAR,
  UV_DIRENT_DIR,
  UV_DIRENT_FIFO,
  UV_DIRENT_FILE,
  UV_DIRENT_LINK,
  UV_DIRENT_SOCKET,
  UV_DIRENT_UNKNOWN,
} from '../fs-stats';
import { createPromisesWatch, createWatchFile } from '../fs-watch-file';
import { invalidArgType } from '../process-warning';
import type { Syscalls } from '../protocol';
import { createReadStreamClass } from '../read-stream';
import { fault, record } from '../value-guards';
import { createWatch } from '../watch';
import { createWriteStreamClass } from '../write-stream';

export interface FsBuiltinsDeps {
  fs: ReturnType<typeof createFs>;
  sys: Syscalls;
  port: MessagePort;
  cwd: () => string;
  retain: () => void;
  release: () => void;
  worked: () => void;
  capture?: Parameters<typeof createWatch>[5];
  process?: EventEmitter;
  events?: unknown;
  stream?: unknown;
  setTimeout?: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => unknown;
  clearTimeout?: (timer: unknown) => void;
  setInterval?: (fn: (...args: unknown[]) => void, delay?: unknown, ...args: unknown[]) => unknown;
  clearInterval?: (timer: unknown) => void;
  setImmediate?: (fn: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
}

export function createFsBuiltins({
  fs,
  sys,
  port,
  cwd,
  retain,
  release,
  worked,
  capture,
  setInterval,
  clearInterval,
}: FsBuiltinsDeps) {
  const ReadStream = createReadStreamClass(fs, retain, release);
  const WriteStream = createWriteStreamClass(fs, retain, release);
  const fsConstants = sys.call('fs.constants', []);
  if (
    !record(fsConstants) ||
    !Object.values(fsConstants).every((value) => typeof value === 'number')
  )
    throw fault('EPROTO', 'Invalid filesystem constants');

  const defaultLinuxConstants: Record<string, number> = {
    O_DSYNC: 4096,
    UV_FS_O_FILEMAP: 0,
    UV_DIRENT_UNKNOWN,
    UV_DIRENT_FILE,
    UV_DIRENT_DIR,
    UV_DIRENT_LINK,
    UV_DIRENT_FIFO,
    UV_DIRENT_SOCKET,
    UV_DIRENT_CHAR,
    UV_DIRENT_BLOCK,
  };
  for (const [key, fallback] of Object.entries(defaultLinuxConstants)) {
    if (typeof fsConstants[key] !== 'number') {
      fsConstants[key] = fallback;
    }
  }
  const legacyConstants = { ...fsConstants };

  const numericConstants: Record<string, number> = {};
  for (const [key, value] of Object.entries(fsConstants))
    if (typeof value === 'number') numericConstants[key] = value;

  const watch = createWatch(sys, port, cwd, retain, release, capture);
  fs.watch = watch;
  const { StatWatcher, watchFile, unwatchFile } = createWatchFile(
    (target, opts) => fs.statSync(target, opts),
    cwd,
    retain,
    release,
    setInterval ? (fn, delay) => setInterval(fn, delay) : undefined,
    clearInterval,
  );

  const fsPromises = {
    constants: fsConstants,
    open: createOpen(fs, numericConstants, cwd, worked, (target) =>
      Boolean(fs.throughFile(target)),
    ),
    ...Object.fromEntries(
      [
        'access',
        'mkdir',
        'writeFile',
        'appendFile',
        'copyFile',
        'unlink',
        'symlink',
        'readlink',
        'realpath',
        'chmod',
        'readFile',
        'stat',
        'lstat',
        'rename',
        'readdir',
        'rmdir',
        'rm',
        'utimes',
        'lutimes',
      ].map((name) => [
        name,
        async (...args: unknown[]) => {
          worked();
          return fs[name + 'Sync'](...args);
        },
      ]),
    ),
    lchmod: async (_path: unknown, _mode: unknown) => {
      worked();
      throw Object.assign(new Error('The lchmod() method is not implemented'), {
        code: 'ERR_METHOD_NOT_IMPLEMENTED',
      });
    },
    watch: createPromisesWatch(watch),
    // No capacity model, as for statfsSync: the promise rejects with ENOSYS.
    // The parameter gives Node's arity of 1.
    statfs: async (_path: unknown) => {
      worked();
      throw fault('ENOSYS', 'Virtual filesystem capacity statistics are unavailable');
    },
    ...fs.promiseForms,
    // Unlike opendirSync, the asynchronous forms report the path in their errors.
    opendir: (target: unknown, options?: unknown) =>
      new Promise((resolve, reject) =>
        fs.opendir(target, options, (error: unknown, dir: unknown) =>
          error ? reject(error) : resolve(dir),
        ),
      ),
  };

  const fsModule = {
    ...fs,
    F_OK: numericConstants.F_OK ?? 0,
    R_OK: numericConstants.R_OK ?? 4,
    W_OK: numericConstants.W_OK ?? 2,
    X_OK: numericConstants.X_OK ?? 1,
    promises: fsPromises,
    lchmod: undefined,
    lchmodSync: undefined,
    watchFile,
    unwatchFile,
    StatWatcher,
    // Importable for optional consumers; the virtual filesystem has no disk
    // capacity model from which to report total or available block counts.
    statfsSync: () => {
      throw fault('ENOSYS', 'Virtual filesystem capacity statistics are unavailable');
    },
    // The callback form validates its callback as Node does, then reports the same
    // ENOSYS later, with no result.
    statfs: (path: unknown, ...rest: unknown[]) => {
      const callback = typeof rest[0] === 'function' ? rest[0] : rest[1];
      if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
      worked();
      queueMicrotask(() =>
        callback(fault('ENOSYS', 'Virtual filesystem capacity statistics are unavailable')),
      );
    },
    constants: fsConstants,
    ReadStream,
    createReadStream: (path: unknown, options?: unknown) => new ReadStream(path, options),
    WriteStream,
    createWriteStream: (path: unknown, options?: unknown) => new WriteStream(path, options),
  };

  Object.defineProperties(fsModule, {
    F_OK: {
      value: numericConstants.F_OK ?? 0,
      writable: false,
      enumerable: true,
      configurable: false,
    },
    R_OK: {
      value: numericConstants.R_OK ?? 4,
      writable: false,
      enumerable: true,
      configurable: false,
    },
    W_OK: {
      value: numericConstants.W_OK ?? 2,
      writable: false,
      enumerable: true,
      configurable: false,
    },
    X_OK: {
      value: numericConstants.X_OK ?? 1,
      writable: false,
      enumerable: true,
      configurable: false,
    },
    promises: {
      get: () => fsPromises,
      enumerable: true,
      configurable: true,
    },
  });

  return {
    // Legacy constants exposes the supported virtual filesystem flags. Keep a
    // distinct object, as Node does; OS/crypto constant groups are not added here.
    constants: legacyConstants,
    fs: fsModule,
    'fs/promises': fsPromises,
  };
}
