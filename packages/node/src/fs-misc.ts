// Smaller fs operations written over the primitives in fs.ts: mkdtemp, truncate,
// ftruncate, fsync, fdatasync, chown, lchown, fchown, link, readv, writev and openAsBlob. Every call
// goes through the kernel's syscalls and its owner-bit permission policy.
import { Buffer } from 'buffer';
import path from 'path-browserify';
import { invalidArgType, validateInteger, validateObject, validatedPath } from './arg-errors';
import { ERRNO, nodeError } from './fs-errors';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

type Fs = Record<string, (...args: unknown[]) => unknown>;

const NAME_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The `encoding` of Node's getOptions for calls that return a path. */
function pathEncoding(options: unknown): string {
  if (options == null || typeof options === 'function') return 'utf8';
  let encoding: unknown;
  if (typeof options === 'string') encoding = options;
  else if (typeof options === 'object')
    encoding = (options as { encoding?: unknown }).encoding ?? 'utf8';
  else throw invalidArgType('options', 'one of type string or object', options);
  if (encoding !== 'buffer' && !(typeof encoding === 'string' && Buffer.isEncoding(encoding)))
    throw Object.assign(
      new TypeError(
        `The argument 'encoding' is invalid encoding. Received ${
          typeof encoding === 'string' ? `'${encoding}'` : String(encoding)
        }`,
      ),
      { code: 'ERR_INVALID_ARG_VALUE' },
    );
  return encoding as string;
}

