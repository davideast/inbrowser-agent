import path from 'path-browserify';
import * as util from 'util/';
import type { createFs } from './fs';
import {
  SEEK_CUR,
  SEEK_END,
  SEEK_SET,
  type Syscalls,
  decoder,
  encoder,
  fault,
  record,
} from './protocol';

type Fs = ReturnType<typeof createFs>;

export interface WasiHostDeps {
  fs: Fs;
  sys: Syscalls;
  cwd: () => string;
  hrtimeNs: () => bigint;
  exit: (code: number) => never;
  readStdin?: (target: Uint8Array, allowBlock: boolean) => number;
}

/**
 * Checks whether `filename` begins with the 4-byte WebAssembly binary magic
 * header (`\0asm` = `0x00 0x61 0x73 0x6d`) without reading the entire file.
 */
export function isWasmBinary(fs: Fs, filename: string): boolean {
  if (!fs.openSync || !fs.readSync || !fs.closeSync) return false;
  let fd: unknown;
  try {
    fd = fs.openSync(filename, 'r');
  } catch {
    return false;
  }
  if (typeof fd !== 'number') return false;
  try {
    const header = new Uint8Array(4);
    const bytesRead = fs.readSync(fd, header, 0, 4, 0);
    return (
      bytesRead === 4 &&
      header[0] === 0x00 &&
      header[1] === 0x61 &&
      header[2] === 0x73 &&
      header[3] === 0x6d
    );
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort descriptor cleanup.
    }
  }
}

export interface WasiOptions {
  version: 'preview1' | 'unstable';
  args?: string[];
  env?: Record<string, string | undefined>;
  preopens?: Record<string, string>;
  returnOnExit?: boolean;
  stdin?: number;
  stdout?: number;
  stderr?: number;
}

// WASI Preview 1 error numbers (wasi_snapshot_preview1 / uvwasi).
const ESUCCESS = 0;
const E2BIG = 1;
const EACCES = 2;
const EAGAIN = 6;
const EBADF = 8;
const EBUSY = 10;
const EEXIST = 20;
const EFAULT = 21;
const EFBIG = 22;
const EINTR = 27;
const EINVAL = 28;
const EIO = 29;
const EISDIR = 31;
const ELOOP = 32;
const EMFILE = 33;
const EMLINK = 34;
const ENAMETOOLONG = 37;
const ENFILE = 41;
const ENODEV = 43;
const ENOENT = 44;
const ENOSPC = 51;
const ENOSYS = 52;
const ENOTDIR = 54;
const ENOTEMPTY = 55;
const ENOTSOCK = 57;
const ENOTSUP = 58;
const ENOTTY = 59;
const ENXIO = 60;
const EOVERFLOW = 61;
const EPERM = 63;
const EPIPE = 64;
const EROFS = 69;
const ESPIPE = 70;
const ESRCH = 71;
const ETIMEDOUT = 73;
const EXDEV = 75;
const ENOTCAPABLE = 76;

const POSIX_TO_WASI: Record<string, number> = {
  E2BIG,
  EACCES,
  EAGAIN,
  EBADF,
  EBUSY,
  EEXIST,
  EFAULT,
  EFBIG,
  EINTR,
  EINVAL,
  EIO,
  EISDIR,
  ELOOP,
  EMFILE,
  EMLINK,
  ENAMETOOLONG,
  ENFILE,
  ENODEV,
  ENOENT,
  ENOSPC,
  ENOSYS,
  ENOTDIR,
  ENOTEMPTY,
  ENOTSOCK,
  ENOTSUP,
  ENOTTY,
  ENXIO,
  EOVERFLOW,
  EPERM,
  EPIPE,
  EROFS,
  ESPIPE,
  ESRCH,
  ETIMEDOUT,
  EXDEV,
};

// WASI filetypes.
const FILETYPE_UNKNOWN = 0;
const FILETYPE_BLOCK_DEVICE = 1;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const FILETYPE_SOCKET_STREAM = 6;
const FILETYPE_SYMBOLIC_LINK = 7;

// WASI fdflags.
const FDFLAGS_APPEND = 1;
const FDFLAGS_DSYNC = 2;
const FDFLAGS_NONBLOCK = 4;
const FDFLAGS_RSYNC = 8;
const FDFLAGS_SYNC = 16;
const ALL_FDFLAGS =
  FDFLAGS_APPEND | FDFLAGS_DSYNC | FDFLAGS_NONBLOCK | FDFLAGS_RSYNC | FDFLAGS_SYNC;

// WASI oflags.
const OFLAGS_CREAT = 1;
const OFLAGS_DIRECTORY = 2;
const OFLAGS_EXCL = 4;
const OFLAGS_TRUNC = 8;
const ALL_OFLAGS = OFLAGS_CREAT | OFLAGS_DIRECTORY | OFLAGS_EXCL | OFLAGS_TRUNC;

// WASI lookupflags.
const LOOKUP_SYMLINK_FOLLOW = 1;

// WASI fstflags.
const FSTFLAGS_ATIM = 1;
const FSTFLAGS_ATIM_NOW = 2;
const FSTFLAGS_MTIM = 4;
const FSTFLAGS_MTIM_NOW = 8;

// WASI rights.
const RIGHT_FD_DATASYNC = 1n << 0n;
const RIGHT_FD_READ = 1n << 1n;
const RIGHT_FD_SEEK = 1n << 2n;
const RIGHT_FD_FDSTAT_SET_FLAGS = 1n << 3n;
const RIGHT_FD_SYNC = 1n << 4n;
const RIGHT_FD_TELL = 1n << 5n;
const RIGHT_FD_WRITE = 1n << 6n;
const RIGHT_FD_ADVISE = 1n << 7n;
const RIGHT_FD_ALLOCATE = 1n << 8n;
const RIGHT_PATH_CREATE_DIRECTORY = 1n << 9n;
const RIGHT_PATH_CREATE_FILE = 1n << 10n;
const RIGHT_PATH_LINK_SOURCE = 1n << 11n;
const RIGHT_PATH_LINK_TARGET = 1n << 12n;
const RIGHT_PATH_OPEN = 1n << 13n;
const RIGHT_FD_READDIR = 1n << 14n;
const RIGHT_PATH_READLINK = 1n << 15n;
const RIGHT_PATH_RENAME_SOURCE = 1n << 16n;
const RIGHT_PATH_RENAME_TARGET = 1n << 17n;
const RIGHT_PATH_FILESTAT_GET = 1n << 18n;
const RIGHT_PATH_FILESTAT_SET_SIZE = 1n << 19n;
const RIGHT_PATH_FILESTAT_SET_TIMES = 1n << 20n;
const RIGHT_FD_FILESTAT_GET = 1n << 21n;
const RIGHT_FD_FILESTAT_SET_SIZE = 1n << 22n;
const RIGHT_FD_FILESTAT_SET_TIMES = 1n << 23n;
const RIGHT_PATH_SYMLINK = 1n << 24n;
const RIGHT_PATH_REMOVE_DIRECTORY = 1n << 25n;
const RIGHT_PATH_UNLINK_FILE = 1n << 26n;
const RIGHT_POLL_FD_READWRITE = 1n << 27n;

const REGULAR_FILE_RIGHTS_BASE =
  RIGHT_FD_DATASYNC |
  RIGHT_FD_READ |
  RIGHT_FD_SEEK |
  RIGHT_FD_FDSTAT_SET_FLAGS |
  RIGHT_FD_SYNC |
  RIGHT_FD_TELL |
  RIGHT_FD_WRITE |
  RIGHT_FD_ADVISE |
  RIGHT_FD_ALLOCATE |
  RIGHT_FD_FILESTAT_GET |
  RIGHT_FD_FILESTAT_SET_SIZE |
  RIGHT_FD_FILESTAT_SET_TIMES |
  RIGHT_POLL_FD_READWRITE;

const DIRECTORY_RIGHTS_BASE =
  RIGHT_FD_FDSTAT_SET_FLAGS |
  RIGHT_FD_SYNC |
  RIGHT_FD_ADVISE |
  RIGHT_PATH_CREATE_DIRECTORY |
  RIGHT_PATH_CREATE_FILE |
  RIGHT_PATH_LINK_SOURCE |
  RIGHT_PATH_LINK_TARGET |
  RIGHT_PATH_OPEN |
  RIGHT_FD_READDIR |
  RIGHT_PATH_READLINK |
  RIGHT_PATH_RENAME_SOURCE |
  RIGHT_PATH_RENAME_TARGET |
  RIGHT_PATH_FILESTAT_GET |
  RIGHT_PATH_FILESTAT_SET_SIZE |
  RIGHT_PATH_FILESTAT_SET_TIMES |
  RIGHT_FD_FILESTAT_GET |
  RIGHT_FD_FILESTAT_SET_TIMES |
  RIGHT_PATH_SYMLINK |
  RIGHT_PATH_REMOVE_DIRECTORY |
  RIGHT_PATH_UNLINK_FILE |
  RIGHT_POLL_FD_READWRITE;

const DIRECTORY_RIGHTS_INHERITING = DIRECTORY_RIGHTS_BASE | REGULAR_FILE_RIGHTS_BASE;

