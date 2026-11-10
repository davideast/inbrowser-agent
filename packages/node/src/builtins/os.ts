import { fault, record } from '../value-guards';

export interface OsBuiltinDeps {
  process: {
    platform: string;
    arch: string;
    env: Record<string, unknown>;
  };
  advisoryFreeMemory: () => number;
}

export interface ConstantsBuiltinDeps {
  osConstants: Record<string, unknown>;
  fsConstants: Record<string, unknown>;
  cryptoConstants?: Record<string, unknown>;
}

const DLOPEN_CONSTANTS = {
  RTLD_LAZY: 1,
  RTLD_NOW: 2,
  RTLD_GLOBAL: 256,
  RTLD_LOCAL: 0,
  RTLD_DEEPBIND: 8,
} as const;

const ERRNO_CONSTANTS = {
  E2BIG: 7,
  EACCES: 13,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  EAFNOSUPPORT: 97,
  EAGAIN: 11,
  EALREADY: 114,
  EBADF: 9,
  EBADMSG: 74,
  EBUSY: 16,
  ECANCELED: 125,
  ECHILD: 10,
  ECONNABORTED: 103,
  ECONNREFUSED: 111,
  ECONNRESET: 104,
  EDEADLK: 35,
  EDESTADDRREQ: 89,
  EDOM: 33,
  EDQUOT: 122,
  EEXIST: 17,
  EFAULT: 14,
  EFBIG: 27,
  EHOSTUNREACH: 113,
  EIDRM: 43,
  EILSEQ: 84,
  EINPROGRESS: 115,
  EINTR: 4,
  EINVAL: 22,
  EIO: 5,
  EISCONN: 106,
  EISDIR: 21,
  ELOOP: 40,
  EMFILE: 24,
  EMLINK: 31,
  EMSGSIZE: 90,
  EMULTIHOP: 72,
  ENAMETOOLONG: 36,
  ENETDOWN: 100,
  ENETRESET: 102,
  ENETUNREACH: 101,
  ENFILE: 23,
  ENOBUFS: 105,
  ENODATA: 61,
  ENODEV: 19,
  ENOENT: 2,
  ENOEXEC: 8,
  ENOLCK: 37,
  ENOLINK: 67,
  ENOMEM: 12,
  ENOMSG: 42,
  ENOPROTOOPT: 92,
  ENOSPC: 28,
  ENOSR: 63,
  ENOSTR: 60,
  ENOSYS: 38,
  ENOTCONN: 107,
  ENOTDIR: 20,
  ENOTEMPTY: 39,
  ENOTSOCK: 88,
  ENOTSUP: 95,
  ENOTTY: 25,
  ENXIO: 6,
  EOPNOTSUPP: 95,
  EOVERFLOW: 75,
  EPERM: 1,
  EPIPE: 32,
  EPROTO: 71,
  EPROTONOSUPPORT: 93,
  EPROTOTYPE: 91,
  ERANGE: 34,
  EROFS: 30,
  ESPIPE: 29,
  ESRCH: 3,
  ESTALE: 116,
  ETIME: 62,
  ETIMEDOUT: 110,
  ETXTBSY: 26,
  EWOULDBLOCK: 11,
  EXDEV: 18,
} as const;

const SIGNALS_CONSTANTS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGIOT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGSTKFLT: 16,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPOLL: 29,
  SIGPWR: 30,
  SIGSYS: 31,
} as const;

const PRIORITY_CONSTANTS = {
  PRIORITY_LOW: 19,
  PRIORITY_BELOW_NORMAL: 10,
  PRIORITY_NORMAL: 0,
  PRIORITY_ABOVE_NORMAL: -7,
  PRIORITY_HIGH: -14,
  PRIORITY_HIGHEST: -20,
} as const;