export function createMisc(
  fs: Fs,
  /** True when a proper ancestor of the path is a non-directory (ENOTDIR, not ENOENT). */
  throughFile: (target: unknown) => boolean,
  cwd: () => string,
  /** Told when a callback or promise operation starts: Node counts it as loop work. */
  worked: () => void,
) {
  const randomName = () => {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, (byte) => NAME_CHARACTERS[byte % NAME_CHARACTERS.length]).join('');
  };

  // mkdtemp(3): the prefix plus six random characters, created with mode 0700.
  // The asynchronous forms report the name that failed (libuv rewrites the template); the
  // synchronous form reports the template.
  const makeTemporary = (prefix: string, encoding: string, reveal: boolean) => {
    const template = prefix + 'XXXXXX';
    for (let attempt = 0; attempt < 256; attempt++) {
      const name = prefix + randomName();
      try {
        fs.mkdirSync(name, 0o700);
      } catch (error) {
        const code = record(error) ? error.code : undefined;
        if (code === 'EEXIST') continue;
        if (typeof code === 'string' && code in ERRNO)
          throw nodeError(
            code === 'ENOENT' && throughFile(path.resolve(cwd(), name)) ? 'ENOTDIR' : code,
            'mkdtemp',
            reveal ? name : template,
          );
        throw error;
      }
      if (encoding === 'buffer') return Buffer.from(name);
      return encoding === 'utf8' || encoding === 'utf-8'
        ? name
        : Buffer.from(name).toString(encoding as BufferEncoding);
    }
    throw nodeError('EEXIST', 'mkdtemp', template);
  };
  const prepare = (prefix: unknown, options: unknown) => {
    const encoding = pathEncoding(options);
    return { base: String(Buffer.from(validatedPath(prefix, 'prefix'))), encoding };
  };

  function mkdtempSync(prefix: unknown, options?: unknown): string | Buffer {
    const { base, encoding } = prepare(prefix, options);
    return makeTemporary(base, encoding, false);
  }

  function mkdtemp(prefix: unknown, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
    const done = callback as (error: unknown, value?: unknown) => void;
    const { base, encoding } = prepare(prefix, options);
    worked();
    queueMicrotask(() => {
      let created: string | Buffer;
      try {
        created = makeTemporary(base, encoding, true);
      } catch (error) {
        done(error);
        return;
      }
      done(null, created);
    });
  }

  async function mkdtempPromise(prefix: unknown, options?: unknown): Promise<string | Buffer> {
    const { base, encoding } = prepare(prefix, options);
    worked();
    return makeTemporary(base, encoding, true);
  }

  // ---- truncate and ftruncate ---------------------------------------------------

  // The kernel's descriptor truncation, captured before this module replaces the name.
  const rawFtruncate = fs.ftruncateSync;

  /** Node's getValidatedFd. */
  const validatedFd = (fd: unknown): number => {
    if (Object.is(fd, -0)) return 0;
    validateInteger(fd, 'fd', 0, 2147483647);
    return fd as number;
  };
  /** The length of ftruncate: an integer, negative lengths becoming zero. */
  const truncationLength = (len: unknown): number => {
    validateInteger(len, 'len', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    return Math.max(0, len as number);
  };
  const truncateDescriptor = (fd: number, len: number) => {
    // A resident file is as large as its bytes: bound extension as writes are bounded.
    const writeLimit = resourceLimits().filesystem.descriptorWriteBytes;
    if (len > writeLimit)
      throw fault('E2BIG', `Truncation exceeds ${writeLimit} byte limit`, {
        limit: writeLimit,
        actual: len,
      });
    try {
      rawFtruncate(fd, len);
    } catch (error) {
      const code = record(error) ? error.code : undefined;
      if (typeof code === 'string' && code in ERRNO) throw nodeError(code, 'ftruncate');
      throw error;
    }
  };

  function ftruncateSync(fd: unknown, len: unknown = 0): void {
    const descriptor = validatedFd(fd);
    truncateDescriptor(descriptor, truncationLength(len));
  }

  function ftruncate(fd: unknown, len: unknown = 0, callback?: unknown): void {
    if (typeof len === 'function') {
      callback = len;
      len = 0;
    }
    const descriptor = validatedFd(fd);
    const length = truncationLength(len);
    if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
    const done = callback as (error: unknown) => void;
    worked();
    queueMicrotask(() => {
      try {
        truncateDescriptor(descriptor, length);
      } catch (error) {
        done(error);
        return;
      }
      done(null);
    });
  }

  // Opens `target` for reading and writing, truncates it, and closes it, reporting an
  // open failure as Node does (syscall open, the path as given).
  const truncatePath = (target: string | Uint8Array, len: unknown) => {
    const given = String(Buffer.from(target));
    let fd: unknown;
    try {
      fd = fs.openSync(given, 'r+');
    } catch (error) {
      const code = record(error) ? error.code : undefined;
      if (typeof code === 'string' && code in ERRNO)
        throw nodeError(
          code === 'ENOENT' && throughFile(path.resolve(cwd(), given)) ? 'ENOTDIR' : code,
          'open',
          given,
        );
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd) as { mode: number };
      if ((stat.mode & 0o170000) === 0o040000) throw nodeError('EISDIR', 'open', given);
      truncateDescriptor(validatedFd(fd), truncationLength(len));
    } finally {
      fs.closeSync(fd);
    }
  };

  function truncateSync(target: unknown, len?: unknown): void {
    // Truncating by descriptor number is deprecated in Node (DEP0081) and still works.
    if (typeof target === 'number') {
      ftruncateSync(target, len);
      return;
    }
    if (len === undefined) len = 0;
    truncatePath(validatedPath(target, 'path'), len);
  }

  function truncate(target: unknown, len?: unknown, callback?: unknown): void {
    if (typeof target === 'number') {
      ftruncate(target, len as unknown, callback);
      return;
    }
    if (typeof len === 'function') {
      callback = len;
      len = 0;
    } else if (len === undefined) {
      len = 0;
    }
    // The callback form checks the length before it opens anything.
    truncationLength(len);
    if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
    const done = callback as (error: unknown) => void;
    const location = validatedPath(target, 'path');
    worked();
    queueMicrotask(() => {
      try {
        truncatePath(location, len);
      } catch (error) {
        done(error);
        return;
      }
      done(null);
    });
  }

  async function truncatePromise(target: unknown, len: unknown = 0): Promise<void> {
    worked();
    truncatePath(validatedPath(target, 'path'), len);
  }

  // ---- fsync and fdatasync ------------------------------------------------------

  // The filesystem is memory-resident: a write is as durable as it will get when it
  // returns, so there is nothing to flush. The call still checks the descriptor.
  const flushOperation = (syscall: string) => {
    function flushSync(fd: unknown): void {
      const descriptor = validatedFd(fd);
      try {
        fs.fstatSync(descriptor);
      } catch (error) {
        const code = record(error) ? error.code : undefined;
        if (code === 'EBADF') throw nodeError('EBADF', syscall);
        throw error;
      }
    }
    function flush(fd: unknown, callback?: unknown): void {
      const descriptor = validatedFd(fd);
      if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
      const done = callback as (error: unknown) => void;
      worked();
      queueMicrotask(() => {
        try {
          flushSync(descriptor);
        } catch (error) {
          done(error);
          return;
        }
        done(null);
      });
    }
    return { flushSync, flush };
  };
  const fsyncForms = flushOperation('fsync');
  const fdatasyncForms = flushOperation('fdatasync');

  // ---- chown, lchown and fchown -------------------------------------------------

  // The virtual filesystem has a single owner and every process acts as that owner, so
  // keeping the owner (-1, or the current id) is the only change that can be made, as
  // for an unprivileged Node process; giving a file away is EPERM.
  const MAX_ID = 4294967295;
  const validatedOwner = (uid: unknown, gid: unknown) => {
    validateInteger(uid, 'uid', -1, MAX_ID);
    validateInteger(gid, 'gid', -1, MAX_ID);
    return [uid as number, gid as number] as const;
  };
  // -1 and its unsigned form mean "leave unchanged".
  const changes = (wanted: number, current: unknown) =>
    wanted !== -1 && wanted !== MAX_ID && wanted !== current;
  const refuse = (
    syscall: string,
    target: string | undefined,
    owner: readonly [number, number],
    stat: unknown,
  ) => {
    const current = record(stat) ? stat : {};
    if (changes(owner[0], current.uid) || changes(owner[1], current.gid))
      throw nodeError('EPERM', syscall, target);
  };
  const ownerOfPath = (syscall: string, follow: boolean, given: string) => {
    try {
      return fs[follow ? 'statSync' : 'lstatSync'](given);
    } catch (error) {
      const code = record(error) ? error.code : undefined;
      if (typeof code === 'string' && code in ERRNO)
        throw nodeError(
          code === 'ENOENT' && throughFile(path.resolve(cwd(), given)) ? 'ENOTDIR' : code,
          syscall,
          given,
        );
      throw error;
    }
  };
  const ownerOfDescriptor = (syscall: string, fd: number) => {
    try {
      return fs.fstatSync(fd);
    } catch (error) {
      if (record(error) && error.code === 'EBADF') throw nodeError('EBADF', syscall);
      throw error;
    }
  };

  const pathOwnerForms = (syscall: 'chown' | 'lchown') => {
    const follow = syscall === 'chown';
    const change = (location: string | Uint8Array, owner: readonly [number, number]) => {
      const given = String(Buffer.from(location));
      refuse(syscall, given, owner, ownerOfPath(syscall, follow, given));
    };
    const sync = (target: unknown, uid: unknown, gid: unknown): void => {
      const location = validatedPath(target, 'path');
      change(location, validatedOwner(uid, gid));
    };
    const callback = (target: unknown, uid: unknown, gid: unknown, done?: unknown): void => {
      if (typeof done !== 'function') throw invalidArgType('cb', 'of type function', done);
      const location = validatedPath(target, 'path');
      const owner = validatedOwner(uid, gid);
      worked();
      queueMicrotask(() => {
        try {
          change(location, owner);
        } catch (error) {
          done(error);
          return;
        }
        done(null);
      });
    };
    const promise = async (target: unknown, uid: unknown, gid: unknown): Promise<void> => {
      const location = validatedPath(target, 'path');
      const owner = validatedOwner(uid, gid);
      worked();
      change(location, owner);
    };
    return { sync, callback, promise };
  };
  const chownForms = pathOwnerForms('chown');
  const lchownForms = pathOwnerForms('lchown');

  function fchownSync(fd: unknown, uid: unknown, gid: unknown): void {
    const descriptor = validatedFd(fd);
    const owner = validatedOwner(uid, gid);
    refuse('fchown', undefined, owner, ownerOfDescriptor('fchown', descriptor));
  }
  function fchown(fd: unknown, uid: unknown, gid: unknown, callback?: unknown): void {
    const descriptor = validatedFd(fd);
    const owner = validatedOwner(uid, gid);
    if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
    const done = callback as (error: unknown) => void;
    worked();
    queueMicrotask(() => {
      try {
        refuse('fchown', undefined, owner, ownerOfDescriptor('fchown', descriptor));
      } catch (error) {
        done(error);
        return;
      }
      done(null);
    });
  }

  // ---- link ------------------------------------------------------------------------

  // The kernel's hard-link syscall, captured before this module replaces the name.
  const rawLink = fs.linkSync;
  const makeLink = (existing: string | Uint8Array, created: string | Uint8Array) => {
    const from = String(Buffer.from(existing));
    const to = String(Buffer.from(created));
    try {
      // The empty path names nothing; resolving it would name the working directory.
      if (from === '' || to === '')
        throw Object.assign(new Error('empty path'), { code: 'ENOENT' });
      rawLink(from, to);
    } catch (error) {
      const code = record(error) ? error.code : undefined;
      if (typeof code === 'string' && code in ERRNO) throw nodeError(code, 'link', from, to);
      throw error;
    }
  };
  const linkPaths = (existing: unknown, created: unknown) =>
    [validatedPath(existing, 'existingPath'), validatedPath(created, 'newPath')] as const;

  function linkSync(existing: unknown, created: unknown): void {
    makeLink(...linkPaths(existing, created));
  }
  function link(existing: unknown, created: unknown, callback?: unknown): void {
    if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
    const done = callback as (error: unknown) => void;
    const paths = linkPaths(existing, created);
    worked();
    queueMicrotask(() => {
      try {
        makeLink(...paths);
      } catch (error) {
        done(error);
        return;
      }
      done(null);
    });
  }
  async function linkPromise(existing: unknown, created: unknown): Promise<void> {
    const paths = linkPaths(existing, created);
    worked();
    makeLink(...paths);
  }

  // ---- readv and writev ----------------------------------------------------------

  const validatedBuffers = (buffers: unknown): ArrayBufferView[] => {
    if (!Array.isArray(buffers) || !buffers.every((entry) => ArrayBuffer.isView(entry)))
      throw invalidArgType('buffers', 'an ArrayBufferView[]', buffers);
    return buffers as ArrayBufferView[];
  };
  // One vector call as a run of positioned or sequential descriptor calls; a short read
  // ends it, as the kernel's single readv would.
  const vectored = (syscall: 'read' | 'write') => {
    const base = fs[syscall === 'read' ? 'readSync' : 'writeSync'];
    const run = (fd: number, buffers: ArrayBufferView[], position: unknown): number => {
      if (syscall === 'read' && buffers.length === 0) throw nodeError('EINVAL', 'read');
      let total = 0;
      try {
        for (const view of buffers) {
          const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          // Only a non-negative integer is a position; anything else means the cursor.
          const at =
            typeof position === 'number' && Number.isSafeInteger(position) && position >= 0
              ? position + total
              : null;
          const count = Number(base(fd, bytes, 0, bytes.byteLength, at));
          total += count;
          if (count < bytes.byteLength) break;
        }
      } catch (error) {
        const code = record(error) ? error.code : undefined;
        if (typeof code === 'string' && code in ERRNO) throw nodeError(code, syscall);
        throw error;
      }
      return total;
    };
    function sync(fd: unknown, buffers: unknown, position?: unknown): number {
      const descriptor = validatedFd(fd);
      return run(descriptor, validatedBuffers(buffers), position);
    }
    function callback(fd: unknown, buffers: unknown, position?: unknown, done?: unknown): void {
      const descriptor = validatedFd(fd);
      const views = validatedBuffers(buffers);
      const completion = done || position;
      if (typeof completion !== 'function')
        throw invalidArgType('cb', 'of type function', completion);
      const finish = completion as (error: unknown, count: number, buffers: unknown) => void;
      worked();
      queueMicrotask(() => {
        let count: number;
        try {
          count = run(descriptor, views, position);
        } catch (error) {
          finish(error, 0, buffers);
          return;
        }
        finish(null, count, buffers);
      });
    }
    return { sync, callback };
  };
  const readvForms = vectored('read');
  const writevForms = vectored('write');

  // ---- openAsBlob ------------------------------------------------------------------

  // Node's blob is backed by the file and fails with NotReadableError if the file changes
  // later. This runtime reads the file once, when the blob is made.
  function openAsBlob(target: unknown, options: unknown = {}): Promise<Blob> {
    validateObject(options, 'options');
    const type = (options as { type?: unknown }).type || '';
    if (typeof type !== 'string') throw invalidArgType('options.type', 'of type string', type);
    const given = String(Buffer.from(validatedPath(target, 'path')));
    let bytes: Uint8Array;
    try {
      bytes = fs.readFileSync(given) as Uint8Array;
    } catch (error) {
      const code = record(error) ? error.code : undefined;
      if (typeof code === 'string' && code in ERRNO)
        throw Object.assign(new TypeError('Unable to open file as blob'), {
          code: 'ERR_INVALID_ARG_VALUE',
        });
      throw error;
    }
    const blob = new Blob([new Uint8Array(bytes)], { type });
    // The constructor lowercases the type; Node keeps the string it was given.
    Object.defineProperty(blob, 'type', { value: type, configurable: true });
    return Promise.resolve(blob);
  }

  return {
    mkdtempSync,
    mkdtemp,
    truncateSync,
    truncate,
    ftruncateSync,
    ftruncate,
    fsyncSync: fsyncForms.flushSync,
    fsync: fsyncForms.flush,
    fdatasyncSync: fdatasyncForms.flushSync,
    fdatasync: fdatasyncForms.flush,
    chownSync: chownForms.sync,
    chown: chownForms.callback,
    lchownSync: lchownForms.sync,
    lchown: lchownForms.callback,
    fchownSync,
    fchown,
    linkSync,
    link,
    readvSync: readvForms.sync,
    readv: readvForms.callback,
    writevSync: writevForms.sync,
    writev: writevForms.callback,
    openAsBlob,
    promises: {
      link: linkPromise,
      mkdtemp: mkdtempPromise,
      truncate: truncatePromise,
      chown: chownForms.promise,
      lchown: lchownForms.promise,
    },
  };
}