const PIPE_RIGHTS_BASE =
  RIGHT_FD_READ |
  RIGHT_FD_FDSTAT_SET_FLAGS |
  RIGHT_FD_WRITE |
  RIGHT_FD_FILESTAT_GET |
  RIGHT_POLL_FD_READWRITE;

const MAX_SYMLINK_HOPS = 32;

type WasiDescriptor =
  | {
      kind: 'stdio';
      hostFd: number;
      fdflags: number;
      rightsBase: bigint;
      rightsInheriting: bigint;
    }
  | {
      kind: 'dir';
      preopenName?: string;
      rootPath: string;
      dirPath: string;
      fdflags: number;
      rightsBase: bigint;
      rightsInheriting: bigint;
    }
  | {
      kind: 'file';
      hostFd: number;
      filePath: string;
      fdflags: number;
      rightsBase: bigint;
      rightsInheriting: bigint;
    };

function receivedType(value: unknown): string {
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

function errInvalidArgType(
  name: string,
  kind: 'argument' | 'property',
  expected: string,
  actual: unknown,
): TypeError {
  return Object.assign(
    new TypeError(`The "${name}" ${kind} must be ${expected}. Received ${receivedType(actual)}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

function errInvalidArgValue(name: string, value: unknown, reason: string): TypeError {
  return Object.assign(
    new TypeError(`The property '${name}' ${reason}. Received ${util.inspect(value)}`),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
}

function errOutOfRange(name: string, expected: string, actual: unknown): RangeError {
  return Object.assign(
    new RangeError(
      `The value of "${name}" is out of range. It must be ${expected}. Received ${String(actual)}`,
    ),
    { code: 'ERR_OUT_OF_RANGE' },
  );
}

function errAlreadyStarted(): Error {
  return Object.assign(new Error('WASI instance has already started'), {
    code: 'ERR_WASI_ALREADY_STARTED',
  });
}

function validatePlainObject(
  value: unknown,
  name: string,
  kind: 'argument' | 'property',
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw errInvalidArgType(name, kind, 'of type object', value);
}

function validateNonNegativeInt32(value: unknown, name: string): number {
  if (typeof value !== 'number') throw errInvalidArgType(name, 'property', 'of type number', value);
  if (!Number.isInteger(value)) throw errOutOfRange(name, 'an integer', value);
  if (value < 0 || value > 2147483647) throw errOutOfRange(name, '>= 0 && <= 2147483647', value);
  return value;
}

function mapErrno(error: unknown): number {
  if (record(error) && typeof error.code === 'string') {
    const mapped = POSIX_TO_WASI[error.code];
    if (mapped !== undefined) return mapped;
  }
  return EIO;
}

function toU64(value: unknown): bigint {
  if (typeof value === 'bigint') return BigInt.asUintN(64, value);
  if (typeof value === 'number' && Number.isFinite(value))
    return BigInt.asUintN(64, BigInt(Math.trunc(value)));
  return 0n;
}

function toI64(value: unknown): bigint {
  if (typeof value === 'bigint') return BigInt.asIntN(64, value);
  if (typeof value === 'number' && Number.isFinite(value))
    return BigInt.asIntN(64, BigInt(Math.trunc(value)));
  return 0n;
}

function toU32(value: unknown): number {
  return Number(value) >>> 0;
}

function statFiletype(stat: unknown): number {
  if (!record(stat)) return FILETYPE_UNKNOWN;
  if (typeof stat.isRegularFile === 'function' && stat.isRegularFile())
    return FILETYPE_REGULAR_FILE;
  if (typeof stat.isFile === 'function' && stat.isFile()) return FILETYPE_REGULAR_FILE;
  if (typeof stat.isDirectory === 'function' && stat.isDirectory()) return FILETYPE_DIRECTORY;
  if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink())
    return FILETYPE_SYMBOLIC_LINK;
  if (typeof stat.isCharacterDevice === 'function' && stat.isCharacterDevice())
    return FILETYPE_CHARACTER_DEVICE;
  if (typeof stat.isBlockDevice === 'function' && stat.isBlockDevice())
    return FILETYPE_BLOCK_DEVICE;
  if (typeof stat.isSocket === 'function' && stat.isSocket()) return FILETYPE_SOCKET_STREAM;
  return FILETYPE_UNKNOWN;
}

function isInsideRoot(rootPath: string, candidate: string): boolean {
  if (candidate === rootPath) return true;
  return rootPath === '/' ? candidate.startsWith('/') : candidate.startsWith(rootPath + '/');
}

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  const clamped = Math.min(ms, 2147483647);
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, clamped);
  } catch {
    const end = performance.now() + clamped;
    while (performance.now() < end) {
      // Fallback spin only when Atomics.wait is disallowed on the caller thread.
    }
  }
}

export function createWasiClass(deps: WasiHostDeps) {
  const kExitCode = Symbol('kExitCode');
  const kStarted = Symbol('kStarted');
  const kBindingName = Symbol('kBindingName');

  return class WASI {
    readonly wasiImport: Record<string, (...args: unknown[]) => unknown>;
    [kStarted] = false;
    [kExitCode] = 0;
    [kBindingName]: 'wasi_snapshot_preview1' | 'wasi_unstable';
    #memory: WebAssembly.Memory | undefined;
    #fds = new Map<number, WasiDescriptor>();
    #nextFd = 3;

    constructor(options: unknown = {}) {
      validatePlainObject(options, 'options', 'argument');

      if (typeof options.version !== 'string')
        throw errInvalidArgType('options.version', 'property', 'of type string', options.version);
      if (options.version === 'preview1') {
        this[kBindingName] = 'wasi_snapshot_preview1';
      } else if (options.version === 'unstable') {
        this[kBindingName] = 'wasi_unstable';
      } else {
        throw errInvalidArgValue('options.version', options.version, 'unsupported WASI version');
      }

      if (options.args !== undefined && !Array.isArray(options.args))
        throw errInvalidArgType('options.args', 'property', 'an instance of Array', options.args);
      const args = (Array.isArray(options.args) ? options.args : []).map((item) => String(item));

      const envPairs: string[] = [];
      if (options.env !== undefined) {
        validatePlainObject(options.env, 'options.env', 'property');
        for (const [key, value] of Object.entries(options.env)) {
          if (value !== undefined) envPairs.push(`${key}=${String(value)}`);
        }
      }

      const preopenEntries: Array<[string, string]> = [];
      if (options.preopens !== undefined) {
        validatePlainObject(options.preopens, 'options.preopens', 'property');
        for (const [guestDir, hostDir] of Object.entries(options.preopens)) {
          preopenEntries.push([String(guestDir), String(hostDir)]);
        }
      }

      const stdin =
        options.stdin === undefined ? 0 : validateNonNegativeInt32(options.stdin, 'options.stdin');
      const stdout =
        options.stdout === undefined
          ? 1
          : validateNonNegativeInt32(options.stdout, 'options.stdout');
      const stderr =
        options.stderr === undefined
          ? 2
          : validateNonNegativeInt32(options.stderr, 'options.stderr');

      let returnOnExit = true;
      if (options.returnOnExit !== undefined) {
        if (typeof options.returnOnExit !== 'boolean')
          throw errInvalidArgType(
            'options.returnOnExit',
            'property',
            'of type boolean',
            options.returnOnExit,
          );
        returnOnExit = options.returnOnExit;
      }

      for (const [wasiFd, hostFd] of [
        [0, stdin],
        [1, stdout],
        [2, stderr],
      ] as const) {
        let rightsBase = PIPE_RIGHTS_BASE;
        try {
          const st = deps.fs.fstatSync?.(hostFd);
          if (statFiletype(st) === FILETYPE_REGULAR_FILE) rightsBase = REGULAR_FILE_RIGHTS_BASE;
          else if (statFiletype(st) === FILETYPE_DIRECTORY) rightsBase = DIRECTORY_RIGHTS_BASE;
        } catch {
          // Unopened custom stdio numbers remain registered and fail with EBADF on I/O.
        }
        this.#fds.set(wasiFd, {
          kind: 'stdio',
          hostFd,
          fdflags: 0,
          rightsBase,
          rightsInheriting: 0n,
        });
      }

      for (const [guestName, hostTarget] of preopenEntries) {
        const resolved = path.posix.resolve(deps.cwd(), hostTarget);
        let canonical: string;
        try {
          const st = deps.fs.statSync?.(resolved);
          if (!record(st) || typeof st.isDirectory !== 'function' || !st.isDirectory()) {
            throw Object.assign(new Error('UVWASI_ENOTDIR, uvwasi_init'), {
              code: 'UVWASI_ENOTDIR',
            });
          }
          canonical = String(deps.fs.realpathSync?.(resolved) ?? resolved);
        } catch (error) {
          if (record(error) && typeof error.code === 'string' && error.code.startsWith('UVWASI_'))
            throw error;
          const code = record(error) && typeof error.code === 'string' ? error.code : 'ENOENT';
          throw Object.assign(new Error(`UVWASI_${code}, uvwasi_init`), {
            code: `UVWASI_${code}`,
          });
        }
        const fd = this.#nextFd++;
        this.#fds.set(fd, {
          kind: 'dir',
          preopenName: guestName,
          rootPath: canonical,
          dirPath: canonical,
          fdflags: 0,
          rightsBase: DIRECTORY_RIGHTS_BASE,
          rightsInheriting: DIRECTORY_RIGHTS_INHERITING,
        });
      }

      const encodedArgs = args.map((arg) => encoder.encode(`${arg}\0`));
      const encodedEnv = envPairs.map((pair) => encoder.encode(`${pair}\0`));

      const mem = (): { bytes: Uint8Array; view: DataView } | null => {
        if (!this.#memory) return null;
        const buf = this.#memory.buffer;
        return { bytes: new Uint8Array(buf), view: new DataView(buf) };
      };

      const checkBounds = (bytes: Uint8Array, ptr: number, len: number): boolean =>
        ptr >= 0 && len >= 0 && ptr + len <= bytes.byteLength;

      const isHostFdReferenced = (hostFd: number): boolean => {
        for (const entry of this.#fds.values()) {
          if ((entry.kind === 'file' || entry.kind === 'stdio') && entry.hostFd === hostFd) {
            return true;
          }
        }
        return false;
      };

      const checkedLseek = (hostFd: number, offset: number | bigint, whence: number): bigint => {
        const nextPos = deps.sys.call('lseek', [hostFd, offset, whence]);
        if (typeof nextPos === 'bigint') {
          if (nextPos < 0n) throw fault('EPROTO', 'Invalid negative lseek offset');
          return nextPos;
        }
        if (typeof nextPos !== 'number' || !Number.isSafeInteger(nextPos) || nextPos < 0) {
          throw fault('EPROTO', 'Invalid lseek offset');
        }
        return BigInt(nextPos);
      };

      // Node v22.18.0 src/node_wasi.cc CHECK_BOUNDS_OR_RETURN & setup_iovs
      // return UVWASI_EOVERFLOW (61) for linear-memory pointer/length overflows
      // and pre-validate every iovec before any host readSync/writeSync runs.
      const parseIovs = (
        m: { bytes: Uint8Array; view: DataView },
        iovsPtrRaw: unknown,
        iovsLenRaw: unknown,
        resultPtrRaw: unknown,
        position?: number,
      ):
        | { ok: true; slices: Array<{ ptr: number; len: number }>; resultPtr: number }
        | { ok: false; errno: number } => {
        const iovsPtr = toU32(iovsPtrRaw);
        const iovsLen = toU32(iovsLenRaw);
        const resultPtr = toU32(resultPtrRaw);
        if (!checkBounds(m.bytes, iovsPtr, iovsLen * 8) || !checkBounds(m.bytes, resultPtr, 4))
          return { ok: false, errno: EOVERFLOW };
        const slices: Array<{ ptr: number; len: number }> = [];
        let totalBytes = 0;
        for (let i = 0; i < iovsLen; i++) {
          const bufPtr = m.view.getUint32(iovsPtr + i * 8, true);
          const bufLen = m.view.getUint32(iovsPtr + i * 8 + 4, true);
          if (!checkBounds(m.bytes, bufPtr, bufLen)) return { ok: false, errno: EOVERFLOW };
          totalBytes += bufLen;
          if (totalBytes > 0xffffffff) return { ok: false, errno: EINVAL };
          slices.push({ ptr: bufPtr, len: bufLen });
        }
        if (position !== undefined && !Number.isSafeInteger(position + totalBytes)) {
          return { ok: false, errno: EOVERFLOW };
        }
        return { ok: true, slices, resultPtr };
      };

      const writeFilestat = (
        view: DataView,
        bytes: Uint8Array,
        ptr: number,
        stat: unknown,
      ): number => {
        if (!checkBounds(bytes, ptr, 64)) return EOVERFLOW;
        bytes.fill(0, ptr, ptr + 64);
        if (!record(stat)) return EIO;
        const dev = typeof stat.dev === 'bigint' ? stat.dev : BigInt(Number(stat.dev ?? 0));
        const ino = typeof stat.ino === 'bigint' ? stat.ino : BigInt(Number(stat.ino ?? 0));
        const nlink = typeof stat.nlink === 'bigint' ? stat.nlink : BigInt(Number(stat.nlink ?? 1));
        const size = typeof stat.size === 'bigint' ? stat.size : BigInt(Number(stat.size ?? 0));
        const atim = BigInt(Math.round(Number(stat.atimeMs ?? 0) * 1_000_000));
        const mtim = BigInt(Math.round(Number(stat.mtimeMs ?? 0) * 1_000_000));
        const ctim = BigInt(Math.round(Number(stat.ctimeMs ?? 0) * 1_000_000));
        view.setBigUint64(ptr, BigInt.asUintN(64, dev), true);
        view.setBigUint64(ptr + 8, BigInt.asUintN(64, ino), true);
        view.setUint8(ptr + 16, statFiletype(stat));
        view.setBigUint64(ptr + 24, BigInt.asUintN(64, nlink), true);
        view.setBigUint64(ptr + 32, BigInt.asUintN(64, size), true);
        view.setBigUint64(ptr + 40, BigInt.asUintN(64, atim), true);
        view.setBigUint64(ptr + 48, BigInt.asUintN(64, mtim), true);
        view.setBigUint64(ptr + 56, BigInt.asUintN(64, ctim), true);
        return ESUCCESS;
      };

      const resolveTimes = (
        atimRaw: unknown,
        mtimRaw: unknown,
        fstflagsRaw: unknown,
      ):
        | { ok: true; atime: number | null; mtime: number | null }
        | { ok: false; errno: number } => {
        const flags = toU32(fstflagsRaw);
        if ((flags & ~0x0f) !== 0) return { ok: false, errno: EINVAL };
        const hasAtim = (flags & FSTFLAGS_ATIM) !== 0;
        const hasAtimNow = (flags & FSTFLAGS_ATIM_NOW) !== 0;
        const hasMtim = (flags & FSTFLAGS_MTIM) !== 0;
        const hasMtimNow = (flags & FSTFLAGS_MTIM_NOW) !== 0;
        if ((hasAtim && hasAtimNow) || (hasMtim && hasMtimNow)) return { ok: false, errno: EINVAL };
        const nowSec = Date.now() / 1000;
        const atime = hasAtimNow ? nowSec : hasAtim ? Number(toU64(atimRaw)) / 1_000_000_000 : null;
        const mtime = hasMtimNow ? nowSec : hasMtim ? Number(toU64(mtimRaw)) / 1_000_000_000 : null;
        return { ok: true, atime, mtime };
      };

      const resolveSandboxedPath = (
        fdRaw: unknown,
        pathPtrRaw: unknown,
        pathLenRaw: unknown,
        requiredRight: bigint,
        followFinalSymlink: boolean,
        allowMissingFinal: boolean,
      ):
        | {
            ok: true;
            dir: Extract<WasiDescriptor, { kind: 'dir' }>;
            hostPath: string;
            exists: boolean;
            trailingSlash: boolean;
            isSymlink: boolean;
          }
        | { ok: false; errno: number } => {
        const m = mem();
        if (!m) return { ok: false, errno: EINVAL };
        const fd = toU32(fdRaw);
        const desc = this.#fds.get(fd);
        if (!desc) return { ok: false, errno: EBADF };
        if (desc.kind !== 'dir') return { ok: false, errno: ENOTDIR };
        if ((desc.rightsBase & requiredRight) !== requiredRight)
          return { ok: false, errno: ENOTCAPABLE };

        const pathPtr = toU32(pathPtrRaw);
        const pathLen = toU32(pathLenRaw);
        if (!checkBounds(m.bytes, pathPtr, pathLen)) return { ok: false, errno: EOVERFLOW };
        const rawSlice = m.bytes.subarray(pathPtr, pathPtr + pathLen);
        if (rawSlice.includes(0)) return { ok: false, errno: EINVAL };
        const rawPath = decoder.decode(rawSlice);
        if (rawPath.length === 0) return { ok: false, errno: ENOENT };
        if (rawPath.startsWith('/')) return { ok: false, errno: ENOTCAPABLE };

        const trailingSlash = rawPath.length > 1 && rawPath.endsWith('/');
        const queue = rawPath.split('/').filter((seg) => seg.length > 0 && seg !== '.');
        let current = desc.dirPath;
        let hops = 0;

        if (queue.length === 0) {
          return {
            ok: true,
            dir: desc,
            hostPath: current,
            exists: true,
            trailingSlash,
            isSymlink: false,
          };
        }

        while (queue.length > 0) {
          const segment = queue.shift();
          if (segment === undefined) break;
          if (segment === '..') {
            if (current === desc.rootPath) return { ok: false, errno: ENOTCAPABLE };
            const parent = path.posix.dirname(current);
            if (!isInsideRoot(desc.rootPath, parent)) return { ok: false, errno: ENOTCAPABLE };
            current = parent;
            continue;
          }

          const candidate = path.posix.join(current, segment);
          if (!isInsideRoot(desc.rootPath, candidate)) return { ok: false, errno: ENOTCAPABLE };
          const isLast = queue.length === 0;

          let lstat: unknown;
          try {
            lstat = deps.fs.lstatSync?.(candidate);
          } catch (error) {
            const err = mapErrno(error);
            if (err === ENOENT && isLast && allowMissingFinal) {
              return {
                ok: true,
                dir: desc,
                hostPath: candidate,
                exists: false,
                trailingSlash,
                isSymlink: false,
              };
            }
            return { ok: false, errno: err };
          }

          const isSymlink = statFiletype(lstat) === FILETYPE_SYMBOLIC_LINK;
          if (isSymlink) {
            if (!isLast || followFinalSymlink || trailingSlash) {
              if (++hops > MAX_SYMLINK_HOPS) return { ok: false, errno: ELOOP };
              let linkTarget: string;
              try {
                linkTarget = String(deps.fs.readlinkSync?.(candidate));
              } catch (error) {
                return { ok: false, errno: mapErrno(error) };
              }
              if (linkTarget.startsWith('/')) {
                return { ok: false, errno: ENOTCAPABLE };
              }
              const targetParts = linkTarget
                .split('/')
                .filter((seg) => seg.length > 0 && seg !== '.');
              queue.unshift(...targetParts);
              continue;
            }
            return {
              ok: true,
              dir: desc,
              hostPath: candidate,
              exists: true,
              trailingSlash: false,
              isSymlink: true,
            };
          }

          if (!isLast || trailingSlash) {
            if (statFiletype(lstat) !== FILETYPE_DIRECTORY) return { ok: false, errno: ENOTDIR };
          }
          current = candidate;
        }

        let exists = true;
        try {
          const st = deps.fs.lstatSync?.(current);
          if (trailingSlash && statFiletype(st) !== FILETYPE_DIRECTORY)
            return { ok: false, errno: ENOTDIR };
        } catch (error) {
          const err = mapErrno(error);
          if (err === ENOENT && allowMissingFinal) exists = false;
          else return { ok: false, errno: err };
        }

        return {
          ok: true,
          dir: desc,
          hostPath: current,
          exists,
          trailingSlash,
          isSymlink: false,
        };
      };

      const readTableSizes = (
        entries: Uint8Array[],
        countPtrRaw: unknown,
        sizePtrRaw: unknown,
      ): number => {
        const m = mem();
        if (!m) return EINVAL;
        const countPtr = toU32(countPtrRaw);
        const sizePtr = toU32(sizePtrRaw);
        if (!checkBounds(m.bytes, countPtr, 4) || !checkBounds(m.bytes, sizePtr, 4))
          return EOVERFLOW;
        let total = 0;
        for (const entry of entries) total += entry.byteLength;
        m.view.setUint32(countPtr, entries.length, true);
        m.view.setUint32(sizePtr, total, true);
        return ESUCCESS;
      };

      const readTableValues = (
        entries: Uint8Array[],
        ptrsRaw: unknown,
        bufRaw: unknown,
      ): number => {
        const m = mem();
        if (!m) return EINVAL;
        const ptrs = toU32(ptrsRaw);
        const buf = toU32(bufRaw);
        let total = 0;
        for (const entry of entries) total += entry.byteLength;
        if (!checkBounds(m.bytes, ptrs, entries.length * 4) || !checkBounds(m.bytes, buf, total))
          return EOVERFLOW;
        let cursor = buf;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (!entry) continue;
          m.view.setUint32(ptrs + i * 4, cursor, true);
          m.bytes.set(entry, cursor);
          cursor += entry.byteLength;
        }
        return ESUCCESS;
      };

      this.wasiImport = {
        args_sizes_get: (argcPtr: unknown, argvBufSizePtr: unknown): number =>
          readTableSizes(encodedArgs, argcPtr, argvBufSizePtr),

        args_get: (argvPtr: unknown, argvBufPtr: unknown): number =>
          readTableValues(encodedArgs, argvPtr, argvBufPtr),

        environ_sizes_get: (environCountPtr: unknown, environBufSizePtr: unknown): number =>
          readTableSizes(encodedEnv, environCountPtr, environBufSizePtr),

        environ_get: (environPtr: unknown, environBufPtr: unknown): number =>
          readTableValues(encodedEnv, environPtr, environBufPtr),

        clock_res_get: (clockIdRaw: unknown, resolutionPtrRaw: unknown): number => {
          const m = mem();
          if (!m) return EINVAL;
          const clockId = toU32(clockIdRaw);
          const ptr = toU32(resolutionPtrRaw);
          if (!checkBounds(m.bytes, ptr, 8)) return EOVERFLOW;
          if (clockId > 3) return EINVAL;
          // 1ns nominal resolution for realtime/monotonic/cputime, matching uvwasi.
          m.view.setBigUint64(ptr, 1n, true);
          return ESUCCESS;
        },

        clock_time_get: (
          clockIdRaw: unknown,
          _precisionRaw: unknown,
          timePtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const clockId = toU32(clockIdRaw);
          const ptr = toU32(timePtrRaw);
          if (!checkBounds(m.bytes, ptr, 8)) return EOVERFLOW;
          if (clockId === 0) {
            const nowNs = BigInt(Math.round(Date.now() * 1_000_000));
            m.view.setBigUint64(ptr, BigInt.asUintN(64, nowNs), true);
            return ESUCCESS;
          }
          if (clockId === 1 || clockId === 2 || clockId === 3) {
            m.view.setBigUint64(ptr, BigInt.asUintN(64, deps.hrtimeNs()), true);
            return ESUCCESS;
          }
          return EINVAL;
        },

        fd_advise: (
          fdRaw: unknown,
          offsetRaw: unknown,
          lenRaw: unknown,
          adviceRaw: unknown,
        ): number => {
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if ((desc.rightsBase & RIGHT_FD_ADVISE) === 0n) return ENOTCAPABLE;
          const advice = toU32(adviceRaw);
          if (advice > 5 || toI64(offsetRaw) < 0n || toI64(lenRaw) < 0n) return EINVAL;
          return ESUCCESS;
        },

        fd_allocate: (fdRaw: unknown, offsetRaw: unknown, lenRaw: unknown): number => {
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind !== 'file' && desc.kind !== 'stdio') return EBADF;
          if ((desc.rightsBase & RIGHT_FD_ALLOCATE) === 0n) return ENOTCAPABLE;
          const offset = toI64(offsetRaw);
          const len = toI64(lenRaw);
          if (offset < 0n || len <= 0n) return EINVAL;
          const targetSize = Number(offset + len);
          if (!Number.isSafeInteger(targetSize)) return EOVERFLOW;
          try {
            const st = deps.fs.fstatSync?.(desc.hostFd);
            const curSize = record(st) ? Number(st.size ?? 0) : 0;
            if (targetSize > curSize) deps.fs.ftruncateSync?.(desc.hostFd, targetSize);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        fd_close: (fdRaw: unknown): number => {
          const fd = toU32(fdRaw);
          const desc = this.#fds.get(fd);
          if (!desc) return EBADF;
          this.#fds.delete(fd);
          if ((desc.kind === 'file' || desc.kind === 'stdio') && !isHostFdReferenced(desc.hostFd)) {
            try {
              deps.fs.closeSync?.(desc.hostFd);
            } catch (error) {
              return mapErrno(error);
            }
          }
          return ESUCCESS;
        },

        fd_datasync: (fdRaw: unknown): number => {
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if ((desc.rightsBase & RIGHT_FD_DATASYNC) === 0n) return ENOTCAPABLE;
          if (desc.kind === 'file' || desc.kind === 'stdio') {
            try {
              deps.fs.fdatasyncSync?.(desc.hostFd);
            } catch (error) {
              return mapErrno(error);
            }
          }
          return ESUCCESS;
        },

        fd_fdstat_get: (fdRaw: unknown, bufPtrRaw: unknown): number => {
          const m = mem();
          if (!m) return EINVAL;
          const ptr = toU32(bufPtrRaw);
          if (!checkBounds(m.bytes, ptr, 24)) return EOVERFLOW;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          let filetype = FILETYPE_DIRECTORY;
          if (desc.kind !== 'dir') {
            try {
              filetype = statFiletype(deps.fs.fstatSync?.(desc.hostFd));
            } catch (error) {
              return mapErrno(error);
            }
          }
          m.bytes.fill(0, ptr, ptr + 24);
          m.view.setUint8(ptr, filetype);
          m.view.setUint16(ptr + 2, desc.fdflags, true);
          m.view.setBigUint64(ptr + 8, desc.rightsBase, true);
          m.view.setBigUint64(ptr + 16, desc.rightsInheriting, true);
          return ESUCCESS;
        },

        fd_fdstat_set_flags: (fdRaw: unknown, flagsRaw: unknown): number => {
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if ((desc.rightsBase & RIGHT_FD_FDSTAT_SET_FLAGS) === 0n) return ENOTCAPABLE;
          const flags = toU32(flagsRaw);
          if ((flags & ~ALL_FDFLAGS) !== 0) return EINVAL;
          desc.fdflags = flags;
          return ESUCCESS;
        },

        fd_fdstat_set_rights: (
          fdRaw: unknown,
          rightsBaseRaw: unknown,
          rightsInheritingRaw: unknown,
        ): number => {
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          const nextBase = toU64(rightsBaseRaw);
          const nextInh = toU64(rightsInheritingRaw);
          if ((nextBase & ~desc.rightsBase) !== 0n || (nextInh & ~desc.rightsInheriting) !== 0n)
            return ENOTCAPABLE;
          desc.rightsBase = nextBase;
          desc.rightsInheriting = nextInh;
          return ESUCCESS;
        },

        fd_filestat_get: (fdRaw: unknown, bufPtrRaw: unknown): number => {
          const m = mem();
          if (!m) return EINVAL;
          const ptr = toU32(bufPtrRaw);
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if ((desc.rightsBase & RIGHT_FD_FILESTAT_GET) === 0n) return ENOTCAPABLE;
          try {
            const st =
              desc.kind === 'dir'
                ? deps.fs.statSync?.(desc.dirPath)
                : deps.fs.fstatSync?.(desc.hostFd);
            return writeFilestat(m.view, m.bytes, ptr, st);
          } catch (error) {
            return mapErrno(error);
          }
        },

        fd_filestat_set_size: (fdRaw: unknown, sizeRaw: unknown): number => {
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind === 'dir') return EISDIR;
          if ((desc.rightsBase & RIGHT_FD_FILESTAT_SET_SIZE) === 0n) return ENOTCAPABLE;
          const sizeBig = toI64(sizeRaw);
          if (sizeBig < 0n) return EINVAL;
          const size = Number(sizeBig);
          if (!Number.isSafeInteger(size)) return EOVERFLOW;
          try {
            deps.fs.ftruncateSync?.(desc.hostFd, size);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        fd_filestat_set_times: (
          fdRaw: unknown,
          atimRaw: unknown,
          mtimRaw: unknown,
          fstflagsRaw: unknown,
        ): number => {
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if ((desc.rightsBase & RIGHT_FD_FILESTAT_SET_TIMES) === 0n) return ENOTCAPABLE;
          const parsed = resolveTimes(atimRaw, mtimRaw, fstflagsRaw);
          if (!parsed.ok) return parsed.errno;
          try {
            if (desc.kind === 'dir') {
              deps.fs.utimesSync?.(desc.dirPath, parsed.atime, parsed.mtime);
            } else {
              deps.fs.futimesSync?.(desc.hostFd, parsed.atime, parsed.mtime);
            }
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        fd_pread: (
          fdRaw: unknown,
          iovsPtrRaw: unknown,
          iovsLenRaw: unknown,
          offsetRaw: unknown,
          nreadPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind === 'dir') return EISDIR;
          if (
            (desc.rightsBase & (RIGHT_FD_READ | RIGHT_FD_SEEK)) !==
            (RIGHT_FD_READ | RIGHT_FD_SEEK)
          )
            return ENOTCAPABLE;
          const offsetBig = toI64(offsetRaw);
          if (offsetBig < 0n) return EINVAL;
          let position = Number(offsetBig);
          if (!Number.isSafeInteger(position)) return EOVERFLOW;
          const parsed = parseIovs(m, iovsPtrRaw, iovsLenRaw, nreadPtrRaw, position);
          if (!parsed.ok) return parsed.errno;

          let total = 0;
          try {
            for (const { ptr: bufPtr, len: bufLen } of parsed.slices) {
              if (bufLen === 0) continue;
              const target = m.bytes.subarray(bufPtr, bufPtr + bufLen);
              const count = Number(deps.fs.readSync?.(desc.hostFd, target, 0, bufLen, position));
              total += count;
              position += count;
              if (count < bufLen) break;
            }
            m.view.setUint32(parsed.resultPtr, total, true);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        fd_prestat_get: (fdRaw: unknown, bufPtrRaw: unknown): number => {
          const m = mem();
          if (!m) return EINVAL;
          const ptr = toU32(bufPtrRaw);
          if (!checkBounds(m.bytes, ptr, 8)) return EOVERFLOW;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind !== 'dir' || desc.preopenName === undefined) return EINVAL;
          const nameBytes = encoder.encode(desc.preopenName);
          m.view.setUint8(ptr, 0); // PREOPENTYPE_DIR
          m.view.setUint32(ptr + 4, nameBytes.byteLength, true);
          return ESUCCESS;
        },

        fd_prestat_dir_name: (fdRaw: unknown, pathPtrRaw: unknown, pathLenRaw: unknown): number => {
          const m = mem();
          if (!m) return EINVAL;
          const pathPtr = toU32(pathPtrRaw);
          const pathLen = toU32(pathLenRaw);
          if (!checkBounds(m.bytes, pathPtr, pathLen)) return EOVERFLOW;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind !== 'dir' || desc.preopenName === undefined) return EINVAL;
          const nameBytes = encoder.encode(desc.preopenName);
          const copyLen = Math.min(pathLen, nameBytes.byteLength);
          m.bytes.set(nameBytes.subarray(0, copyLen), pathPtr);
          return pathLen < nameBytes.byteLength ? ENAMETOOLONG : ESUCCESS;
        },

        fd_pwrite: (
          fdRaw: unknown,
          iovsPtrRaw: unknown,
          iovsLenRaw: unknown,
          offsetRaw: unknown,
          nwrittenPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind === 'dir') return EISDIR;
          if (
            (desc.rightsBase & (RIGHT_FD_WRITE | RIGHT_FD_SEEK)) !==
            (RIGHT_FD_WRITE | RIGHT_FD_SEEK)
          )
            return ENOTCAPABLE;
          const offsetBig = toI64(offsetRaw);
          if (offsetBig < 0n) return EINVAL;
          let position = Number(offsetBig);
          if (!Number.isSafeInteger(position)) return EOVERFLOW;
          const parsed = parseIovs(m, iovsPtrRaw, iovsLenRaw, nwrittenPtrRaw, position);
          if (!parsed.ok) return parsed.errno;

          let total = 0;
          try {
            for (const { ptr: bufPtr, len: bufLen } of parsed.slices) {
              if (bufLen === 0) continue;
              const chunk = m.bytes.slice(bufPtr, bufPtr + bufLen);
              const count = Number(deps.fs.writeSync?.(desc.hostFd, chunk, 0, bufLen, position));
              total += count;
              position += count;
              if (count < bufLen) break;
            }
            m.view.setUint32(parsed.resultPtr, total, true);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        fd_read: (
          fdRaw: unknown,
          iovsPtrRaw: unknown,
          iovsLenRaw: unknown,
          nreadPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind === 'dir') return EISDIR;
          if ((desc.rightsBase & RIGHT_FD_READ) === 0n) return ENOTCAPABLE;
          const parsed = parseIovs(m, iovsPtrRaw, iovsLenRaw, nreadPtrRaw);
          if (!parsed.ok) return parsed.errno;

          let total = 0;
          try {
            for (const { ptr: bufPtr, len: bufLen } of parsed.slices) {
              if (bufLen === 0) continue;
              const target = m.bytes.subarray(bufPtr, bufPtr + bufLen);
              const count =
                desc.kind === 'stdio' && desc.hostFd === 0 && deps.readStdin
                  ? deps.readStdin(target, total === 0)
                  : Number(deps.fs.readSync?.(desc.hostFd, target, 0, bufLen, null));
              total += count;
              if (count < bufLen) break;
            }
            m.view.setUint32(parsed.resultPtr, total, true);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        fd_readdir: (
          fdRaw: unknown,
          bufPtrRaw: unknown,
          bufLenRaw: unknown,
          cookieRaw: unknown,
          bufusedPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind !== 'dir') return ENOTDIR;
          if ((desc.rightsBase & RIGHT_FD_READDIR) === 0n) return ENOTCAPABLE;
          const bufPtr = toU32(bufPtrRaw);
          const bufLen = toU32(bufLenRaw);
          const bufusedPtr = toU32(bufusedPtrRaw);
          if (!checkBounds(m.bytes, bufPtr, bufLen) || !checkBounds(m.bytes, bufusedPtr, 4))
            return EOVERFLOW;

          let names: string[];
          try {
            const raw = deps.fs.readdirSync?.(desc.dirPath);
            names = Array.isArray(raw) ? raw.map((item) => String(item)) : [];
          } catch (error) {
            return mapErrno(error);
          }

          const startIndex = Number(toU64(cookieRaw));
          let used = 0;
          for (let index = startIndex; index < names.length; index++) {
            if (used >= bufLen) break;
            const name = names[index];
            if (name === undefined) continue;
            const nameBytes = encoder.encode(name);
            let ino = 0n;
            let dtype = FILETYPE_UNKNOWN;
            try {
              const st = deps.fs.lstatSync?.(path.posix.join(desc.dirPath, name));
              if (record(st)) {
                ino = typeof st.ino === 'bigint' ? st.ino : BigInt(Number(st.ino ?? 0));
                dtype = statFiletype(st);
              }
            } catch {
              // Entry disappeared concurrently; report unknown filetype.
            }

            const entryBytes = new Uint8Array(24 + nameBytes.byteLength);
            const entryView = new DataView(entryBytes.buffer);
            entryView.setBigUint64(0, BigInt(index + 1), true);
            entryView.setBigUint64(8, BigInt.asUintN(64, ino), true);
            entryView.setUint32(16, nameBytes.byteLength, true);
            entryView.setUint8(20, dtype);
            entryBytes.set(nameBytes, 24);

            const copyLen = Math.min(bufLen - used, entryBytes.byteLength);
            m.bytes.set(entryBytes.subarray(0, copyLen), bufPtr + used);
            used += copyLen;
            if (copyLen < entryBytes.byteLength) break;
          }
          m.view.setUint32(bufusedPtr, used, true);
          return ESUCCESS;
        },

        fd_renumber: (fromRaw: unknown, toRaw: unknown): number => {
          const fromFd = toU32(fromRaw);
          const toFd = toU32(toRaw);
          const fromDesc = this.#fds.get(fromFd);
          const toDesc = this.#fds.get(toFd);
          if (!fromDesc || !toDesc) return EBADF;
          if (fromFd === toFd) return ESUCCESS;
          this.#fds.set(toFd, fromDesc);
          this.#fds.delete(fromFd);
          if (
            (toDesc.kind === 'file' || toDesc.kind === 'stdio') &&
            !isHostFdReferenced(toDesc.hostFd)
          ) {
            try {
              deps.fs.closeSync?.(toDesc.hostFd);
            } catch {
              // Ignore close failure on replaced target descriptor.
            }
          }
          return ESUCCESS;
        },

        fd_seek: (
          fdRaw: unknown,
          offsetRaw: unknown,
          whenceRaw: unknown,
          newoffsetPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const newoffsetPtr = toU32(newoffsetPtrRaw);
          if (!checkBounds(m.bytes, newoffsetPtr, 8)) return EOVERFLOW;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind === 'dir') return EBADF;
          if ((desc.rightsBase & RIGHT_FD_SEEK) === 0n) return ENOTCAPABLE;
          const offset = toI64(offsetRaw);
          const whence = toU32(whenceRaw);
          const hostWhence =
            whence === 0 ? SEEK_SET : whence === 1 ? SEEK_CUR : whence === 2 ? SEEK_END : -1;
          if (hostWhence < 0) return EINVAL;
          try {
            const nextPos = checkedLseek(desc.hostFd, offset, hostWhence);
            m.view.setBigUint64(newoffsetPtr, nextPos, true);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        fd_sync: (fdRaw: unknown): number => {
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if ((desc.rightsBase & RIGHT_FD_SYNC) === 0n) return ENOTCAPABLE;
          if (desc.kind === 'file' || desc.kind === 'stdio') {
            try {
              deps.fs.fsyncSync?.(desc.hostFd);
            } catch (error) {
              return mapErrno(error);
            }
          }
          return ESUCCESS;
        },

        fd_tell: (fdRaw: unknown, offsetPtrRaw: unknown): number => {
          const m = mem();
          if (!m) return EINVAL;
          const offsetPtr = toU32(offsetPtrRaw);
          if (!checkBounds(m.bytes, offsetPtr, 8)) return EOVERFLOW;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind === 'dir') return EBADF;
          if ((desc.rightsBase & RIGHT_FD_TELL) === 0n) return ENOTCAPABLE;
          try {
            const pos = checkedLseek(desc.hostFd, 0, SEEK_CUR);
            m.view.setBigUint64(offsetPtr, pos, true);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        fd_write: (
          fdRaw: unknown,
          iovsPtrRaw: unknown,
          iovsLenRaw: unknown,
          nwrittenPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const desc = this.#fds.get(toU32(fdRaw));
          if (!desc) return EBADF;
          if (desc.kind === 'dir') return EISDIR;
          if ((desc.rightsBase & RIGHT_FD_WRITE) === 0n) return ENOTCAPABLE;
          const parsed = parseIovs(m, iovsPtrRaw, iovsLenRaw, nwrittenPtrRaw);
          if (!parsed.ok) return parsed.errno;

          let total = 0;
          try {
            const append = (desc.fdflags & FDFLAGS_APPEND) !== 0;
            for (const { ptr: bufPtr, len: bufLen } of parsed.slices) {
              if (bufLen === 0) continue;
              if (append && desc.kind === 'file') {
                checkedLseek(desc.hostFd, 0, SEEK_END);
              }
              const chunk = m.bytes.slice(bufPtr, bufPtr + bufLen);
              const count = Number(deps.fs.writeSync?.(desc.hostFd, chunk, 0, bufLen, null));
              total += count;
              if (count < bufLen) break;
            }
            if (parsed.slices.length === 0 || total === 0) {
              // Validate underlying host descriptor even on a 0-byte write.
              deps.fs.fstatSync?.(desc.hostFd);
            }
            m.view.setUint32(parsed.resultPtr, total, true);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_create_directory: (
          fdRaw: unknown,
          pathPtrRaw: unknown,
          pathLenRaw: unknown,
        ): number => {
          const resolved = resolveSandboxedPath(
            fdRaw,
            pathPtrRaw,
            pathLenRaw,
            RIGHT_PATH_CREATE_DIRECTORY,
            false,
            true,
          );
          if (!resolved.ok) return resolved.errno;
          if (resolved.exists) return EEXIST;
          try {
            deps.fs.mkdirSync?.(resolved.hostPath);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_filestat_get: (
          fdRaw: unknown,
          flagsRaw: unknown,
          pathPtrRaw: unknown,
          pathLenRaw: unknown,
          bufPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const follow = (toU32(flagsRaw) & LOOKUP_SYMLINK_FOLLOW) !== 0;
          const resolved = resolveSandboxedPath(
            fdRaw,
            pathPtrRaw,
            pathLenRaw,
            RIGHT_PATH_FILESTAT_GET,
            follow,
            false,
          );
          if (!resolved.ok) return resolved.errno;
          try {
            const st = follow
              ? deps.fs.statSync?.(resolved.hostPath)
              : deps.fs.lstatSync?.(resolved.hostPath);
            return writeFilestat(m.view, m.bytes, toU32(bufPtrRaw), st);
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_filestat_set_times: (
          fdRaw: unknown,
          flagsRaw: unknown,
          pathPtrRaw: unknown,
          pathLenRaw: unknown,
          atimRaw: unknown,
          mtimRaw: unknown,
          fstflagsRaw: unknown,
        ): number => {
          const parsed = resolveTimes(atimRaw, mtimRaw, fstflagsRaw);
          if (!parsed.ok) return parsed.errno;
          const follow = (toU32(flagsRaw) & LOOKUP_SYMLINK_FOLLOW) !== 0;
          const resolved = resolveSandboxedPath(
            fdRaw,
            pathPtrRaw,
            pathLenRaw,
            RIGHT_PATH_FILESTAT_SET_TIMES,
            follow,
            false,
          );
          if (!resolved.ok) return resolved.errno;
          try {
            if (follow) {
              deps.fs.utimesSync?.(resolved.hostPath, parsed.atime, parsed.mtime);
            } else {
              deps.fs.lutimesSync?.(resolved.hostPath, parsed.atime, parsed.mtime);
            }
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_link: (
          oldFdRaw: unknown,
          oldFlagsRaw: unknown,
          oldPathPtrRaw: unknown,
          oldPathLenRaw: unknown,
          newFdRaw: unknown,
          newPathPtrRaw: unknown,
          newPathLenRaw: unknown,
        ): number => {
          const follow = (toU32(oldFlagsRaw) & LOOKUP_SYMLINK_FOLLOW) !== 0;
          const oldRes = resolveSandboxedPath(
            oldFdRaw,
            oldPathPtrRaw,
            oldPathLenRaw,
            RIGHT_PATH_LINK_SOURCE,
            follow,
            false,
          );
          if (!oldRes.ok) return oldRes.errno;
          const newRes = resolveSandboxedPath(
            newFdRaw,
            newPathPtrRaw,
            newPathLenRaw,
            RIGHT_PATH_LINK_TARGET,
            false,
            true,
          );
          if (!newRes.ok) return newRes.errno;
          if (newRes.trailingSlash) return EINVAL;
          if (newRes.exists) return EEXIST;
          try {
            deps.fs.linkSync?.(oldRes.hostPath, newRes.hostPath);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_open: (
          dirfdRaw: unknown,
          dirflagsRaw: unknown,
          pathPtrRaw: unknown,
          pathLenRaw: unknown,
          oflagsRaw: unknown,
          fsRightsBaseRaw: unknown,
          fsRightsInheritingRaw: unknown,
          fdflagsRaw: unknown,
          openedFdPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const openedFdPtr = toU32(openedFdPtrRaw);
          if (!checkBounds(m.bytes, openedFdPtr, 4)) return EOVERFLOW;

          const oflags = toU32(oflagsRaw);
          const fdflags = toU32(fdflagsRaw);
          if ((oflags & ~ALL_OFLAGS) !== 0 || (fdflags & ~ALL_FDFLAGS) !== 0) return EINVAL;
          if (
            (oflags & OFLAGS_DIRECTORY) !== 0 &&
            (oflags & (OFLAGS_CREAT | OFLAGS_EXCL | OFLAGS_TRUNC)) !== 0
          )
            return EINVAL;

          const dirDesc = this.#fds.get(toU32(dirfdRaw));
          if (!dirDesc) return EBADF;
          if (dirDesc.kind !== 'dir') return ENOTDIR;

          const rightsBase = toU64(fsRightsBaseRaw);
          const rightsInheriting = toU64(fsRightsInheritingRaw);
          let neededDirRights = RIGHT_PATH_OPEN;
          if ((oflags & OFLAGS_CREAT) !== 0) neededDirRights |= RIGHT_PATH_CREATE_FILE;
          if ((oflags & OFLAGS_TRUNC) !== 0) neededDirRights |= RIGHT_PATH_FILESTAT_SET_SIZE;

          if ((dirDesc.rightsBase & neededDirRights) !== neededDirRights) return ENOTCAPABLE;
          if (
            (rightsBase & ~dirDesc.rightsInheriting) !== 0n ||
            (rightsInheriting & ~dirDesc.rightsInheriting) !== 0n
          )
            return ENOTCAPABLE;

          const follow = (toU32(dirflagsRaw) & LOOKUP_SYMLINK_FOLLOW) !== 0;
          const resolved = resolveSandboxedPath(
            dirfdRaw,
            pathPtrRaw,
            pathLenRaw,
            neededDirRights,
            follow,
            (oflags & OFLAGS_CREAT) !== 0,
          );
          if (!resolved.ok) return resolved.errno;
          if (resolved.isSymlink && !follow) return ELOOP;

          if (resolved.exists) {
            if ((oflags & (OFLAGS_CREAT | OFLAGS_EXCL)) === (OFLAGS_CREAT | OFLAGS_EXCL))
              return EEXIST;
            try {
              const st = deps.fs.statSync?.(resolved.hostPath);
              const ftype = statFiletype(st);
              if (ftype === FILETYPE_DIRECTORY) {
                if (
                  (oflags & (OFLAGS_CREAT | OFLAGS_TRUNC)) !== 0 ||
                  (rightsBase &
                    (RIGHT_FD_WRITE | RIGHT_FD_ALLOCATE | RIGHT_FD_FILESTAT_SET_SIZE)) !==
                    0n
                )
                  return EISDIR;
                const newFd = this.#nextFd++;
                this.#fds.set(newFd, {
                  kind: 'dir',
                  rootPath: resolved.hostPath,
                  dirPath: resolved.hostPath,
                  fdflags,
                  rightsBase: rightsBase & DIRECTORY_RIGHTS_BASE,
                  rightsInheriting,
                });
                m.view.setUint32(openedFdPtr, newFd, true);
                return ESUCCESS;
              }
              if ((oflags & OFLAGS_DIRECTORY) !== 0 || resolved.trailingSlash) return ENOTDIR;
            } catch (error) {
              return mapErrno(error);
            }
          } else if ((oflags & OFLAGS_DIRECTORY) !== 0 || resolved.trailingSlash) {
            return ENOENT;
          }

          const c: Record<string, unknown> = record(deps.fs.constants) ? deps.fs.constants : {};
          const oRdonly = typeof c.O_RDONLY === 'number' ? c.O_RDONLY : 0;
          const oWronly = typeof c.O_WRONLY === 'number' ? c.O_WRONLY : 1;
          const oRdwr = typeof c.O_RDWR === 'number' ? c.O_RDWR : 2;
          const oCreat = typeof c.O_CREAT === 'number' ? c.O_CREAT : 64;
          const oExcl = typeof c.O_EXCL === 'number' ? c.O_EXCL : 128;
          const oTrunc = typeof c.O_TRUNC === 'number' ? c.O_TRUNC : 512;
          const oAppend = typeof c.O_APPEND === 'number' ? c.O_APPEND : 1024;

          const wantsRead = (rightsBase & (RIGHT_FD_READ | RIGHT_FD_READDIR)) !== 0n;
          const wantsWrite =
            (rightsBase & (RIGHT_FD_WRITE | RIGHT_FD_ALLOCATE | RIGHT_FD_FILESTAT_SET_SIZE)) !==
              0n || (oflags & (OFLAGS_CREAT | OFLAGS_TRUNC)) !== 0;

          let hostFlags = wantsRead && wantsWrite ? oRdwr : wantsWrite ? oWronly : oRdonly;
          if ((oflags & OFLAGS_CREAT) !== 0) hostFlags |= oCreat;
          if ((oflags & OFLAGS_EXCL) !== 0) hostFlags |= oExcl;
          if ((oflags & OFLAGS_TRUNC) !== 0) hostFlags |= oTrunc;
          if ((fdflags & FDFLAGS_APPEND) !== 0) hostFlags |= oAppend;

          try {
            const rawHostFd = deps.fs.openSync?.(resolved.hostPath, hostFlags, 0o666);
            if (typeof rawHostFd !== 'number') return EIO;
            const newFd = this.#nextFd++;
            this.#fds.set(newFd, {
              kind: 'file',
              hostFd: rawHostFd,
              filePath: resolved.hostPath,
              fdflags,
              rightsBase,
              rightsInheriting,
            });
            m.view.setUint32(openedFdPtr, newFd, true);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_readlink: (
          fdRaw: unknown,
          pathPtrRaw: unknown,
          pathLenRaw: unknown,
          bufPtrRaw: unknown,
          bufLenRaw: unknown,
          bufusedPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const bufPtr = toU32(bufPtrRaw);
          const bufLen = toU32(bufLenRaw);
          const bufusedPtr = toU32(bufusedPtrRaw);
          if (!checkBounds(m.bytes, bufPtr, bufLen) || !checkBounds(m.bytes, bufusedPtr, 4))
            return EOVERFLOW;
          const resolved = resolveSandboxedPath(
            fdRaw,
            pathPtrRaw,
            pathLenRaw,
            RIGHT_PATH_READLINK,
            false,
            false,
          );
          if (!resolved.ok) return resolved.errno;
          try {
            const target = String(deps.fs.readlinkSync?.(resolved.hostPath));
            const targetBytes = encoder.encode(target);
            const copyLen = Math.min(bufLen, targetBytes.byteLength);
            m.bytes.set(targetBytes.subarray(0, copyLen), bufPtr);
            m.view.setUint32(bufusedPtr, copyLen, true);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_remove_directory: (
          fdRaw: unknown,
          pathPtrRaw: unknown,
          pathLenRaw: unknown,
        ): number => {
          const resolved = resolveSandboxedPath(
            fdRaw,
            pathPtrRaw,
            pathLenRaw,
            RIGHT_PATH_REMOVE_DIRECTORY,
            false,
            false,
          );
          if (!resolved.ok) return resolved.errno;
          if (resolved.hostPath === resolved.dir.rootPath) return EBUSY;
          try {
            const st = deps.fs.lstatSync?.(resolved.hostPath);
            if (statFiletype(st) !== FILETYPE_DIRECTORY) return ENOTDIR;
            deps.fs.rmdirSync?.(resolved.hostPath);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_rename: (
          oldFdRaw: unknown,
          oldPathPtrRaw: unknown,
          oldPathLenRaw: unknown,
          newFdRaw: unknown,
          newPathPtrRaw: unknown,
          newPathLenRaw: unknown,
        ): number => {
          const oldRes = resolveSandboxedPath(
            oldFdRaw,
            oldPathPtrRaw,
            oldPathLenRaw,
            RIGHT_PATH_RENAME_SOURCE,
            false,
            false,
          );
          if (!oldRes.ok) return oldRes.errno;
          const newRes = resolveSandboxedPath(
            newFdRaw,
            newPathPtrRaw,
            newPathLenRaw,
            RIGHT_PATH_RENAME_TARGET,
            false,
            true,
          );
          if (!newRes.ok) return newRes.errno;
          try {
            deps.fs.renameSync?.(oldRes.hostPath, newRes.hostPath);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_symlink: (
          oldPathPtrRaw: unknown,
          oldPathLenRaw: unknown,
          fdRaw: unknown,
          newPathPtrRaw: unknown,
          newPathLenRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const oldPtr = toU32(oldPathPtrRaw);
          const oldLen = toU32(oldPathLenRaw);
          if (!checkBounds(m.bytes, oldPtr, oldLen)) return EOVERFLOW;
          const oldSlice = m.bytes.subarray(oldPtr, oldPtr + oldLen);
          if (oldSlice.includes(0)) return EINVAL;
          const oldTarget = decoder.decode(oldSlice);
          if (oldTarget.length === 0) return EINVAL;

          const newRes = resolveSandboxedPath(
            fdRaw,
            newPathPtrRaw,
            newPathLenRaw,
            RIGHT_PATH_SYMLINK,
            false,
            true,
          );
          if (!newRes.ok) return newRes.errno;
          if (newRes.exists) return EEXIST;
          try {
            deps.fs.symlinkSync?.(oldTarget, newRes.hostPath);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        path_unlink_file: (fdRaw: unknown, pathPtrRaw: unknown, pathLenRaw: unknown): number => {
          const resolved = resolveSandboxedPath(
            fdRaw,
            pathPtrRaw,
            pathLenRaw,
            RIGHT_PATH_UNLINK_FILE,
            false,
            false,
          );
          if (!resolved.ok) return resolved.errno;
          if (resolved.trailingSlash) return EISDIR;
          try {
            const st = deps.fs.lstatSync?.(resolved.hostPath);
            if (statFiletype(st) === FILETYPE_DIRECTORY) return EISDIR;
            deps.fs.unlinkSync?.(resolved.hostPath);
            return ESUCCESS;
          } catch (error) {
            return mapErrno(error);
          }
        },

        poll_oneoff: (
          inPtrRaw: unknown,
          outPtrRaw: unknown,
          nsubscriptionsRaw: unknown,
          neventsPtrRaw: unknown,
        ): number => {
          const m = mem();
          if (!m) return EINVAL;
          const inPtr = toU32(inPtrRaw);
          const outPtr = toU32(outPtrRaw);
          const nsubs = toU32(nsubscriptionsRaw);
          const neventsPtr = toU32(neventsPtrRaw);
          if (nsubs === 0) return EINVAL;
          if (
            !checkBounds(m.bytes, inPtr, nsubs * 48) ||
            !checkBounds(m.bytes, outPtr, nsubs * 32) ||
            !checkBounds(m.bytes, neventsPtr, 4)
          )
            return EOVERFLOW;

          type ReadyEvent = {
            userdata: bigint;
            errno: number;
            type: number;
            nbytes: bigint;
            flags: number;
          };
          const events: ReadyEvent[] = [];
          const clocks: Array<{ userdata: bigint; waitMs: number; errno: number }> = [];

          for (let i = 0; i < nsubs; i++) {
            const subOff = inPtr + i * 48;
            const userdata = m.view.getBigUint64(subOff, true);
            const subType = m.view.getUint8(subOff + 8);
            if (subType === 0) {
              const clockId = m.view.getUint32(subOff + 16, true);
              const timeoutNs = m.view.getBigUint64(subOff + 24, true);
              const subFlags = m.view.getUint16(subOff + 40, true);
              if (clockId > 3) {
                clocks.push({ userdata, waitMs: 0, errno: EINVAL });
                continue;
              }
              let waitNs = timeoutNs;
              if ((subFlags & 1) !== 0) {
                const nowNs =
                  clockId === 0 ? BigInt(Math.round(Date.now() * 1_000_000)) : deps.hrtimeNs();
                waitNs = timeoutNs > nowNs ? timeoutNs - nowNs : 0n;
              }
              clocks.push({
                userdata,
                waitMs: Number(waitNs / 1_000_000n),
                errno: ESUCCESS,
              });
            } else if (subType === 1 || subType === 2) {
              const fd = m.view.getUint32(subOff + 16, true);
              const desc = this.#fds.get(fd);
              if (!desc) {
                events.push({ userdata, errno: EBADF, type: subType, nbytes: 0n, flags: 0 });
              } else if ((desc.rightsBase & RIGHT_POLL_FD_READWRITE) === 0n) {
                events.push({ userdata, errno: ENOTCAPABLE, type: subType, nbytes: 0n, flags: 0 });
              } else if (subType === 2) {
                events.push({ userdata, errno: ESUCCESS, type: subType, nbytes: 4096n, flags: 0 });
              } else if (desc.kind === 'file') {
                let nbytes = 1n;
                let flags = 0;
                try {
                  const st = deps.fs.fstatSync?.(desc.hostFd);
                  const rawSize = record(st) ? st.size : 0;
                  const size =
                    typeof rawSize === 'bigint'
                      ? rawSize >= 0n
                        ? rawSize
                        : 0n
                      : typeof rawSize === 'number' && Number.isSafeInteger(rawSize) && rawSize >= 0
                        ? BigInt(rawSize)
                        : 0n;
                  const pos = checkedLseek(desc.hostFd, 0, SEEK_CUR);
                  nbytes = size > pos ? size - pos : 0n;
                  if (nbytes === 0n) flags = 1; // EVENTRWFLAGS_FD_READWRITE_HANGUP
                } catch {
                  // Fall back to ready state.
                }
                events.push({ userdata, errno: ESUCCESS, type: subType, nbytes, flags });
              } else {
                events.push({ userdata, errno: ESUCCESS, type: subType, nbytes: 1n, flags: 0 });
              }
            } else {
              return EINVAL;
            }
          }

          if (events.length === 0 && clocks.length > 0) {
            let minWait = Number.POSITIVE_INFINITY;
            for (const clk of clocks) if (clk.waitMs < minWait) minWait = clk.waitMs;
            if (Number.isFinite(minWait) && minWait > 0) sleepMs(minWait);
            for (const clk of clocks) {
              if (clk.waitMs <= minWait) {
                events.push({
                  userdata: clk.userdata,
                  errno: clk.errno,
                  type: 0,
                  nbytes: 0n,
                  flags: 0,
                });
              }
            }
          }

          m.bytes.fill(0, outPtr, outPtr + events.length * 32);
          for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            if (!ev) continue;
            const evOff = outPtr + i * 32;
            m.view.setBigUint64(evOff, ev.userdata, true);
            m.view.setUint16(evOff + 8, ev.errno, true);
            m.view.setUint8(evOff + 10, ev.type);
            m.view.setBigUint64(evOff + 16, ev.nbytes, true);
            m.view.setUint16(evOff + 24, ev.flags, true);
          }
          m.view.setUint32(neventsPtr, events.length, true);
          return ESUCCESS;
        },

        proc_exit: (rvalRaw: unknown): never => {
          const code = toU32(rvalRaw);
          if (returnOnExit) {
            this[kExitCode] = code;
            throw kExitCode;
          }
          return deps.exit(code);
        },

        proc_raise: (_sigRaw: unknown): number => ENOTSUP,

        random_get: (bufPtrRaw: unknown, bufLenRaw: unknown): number => {
          const m = mem();
          if (!m) return EINVAL;
          const bufPtr = toU32(bufPtrRaw);
          const bufLen = toU32(bufLenRaw);
          if (!checkBounds(m.bytes, bufPtr, bufLen)) return EOVERFLOW;
          // WebCrypto getRandomValues caps each call at 65536 bytes and rejects SharedArrayBuffer.
          const scratch = new Uint8Array(Math.min(bufLen, 65536));
          let offset = 0;
          while (offset < bufLen) {
            const chunkLen = Math.min(65536, bufLen - offset);
            const slice = chunkLen === scratch.byteLength ? scratch : scratch.subarray(0, chunkLen);
            crypto.getRandomValues(slice);
            m.bytes.set(slice, bufPtr + offset);
            offset += chunkLen;
          }
          return ESUCCESS;
        },

        sched_yield: (): number => ESUCCESS,

        sock_accept: (_fdRaw: unknown, _flagsRaw: unknown, _outFdPtrRaw: unknown): number =>
          ENOTSUP,

        sock_recv: (
          _fdRaw: unknown,
          _riDataPtr: unknown,
          _riDataLen: unknown,
          _riFlags: unknown,
          _roDataLenPtr: unknown,
          _roFlagsPtr: unknown,
        ): number => ENOTSUP,

        sock_send: (
          _fdRaw: unknown,
          _siDataPtr: unknown,
          _siDataLen: unknown,
          _siFlags: unknown,
          _soDataLenPtr: unknown,
        ): number => ENOTSUP,

        sock_shutdown: (_fdRaw: unknown, _howRaw: unknown): number => ENOTSUP,
      };
    }

    #setupInstance(instance: unknown): Record<string, unknown> {
      validatePlainObject(instance, 'instance', 'argument');
      validatePlainObject(instance.exports, 'instance.exports', 'property');
      if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
        throw Object.assign(
          new TypeError('"instance.exports.memory" property must be a WebAssembly.Memory object'),
          { code: 'ERR_INVALID_ARG_TYPE' },
        );
      }
      this.#memory = instance.exports.memory;
      return instance.exports;
    }

    start(instance: unknown): number {
      if (this[kStarted]) throw errAlreadyStarted();
      this[kStarted] = true;

      const exports = this.#setupInstance(instance);
      const startFn = exports._start;
      const initFn = exports._initialize;
      if (typeof startFn !== 'function')
        throw errInvalidArgType('instance.exports._start', 'property', 'of type function', startFn);
      if (initFn !== undefined)
        throw errInvalidArgType('instance.exports._initialize', 'property', 'undefined', initFn);

      try {
        Reflect.apply(startFn, undefined, []);
      } catch (error) {
        if (error !== kExitCode) throw error;
      }
      return this[kExitCode];
    }

    initialize(instance: unknown): void {
      if (this[kStarted]) throw errAlreadyStarted();
      this[kStarted] = true;

      const exports = this.#setupInstance(instance);
      const startFn = exports._start;
      const initFn = exports._initialize;
      if (startFn !== undefined)
        throw errInvalidArgType('instance.exports._start', 'property', 'undefined', startFn);
      if (initFn !== undefined) {
        if (typeof initFn !== 'function')
          throw errInvalidArgType(
            'instance.exports._initialize',
            'property',
            'of type function',
            initFn,
          );
        Reflect.apply(initFn, undefined, []);
      }
    }

    getImportObject(): Record<string, Record<string, (...args: unknown[]) => unknown>> {
      return { [this[kBindingName]]: this.wasiImport };
    }
  };
}
