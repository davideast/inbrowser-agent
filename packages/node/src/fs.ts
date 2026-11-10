import { Buffer } from 'buffer';
import path from 'path-browserify';
import { invalidArgType, validateInteger } from './arg-errors';
import { copyFileMode } from './copy-file-mode';
import { DEFAULT_DESCRIPTOR_READ_LIMIT } from './descriptor-read-limit';
import { createDir } from './dir';
import { fileURLToPath } from './file-url';
import { createCp } from './fs-cp';
import { nodeError } from './fs-errors';
import { createGlob } from './fs-glob';
import { createMisc } from './fs-misc';
import { Dirent, Stats, toStatsInstance } from './fs-stats';
import type { Syscalls } from './protocol';
import { SEEK_SET, fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

export interface FsStdioHooks {
  writeOutput?: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => void;
  onCloseFd?: (fd: number) => void;
}

export function createFs(
  sys: Syscalls,
  cwd: () => string,
  descriptorReadLimit = DEFAULT_DESCRIPTOR_READ_LIMIT,
  /** Told when a callback operation is queued: Node counts it as event loop work. */
  worked: () => void = () => {},
  stdioHooks?: FsStdioHooks,
) {
  const resolve = (p: unknown) =>
    p instanceof URL ? fileURLToPath(p) : typeof p === 'string' ? path.resolve(cwd(), p) : p;
  const unresolvedPath = (value: unknown) => {
    if (value instanceof URL) return fileURLToPath(value);
    // The kernel follows symlinks before interpreting subsequent dot segments.
    // path.resolve here would erase filesystem-significant components.
    return typeof value === 'string' && !path.isAbsolute(value) ? cwd() + '/' + value : value;
  };
  const call = (method: string, args: unknown[]) => sys.call(`fs.${method}`, args);
  // A trailing slash makes lstat and readlink follow a final symlink (the name must be
  // a directory), which path.resolve would erase.
  const keepSlash = (given: unknown, resolved: unknown) =>
    typeof given === 'string' &&
    given.length > 1 &&
    given.endsWith('/') &&
    typeof resolved === 'string' &&
    !resolved.endsWith('/')
      ? resolved + '/'
      : resolved;
  const methods: Record<string, (...args: unknown[]) => unknown> = {};
  const paths: Record<string, number[]> = { renameSync: [0, 1], symlinkSync: [1] };
  for (const name of [
    'writeFileSync',
    'appendFileSync',
    'chmodSync',
    'mkdirSync',
    'readdirSync',
    'renameSync',
    'rmdirSync',
    'rmSync',
    'existsSync',
    'realpathSync',
    'readlinkSync',
    'symlinkSync',
    'openSync',
    'ftruncateSync',
  ]) {
    methods[name] = (...args) => {
      const given = args[0];
      for (const i of paths[name] ?? [0]) args[i] = resolve(args[i]);
      if (name === 'readlinkSync') args[0] = keepSlash(given, args[0]);
      const result = call(name, args);
      return result instanceof Uint8Array ? Buffer.from(result) : result;
    };
  }
  const openDescriptorPaths = new Map<number, string>();
  methods.openSync = (filename, flags = 'r', mode?: unknown) => {
    // Node treats explicit null/undefined modes as 0666. Resolve that default
    // before JSON transport turns undefined array entries into null for memfs.
    const resolvedPath = resolve(filename);
    const fd = call('openSync', [resolvedPath, flags, mode ?? 0o666]);
    if (typeof fd === 'number' && typeof resolvedPath === 'string') {
      openDescriptorPaths.set(fd, resolvedPath);
    }
    return fd;
  };
  methods.accessSync = (filename, mode = 0) => {
    if (typeof mode !== 'number')
      throw Object.assign(new TypeError('Access mode must be a number'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    if (!Number.isInteger(mode) || mode < 0 || mode > 7)
      throw fault('ERR_OUT_OF_RANGE', 'Access mode must be an integer from 0 through 7');
    try {
      if (filename === '') throw fault('ENOENT', 'Access path is empty');
      return call('accessSync', [unresolvedPath(filename), mode]);
    } catch (error) {
      if (record(error))
        Object.assign(error, {
          syscall: 'access',
          path: filename instanceof URL ? fileURLToPath(filename) : filename,
        });
      throw error;
    }
  };
  methods.unlinkSync = (filename) => {
    try {
      if (filename === '')
        throw Object.assign(fault('ENOENT', 'Unlink path is empty'), { syscall: 'unlink' });
      return call('unlinkSync', [unresolvedPath(filename)]);
    } catch (error) {
      if (record(error) && error.syscall === 'unlink')
        error.path = filename instanceof URL ? fileURLToPath(filename) : filename;
      throw error;
    }
  };
  methods.copyFileSync = (source, destination, mode) => {
    // Validate before JSON transport can turn non-finite numbers into null.
    const flags = copyFileMode(mode);
    try {
      if (source === '' || destination === '')
        throw Object.assign(fault('ENOENT', 'Copy path is empty'), { syscall: 'copyfile' });
      return call('copyFileSync', [unresolvedPath(source), unresolvedPath(destination), flags]);
    } catch (error) {
      if (record(error) && error.syscall === 'copyfile') {
        error.path = source instanceof URL ? fileURLToPath(source) : source;
        error.dest = destination instanceof URL ? fileURLToPath(destination) : destination;
      }
      throw error;
    }
  };
  // The raw hard-link syscall; fs-misc validates and reports. Paths keep their dot
  // segments, which follow symbolic links before they are applied.
  methods.linkSync = (existing, created) =>
    call('linkSync', [unresolvedPath(existing), unresolvedPath(created)]);
  // Both entry points resolve against the same canonical virtual filesystem.
  Object.assign(methods.realpathSync, { native: methods.realpathSync });
  methods.readdirSync = (directory, options) => {
    const resolvedDir = resolve(directory);
    const entries = call('readdirSync', [resolvedDir, options]);
    if (!Array.isArray(entries)) throw fault('EPROTO', 'Invalid directory listing');
    if (!record(options) || options.withFileTypes !== true)
      return entries.map((name) => (name instanceof Uint8Array ? Buffer.from(name) : name));
    const parentPath = typeof resolvedDir === 'string' ? resolvedDir : '';
    return entries.map((entry: unknown) => {
      if (
        !record(entry) ||
        typeof entry.mode !== 'number' ||
        !Number.isInteger(entry.mode) ||
        (typeof entry.name !== 'string' && !(entry.name instanceof Uint8Array))
      )
        throw fault('EPROTO', 'Invalid directory entry');
      return new Dirent(entry.name, entry.mode, parentPath);
    });
  };
  // True when a proper ancestor of the path is an existing non-directory, which
  // is the condition under which lstat fails with ENOTDIR.
  const throughFile = (target: unknown) => {
    if (typeof target !== 'string') return false;
    for (
      let parent = path.dirname(target);
      parent !== path.dirname(parent);
      parent = path.dirname(parent)
    ) {
      const stat = call('statSync', [parent, { throwIfNoEntry: false }]);
      if (record(stat) && typeof stat.mode === 'number') return (stat.mode & 0o170000) !== 0o040000;
    }
    return false;
  };
  // Node's key order: errno, code, syscall, path.
  const lstatNotDirectory = (target: unknown) =>
    Object.assign(new Error(`ENOTDIR: not a directory, lstat '${String(target)}'`), {
      errno: -20,
      code: 'ENOTDIR',
      syscall: 'lstat',
      path: target,
    });
  for (const name of ['statSync', 'lstatSync', 'fstatSync']) {
    methods[name] = (...args) => {
      const given = args[0];
      args[0] = resolve(args[0]);
      if (name === 'lstatSync') args[0] = keepSlash(given, args[0]);
      // With { throwIfNoEntry: false } Node 22.18 returns undefined instead of
      // throwing when the entry is missing. statSync also does so for ENOTDIR (a
      // path through a regular file); lstatSync still throws ENOTDIR, as native
      // does. Any other error still throws.
      const noEntry = name !== 'fstatSync' && record(args[1]) && args[1].throwIfNoEntry === false;
      let stat: unknown;
      try {
        stat = call(name, args);
      } catch (error) {
        const code = record(error) ? error.code : undefined;
        // The kernel names a regular file used as a directory; Node's lstat reports it
        // with errno and the path, whatever throwIfNoEntry says.
        if (name === 'lstatSync' && code === 'ENOTDIR') throw lstatNotDirectory(args[0]);
        if (noEntry && (code === 'ENOENT' || (code === 'ENOTDIR' && name === 'statSync')))
          return undefined;
        throw error;
      }
      if (stat == null && noEntry) {
        // memfs answers lstat through a regular file with no entry; Node throws.
        if (name === 'lstatSync' && throughFile(args[0])) throw lstatNotDirectory(args[0]);
        return undefined;
      }
      if (!record(stat) || (typeof stat.mode !== 'number' && typeof stat.mode !== 'bigint'))
        throw fault('EPROTO', 'Invalid stat');
      return toStatsInstance(stat);
    };
  }
  // Node's toUnixTimestamp: seconds from a numeric string, a finite number
  // (negative means now) or a Date. An invalid Date yields NaN, which libuv
  // treats as "omit"; null carries that through JSON transport.
  const seconds = (time: unknown, name: string) => {
    let value: number;
    // Node's `+time == time` holds exactly when the string converts to a number.
    if (typeof time === 'string' && !Number.isNaN(Number(time))) value = Number(time);
    else if (typeof time === 'number' && Number.isFinite(time))
      value = time < 0 ? Date.now() / 1000 : time;
    else if (Object.prototype.toString.call(time) === '[object Date]')
      value = Date.prototype.getTime.call(time) / 1000;
    else
      throw Object.assign(
        new TypeError(`The "${name}" argument must be of type number or an instance of Date`),
        { code: 'ERR_INVALID_ARG_TYPE' },
      );
    if (Number.isNaN(value)) return null;
    // memfs stores a JavaScript Date; Node clamps to what the host filesystem holds.
    if (Math.abs(value) > 8.64e12)
      throw fault('ERR_OUT_OF_RANGE', `The "${name}" time is beyond the supported Date range`);
    return value;
  };
  for (const [name, syscall] of [
    ['utimesSync', 'utime'],
    ['lutimesSync', 'lutime'],
    ['futimesSync', 'futime'],
  ] as const) {
    methods[name] = (target, atime, mtime) => {
      const destination = name === 'futimesSync' ? target : resolve(target);
      const times = [seconds(atime, 'atime'), seconds(mtime, 'mtime')];
      try {
        call(name, [destination, ...times]);
      } catch (error) {
        if (record(error) && typeof error.code === 'string' && !error.code.startsWith('ERR_')) {
          error.syscall = syscall;
          if (name !== 'futimesSync')
            error.path = target instanceof URL ? fileURLToPath(target) : target;
        }
        throw error;
      }
    };
  }
  methods.closeSync = (...args) => {
    const result = call('closeSync', args);
    if (typeof args[0] === 'number') {
      openDescriptorPaths.delete(args[0]);
      stdioHooks?.onCloseFd?.(args[0]);
    }
    return result;
  };
  methods.lseekSync = (fd, offset, whence = SEEK_SET) => call('lseekSync', [fd, offset, whence]);
  const asByteView = (value: unknown): Uint8Array | null =>
    value instanceof Uint8Array
      ? value
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null;
  methods.writeSync = (fd, input, offset, length, position) => {
    const writeLimit = resourceLimits().filesystem.descriptorWriteBytes;
    if (typeof input === 'string') {
      if (typeof length === 'string' && length.toLowerCase() === 'hex' && input.length % 2 !== 0)
        throw Object.assign(
          new TypeError(
            `The argument 'encoding' is invalid for data of length ${input.length}. Received '${length}'`,
          ),
          { code: 'ERR_INVALID_ARG_VALUE' },
        );
      const enc = typeof length === 'string' && Buffer.isEncoding(length) ? length : 'utf8';
      const bytes = Buffer.from(input, enc);
      const strPos =
        typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
      return methods.writeSync(fd, bytes, 0, bytes.byteLength, strPos);
    }
    const view = asByteView(input);
    offset ??= 0;
    if (length === undefined && view !== null && typeof offset === 'number')
      length = view.byteLength - offset;
    if (position === -1) position = null;
    if (
      view === null ||
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + length > view.byteLength ||
      (position != null &&
        (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0))
    )
      throw fault('EINVAL', 'Invalid descriptor write arguments');
    if (length > writeLimit)
      throw fault('E2BIG', `Write exceeds ${writeLimit} byte limit`, {
        limit: writeLimit,
        actual: length,
      });
    let total = 0;
    do {
      const chunk = view.subarray(offset + total, offset + length);
      const count = call('writeSync', [
        fd,
        chunk,
        0,
        chunk.length,
        typeof position === 'number' ? position + total : null,
      ]);
      if (record(count) && (count.outputStream === 'stdout' || count.outputStream === 'stderr')) {
        stdioHooks?.writeOutput?.(count.outputStream, chunk);
        total += chunk.byteLength;
        break;
      }
      if (
        typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < 0 ||
        count > chunk.length
      )
        throw fault('EPROTO', 'Invalid write reply');
      total += count;
      if (count < chunk.length || chunk.length === 0) break;
    } while (total < length);
    return total;
  };
  // Whole-file writes preserve open/write error attribution (`syscall: 'open'`, caller
  // path) and descriptor-position semantics while binary SAB v5 transports full buffers.
  const singleCallBytes = 64 * 1024;
  const wholeFilePayload = (data: unknown, options: unknown, any: boolean): Uint8Array | null => {
    if (typeof data === 'string') {
      // A UTF-16 code unit encodes to at most 3 bytes (hex/base64 decode to fewer).
      if (!any && data.length * 3 <= singleCallBytes) return null;
      const encoding =
        typeof options === 'string'
          ? options
          : record(options) && typeof options.encoding === 'string'
            ? options.encoding
            : 'utf8';
      return Buffer.isEncoding(encoding) ? Buffer.from(data, encoding) : null;
    }
    const view = asByteView(data);
    if (!view || (!any && view.byteLength <= singleCallBytes)) return null;
    return view;
  };
  for (const name of ['writeFileSync', 'appendFileSync'] as const) {
    const singleCall = methods[name];
    methods[name] = (target, data, options) => {
      // Normalize non-Uint8Array ArrayBufferViews (DataView, Uint16Array, etc.) so
      // both <= 64 KiB singleCall frames and > 64 KiB descriptor writes carry raw bytes.
      const normalizedData =
        ArrayBuffer.isView(data) && !(data instanceof Uint8Array)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : data;
      const descriptor = typeof target === 'number';
      const writeLimit = resourceLimits().filesystem.descriptorWriteBytes;
      const bytes = wholeFilePayload(normalizedData, options, true);
      if (!bytes) return singleCall(target, normalizedData, options);
      if (bytes.byteLength > writeLimit)
        throw fault('E2BIG', `Write exceeds ${writeLimit} byte limit`, {
          limit: writeLimit,
          actual: bytes.byteLength,
        });
      if (descriptor) {
        if (bytes.byteLength === 0) {
          methods.writeSync(target, bytes, 0, 0, null);
          return;
        }
        let written = 0;
        while (written < bytes.byteLength) {
          const count = methods.writeSync(target, bytes, written, bytes.byteLength - written, null);
          if (typeof count !== 'number' || count <= 0) throw fault('EIO', 'File write stalled');
          written += count;
        }
        return;
      }
      if (bytes.byteLength <= singleCallBytes) return singleCall(target, normalizedData, options);
      const binaryOptions = record(options)
        ? {
            ...(options.flag !== undefined ? { flag: options.flag } : {}),
            ...(options.mode !== undefined ? { mode: options.mode } : {}),
          }
        : undefined;
      try {
        return singleCall(target, bytes, binaryOptions);
      } catch (error) {
        // Kernel faults carry the code; Node adds the failing open syscall and caller path.
        if (
          record(error) &&
          typeof error.code === 'string' &&
          !error.code.startsWith('ERR_') &&
          error.kind !== 'limit' &&
          !('syscall' in error && error.syscall !== undefined)
        )
          Object.assign(error, {
            syscall: 'open',
            path: target instanceof URL ? fileURLToPath(target) : target,
          });
        throw error;
      }
    };
  }
  methods.readSync = (fd, target, offset, length, position) => {
    const view = asByteView(target);
    offset ??= 0;
    if (length === undefined && view !== null && typeof offset === 'number')
      length = view.byteLength - offset;
    if (position === -1) position = null;
    if (
      view === null ||
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + length > view.byteLength ||
      (position != null &&
        (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0))
    )
      throw fault('EINVAL', 'Invalid descriptor read arguments');
    if (length > descriptorReadLimit)
      throw fault('E2BIG', `Read exceeds ${descriptorReadLimit} byte limit`, {
        limit: descriptorReadLimit,
        actual: length,
      });
    const result = call('readSync', [
      fd,
      null,
      0,
      length,
      typeof position === 'number' ? position : null,
    ]);
    if (
      !record(result) ||
      !(result.buffer instanceof Uint8Array) ||
      typeof result.bytesRead !== 'number' ||
      !Number.isInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > length ||
      result.buffer.length !== result.bytesRead
    )
      throw fault('EPROTO', 'Invalid read reply');
    if (result.bytesRead > 0) view.set(result.buffer, offset);
    return result.bytesRead;
  };
  methods.readFileSync = (filename, options) => {
    if (options != null && typeof options !== 'string' && !record(options))
      throw Object.assign(new TypeError('Invalid readFile options'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    const encoding =
      typeof options === 'string' ? options : record(options) ? options.encoding : null;
    if (encoding != null && (typeof encoding !== 'string' || !Buffer.isEncoding(encoding)))
      throw Object.assign(new TypeError('Unknown encoding'), { code: 'ERR_INVALID_ARG_VALUE' });
    const owned = typeof filename !== 'number';
    const fd = owned
      ? methods.openSync(filename, record(options) ? (options.flag ?? 'r') : 'r')
      : filename;
    try {
      const stat = methods.fstatSync(fd);
      if (!record(stat) || typeof stat.size !== 'number')
        throw fault('EPROTO', 'Invalid file size');
      const limit = resourceLimits().filesystem.fileReadBytes;
      if (stat.size > limit)
        throw fault('E2BIG', `File exceeds ${limit} byte read limit`, {
          limit,
          actual: stat.size,
        });
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const step = Math.max(
          1,
          Math.min(total < stat.size ? stat.size - total : 64 * 1024, descriptorReadLimit),
        );
        const chunk = Buffer.alloc(step);
        const count = methods.readSync(fd, chunk, 0, chunk.length, null);
        if (
          typeof count !== 'number' ||
          !Number.isInteger(count) ||
          count < 0 ||
          count > chunk.length
        )
          throw fault('EPROTO', 'Invalid read length');
        if (!count) break;
        total += count;
        if (total > limit)
          throw fault('E2BIG', `File exceeds ${limit} byte read limit`, {
            limit,
            actual: total,
          });
        chunks.push(count === chunk.length ? chunk : chunk.subarray(0, count));
      }
      const bytes =
        chunks.length === 1 && chunks[0]!.byteLength === total
          ? Buffer.from(chunks[0]!.buffer, chunks[0]!.byteOffset, total)
          : Buffer.concat(chunks, total);
      // isEncoding above validates the optional string before any descriptor is opened.
      return typeof encoding === 'string' && Buffer.isEncoding(encoding)
        ? bytes.toString(encoding)
        : bytes;
    } finally {
      if (owned) methods.closeSync(fd);
    }
  };
  for (const [name, method] of Object.entries({ ...methods })) {
    methods[name.slice(0, -4)] = (...args) => {
      const callback = args.pop();
      if (typeof callback !== 'function') throw fault('EINVAL', 'Callback required');
      worked();
      queueMicrotask(() => {
        let result: unknown;
        try {
          result = method(...args);
        } catch (error) {
          callback(error);
          return;
        }
        if (name === 'readSync') callback(null, result, args[1]);
        else callback(null, result);
      });
    };
  }
  Object.assign(methods.realpath, { native: methods.realpath });

  const parseChmodMode = (mode: unknown): number => {
    if (typeof mode === 'string' && /^[0-7]+$/.test(mode)) {
      return Number.parseInt(mode, 8);
    }
    validateInteger(mode, 'mode', 0, 0o7777);
    // validateInteger narrowed `mode` to an integer in [0, 0o7777].
    return mode as number;
  };
  const validateDescriptor = (fd: unknown): number => {
    if (Object.is(fd, -0)) return 0;
    validateInteger(fd, 'fd', 0, 2147483647);
    // validateInteger narrowed `fd` to an integer in [0, 2147483647].
    return fd as number;
  };
  const applyFchmod = (fd: number, parsedMode: number): void => {
    try {
      methods.fstatSync(fd);
    } catch (error) {
      if (record(error) && error.code === 'EBADF') throw nodeError('EBADF', 'fchmod');
      throw error;
    }
    const targetPath = openDescriptorPaths.get(fd);
    if (targetPath !== undefined) {
      call('chmodSync', [targetPath, parsedMode]);
    }
  };
  methods.fchmodSync = (fd, mode) => {
    const descriptor = validateDescriptor(fd);
    const parsedMode = parseChmodMode(mode);
    applyFchmod(descriptor, parsedMode);
  };
  methods.fchmod = (fd, mode, callback) => {
    const descriptor = validateDescriptor(fd);
    const parsedMode = parseChmodMode(mode);
    if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
    const done = callback as (err: unknown) => void;
    worked();
    queueMicrotask(() => {
      try {
        applyFchmod(descriptor, parsedMode);
      } catch (error) {
        done(error);
        return;
      }
      done(null);
    });
  };
  // Operations written over the primitives above, each a module of its own. Their
  // promise forms are non-enumerable (`promiseForms`): only fs.promises uses them.
  const promiseForms: Record<string, unknown> = {};
  Object.defineProperty(methods, 'promiseForms', { value: promiseForms });
  Object.defineProperty(methods, 'throughFile', { value: throughFile });
  // Recursive copy, ported from Node's lib/internal/fs/cp. The callback form is
  // defined here, not by the loop above, because its filter may be asynchronous.
  const copy = createCp(methods, throughFile, cwd, worked);
  methods.cpSync = copy.cpSync;
  methods.cp = copy.cp;
  promiseForms.cp = copy.cpPromise;
  // Pattern matching, ported from Node's lib/internal/fs/glob.
  const globbing = createGlob(methods, cwd, worked);
  methods.globSync = globbing.globSync;
  methods.glob = globbing.glob;
  promiseForms.glob = globbing.globPromise;
  const misc = createMisc(methods, throughFile, cwd, worked);
  methods.mkdtempSync = misc.mkdtempSync;
  methods.mkdtemp = misc.mkdtemp;
  methods.truncateSync = misc.truncateSync;
  methods.truncate = misc.truncate;
  methods.ftruncateSync = misc.ftruncateSync;
  methods.ftruncate = misc.ftruncate;
  methods.fsyncSync = misc.fsyncSync;
  methods.fsync = misc.fsync;
  methods.fdatasyncSync = misc.fdatasyncSync;
  methods.fdatasync = misc.fdatasync;
  methods.linkSync = misc.linkSync;
  methods.link = misc.link;
  methods.readvSync = misc.readvSync;
  methods.readv = misc.readv;
  methods.writevSync = misc.writevSync;
  methods.writev = misc.writev;
  methods.openAsBlob = misc.openAsBlob;
  for (const name of ['chown', 'lchown', 'fchown']) {
    methods[name + 'Sync'] = misc[(name + 'Sync') as 'chownSync'];
    methods[name] = misc[name as 'chown'];
  }
  Object.assign(promiseForms, misc.promises);
  // Directory handles. Only the synchronous form reports failures without a path.
  const directories = createDir((target, options) => methods.readdirSync(target, options));
  methods.opendirSync = (target, options) => directories.opendir(target, options, false);
  methods.opendir = (target, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    if (typeof done !== 'function')
      throw fault('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function');
    const settings = typeof options === 'function' ? undefined : options;
    worked();
    queueMicrotask(() => {
      let dir: unknown;
      try {
        dir = directories.opendir(target, settings, true);
      } catch (error) {
        done(error);
        return;
      }
      done(null, dir);
    });
  };
  // Invariant: the guest fs module exposes the Dir, Stats, and Dirent classes, as Node does;
  // they are never invoked through this callable-method table.
  methods.Dir = directories.Dir as unknown as (...args: unknown[]) => unknown;
  methods.Stats = Stats as unknown as (...args: unknown[]) => unknown;
  methods.Dirent = Dirent as unknown as (...args: unknown[]) => unknown;
  return methods;
}