function defineNullProtoGroup<T extends Record<string, number>>(entries: T): T {
  const group: Record<string, number> = {};
  Object.setPrototypeOf(group, null);
  for (const [key, value] of Object.entries(entries)) {
    Object.defineProperty(group, key, {
      value,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  // Invariant: every property key and numeric value from `entries` has been defined on `group`.
  return group as T;
}

function createOsConstants() {
  const constants: {
    readonly UV_UDP_REUSEADDR: 4;
    dlopen: typeof DLOPEN_CONSTANTS;
    errno: typeof ERRNO_CONSTANTS;
    signals: typeof SIGNALS_CONSTANTS;
    priority: typeof PRIORITY_CONSTANTS;
  } & Record<string, unknown> = Object.setPrototypeOf(
    {
      UV_UDP_REUSEADDR: 4 as const,
      dlopen: defineNullProtoGroup(DLOPEN_CONSTANTS),
      errno: defineNullProtoGroup(ERRNO_CONSTANTS),
      signals: defineNullProtoGroup(SIGNALS_CONSTANTS),
      priority: defineNullProtoGroup(PRIORITY_CONSTANTS),
    },
    null,
  );
  Object.defineProperty(constants, 'UV_UDP_REUSEADDR', {
    value: 4,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return constants;
}

export function createConstantsBuiltin({
  osConstants,
  fsConstants,
  cryptoConstants,
}: ConstantsBuiltinDeps): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const section of [
    osConstants.dlopen,
    osConstants.errno,
    osConstants.priority,
    osConstants.signals,
    fsConstants,
    cryptoConstants,
  ]) {
    if (record(section)) Object.assign(merged, section);
  }
  return Object.freeze(merged);
}

export function createOsBuiltin({ process, advisoryFreeMemory }: OsBuiltinDeps) {
  // Browser-reported capacity is advisory, as is Node's native scheduler hint.
  return {
    // Node v22.18.0 Linux x64 POSIX constants inventory (null-prototype groups).
    constants: createOsConstants(),
    availableParallelism: () => navigator.hardwareConcurrency,
    // Node permits an empty array when CPU details are unavailable. Browsers
    // expose no per-core model, clock speed or CPU accounting information.
    cpus: () => [],
    platform: () => process.platform,
    // os.md "os.arch()": "equivalent to process.arch".
    arch: () => process.arch,
    // os.md "os.EOL" and "os.devNull": the POSIX values, matching this runtime's
    // POSIX path policy. The virtual filesystem has no device nodes, so opening
    // devNull fails with ENOENT; the property reports the documented path only.
    EOL: '\n',
    devNull: '/dev/null',
    // Measured from the engine's typed-array layout, as Node's build records it.
    endianness: () => (new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 'LE' : 'BE'),
    // os.md "os.networkInterfaces()": interfaces "that have been assigned a
    // network address". A browser exposes none, so the answer is an empty
    // object, freshly allocated like Node's.
    networkInterfaces: () => ({}),
    // os.md "os.loadavg()": a Unix-specific concept that platforms without it
    // report as [0, 0, 0] (documented there for Windows).
    loadavg: () => [0, 0, 0],
    // os.md "os.totalmem()" has no unavailable value. The only host-reported
    // figure is navigator.deviceMemory: approximate GiB of device RAM, rounded
    // to a power of two and capped at 8 by browsers. It is forwarded as an
    // advisory total, never as measured system memory; absent or invalid
    // values fail explicitly.
    totalmem: () => {
      const gib: unknown = Reflect.get(navigator, 'deviceMemory');
      if (typeof gib !== 'number' || !Number.isFinite(gib) || gib <= 0)
        throw fault('ENOSYS', 'Browser device memory is unavailable');
      return Math.round(gib * 1024 ** 3);
    },
    freemem: () => advisoryFreeMemory(),
    // No browser API reports OS release/version/machine strings, system uptime
    // or a user database, and os.md defines no unavailable value for them, so
    // each fails explicitly instead of returning a made-up value.
    ...Object.fromEntries(
      ['release', 'version', 'machine', 'uptime', 'userInfo'].map((name) => [
        name,
        () => {
          throw fault('ENOSYS', `os.${name} has no browser source`);
        },
      ]),
    ),
    type: () => 'Browser',
    // Assigned virtual OS identity; this does not query the physical host.
    hostname: () => 'localhost',
    homedir: () => {
      const home = process.env.HOME;
      if (home !== undefined && typeof home !== 'string')
        throw fault('EINVAL', 'Home directory environment must be a string');
      // This virtual filesystem has no host user database; its default home is root.
      return home ?? '/';
    },
    tmpdir: () => {
      const value = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
      if (typeof value !== 'string')
        throw fault('EINVAL', 'Temporary directory environment must be a string');
      return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
    },
  };
}
