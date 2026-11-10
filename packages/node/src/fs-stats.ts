import { Buffer } from 'buffer';

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFIFO = 0o010000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;

export const UV_DIRENT_UNKNOWN = 0;
export const UV_DIRENT_FILE = 1;
export const UV_DIRENT_DIR = 2;
export const UV_DIRENT_LINK = 3;
export const UV_DIRENT_FIFO = 4;
export const UV_DIRENT_SOCKET = 5;
export const UV_DIRENT_CHAR = 6;
export const UV_DIRENT_BLOCK = 7;

export class StatsBase {
  mode: number | bigint = 0;

  _checkModeProperty(property: number): boolean {
    return (Number(this.mode) & S_IFMT) === property;
  }

  isDirectory(): boolean {
    return this._checkModeProperty(S_IFDIR);
  }

  isFile(): boolean {
    return this._checkModeProperty(S_IFREG);
  }

  isBlockDevice(): boolean {
    return this._checkModeProperty(S_IFBLK);
  }

  isCharacterDevice(): boolean {
    return this._checkModeProperty(S_IFCHR);
  }

  isSymbolicLink(): boolean {
    return this._checkModeProperty(S_IFLNK);
  }

  isFIFO(): boolean {
    return this._checkModeProperty(S_IFIFO);
  }

  isSocket(): boolean {
    return this._checkModeProperty(S_IFSOCK);
  }
}

for (const methodName of [
  'isDirectory',
  'isFile',
  'isBlockDevice',
  'isCharacterDevice',
  'isSymbolicLink',
  'isFIFO',
  'isSocket',
] as const) {
  Object.defineProperty(StatsBase.prototype, methodName, { enumerable: true });
}

type DateCache = {
  atime?: Date;
  mtime?: Date;
  ctime?: Date;
  birthtime?: Date;
};

const statsDateCache = new WeakMap<object, DateCache>();

function getOrCreateDate(self: object, key: keyof DateCache, msValue: number | bigint): Date {
  let cache = statsDateCache.get(self);
  if (!cache) {
    cache = {};
    statsDateCache.set(self, cache);
  }
  const existing = cache[key];
  if (existing !== undefined) return existing;
  const date = new Date(Number(msValue));
  cache[key] = date;
  return date;
}

function setCachedDate(self: object, key: keyof DateCache, value: Date): void {
  let cache = statsDateCache.get(self);
  if (!cache) {
    cache = {};
    statsDateCache.set(self, cache);
  }
  cache[key] = value;
}

export class Stats extends StatsBase {
  dev: number;
  override mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  blksize: number;
  ino: number;
  size: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;

  declare atime: Date;
  declare mtime: Date;
  declare ctime: Date;
  declare birthtime: Date;

  constructor(
    dev = 0,
    mode = 0,
    nlink = 0,
    uid = 0,
    gid = 0,
    rdev = 0,
    blksize = 0,
    ino = 0,
    size = 0,
    blocks = 0,
    atimeMs = 0,
    mtimeMs = 0,
    ctimeMs = 0,
    birthtimeMs = 0,
  ) {
    super();
    this.dev = dev;
    this.mode = mode;
    this.nlink = nlink;
    this.uid = uid;
    this.gid = gid;
    this.rdev = rdev;
    this.blksize = blksize;
    this.ino = ino;
    this.size = size;
    this.blocks = blocks;
    this.atimeMs = atimeMs;
    this.mtimeMs = mtimeMs;
    this.ctimeMs = ctimeMs;
    this.birthtimeMs = birthtimeMs;
  }
}

export class BigIntStats extends StatsBase {
  dev = 0n;
  override mode = 0n;
  nlink = 0n;
  uid = 0n;
  gid = 0n;
  rdev = 0n;
  blksize = 0n;
  ino = 0n;
  size = 0n;
  blocks = 0n;
  atimeMs = 0n;
  mtimeMs = 0n;
  ctimeMs = 0n;
  birthtimeMs = 0n;
  atimeNs = 0n;
  mtimeNs = 0n;
  ctimeNs = 0n;
  birthtimeNs = 0n;

  declare atime: Date;
  declare mtime: Date;
  declare ctime: Date;
  declare birthtime: Date;
}

for (const TargetProto of [Stats.prototype, BigIntStats.prototype] as const) {
  for (const [prop, msKey] of [
    ['atime', 'atimeMs'],
    ['mtime', 'mtimeMs'],
    ['ctime', 'ctimeMs'],
    ['birthtime', 'birthtimeMs'],
  ] as const) {
    Object.defineProperty(TargetProto, prop, {
      enumerable: true,
      configurable: true,
      get(this: Record<string, number | bigint>) {
        return getOrCreateDate(this, prop, this[msKey] ?? 0);
      },
      set(this: object, v: Date) {
        setCachedDate(this, prop, v);
      },
    });
  }
}

function toTimestampMs(msField: unknown, dateField: unknown): number {
  if (typeof msField === 'number') return msField;
  if (dateField instanceof Date) return dateField.getTime();
  if (typeof dateField === 'string' || typeof dateField === 'number') {
    return new Date(dateField).getTime();
  }
  return 0;
}

export function toStatsInstance(raw: Record<string, unknown>): Stats | BigIntStats {
  if (typeof raw.mode === 'bigint') {
    const out = new BigIntStats();
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'atime' || k === 'mtime' || k === 'ctime' || k === 'birthtime') continue;
      Reflect.set(out, k, v);
    }
    return out;
  }
  return new Stats(
    typeof raw.dev === 'number' ? raw.dev : 0,
    typeof raw.mode === 'number' ? raw.mode : 0,
    typeof raw.nlink === 'number' ? raw.nlink : 1,
    typeof raw.uid === 'number' ? raw.uid : 0,
    typeof raw.gid === 'number' ? raw.gid : 0,
    typeof raw.rdev === 'number' ? raw.rdev : 0,
    typeof raw.blksize === 'number' ? raw.blksize : 4096,
    typeof raw.ino === 'number' ? raw.ino : 0,
    typeof raw.size === 'number' ? raw.size : 0,
    typeof raw.blocks === 'number' ? raw.blocks : 0,
    toTimestampMs(raw.atimeMs, raw.atime),
    toTimestampMs(raw.mtimeMs, raw.mtime),
    toTimestampMs(raw.ctimeMs, raw.ctime),
    toTimestampMs(raw.birthtimeMs, raw.birthtime),
  );
}

function normalizeDirentKind(typeOrMode: number): number {
  const masked = typeOrMode & S_IFMT;
  if (masked !== 0) {
    if (masked === S_IFREG) return UV_DIRENT_FILE;
    if (masked === S_IFDIR) return UV_DIRENT_DIR;
    if (masked === S_IFLNK) return UV_DIRENT_LINK;
    if (masked === S_IFIFO) return UV_DIRENT_FIFO;
    if (masked === S_IFSOCK) return UV_DIRENT_SOCKET;
    if (masked === S_IFCHR) return UV_DIRENT_CHAR;
    if (masked === S_IFBLK) return UV_DIRENT_BLOCK;
    return UV_DIRENT_UNKNOWN;
  }
  return typeOrMode;
}

export class Dirent {
  name: string | Buffer;
  parentPath: string;
  path: string;
  #kind: number;

  constructor(name: string | Uint8Array = '', type = UV_DIRENT_UNKNOWN, parentPath = '') {
    this.name = name instanceof Uint8Array && !Buffer.isBuffer(name) ? Buffer.from(name) : name;
    this.parentPath = parentPath;
    this.path = parentPath;
    this.#kind = normalizeDirentKind(type);
  }

  isDirectory(): boolean {
    return this.#kind === UV_DIRENT_DIR;
  }

  isFile(): boolean {
    return this.#kind === UV_DIRENT_FILE;
  }

  isBlockDevice(): boolean {
    return this.#kind === UV_DIRENT_BLOCK;
  }

  isCharacterDevice(): boolean {
    return this.#kind === UV_DIRENT_CHAR;
  }

  isSymbolicLink(): boolean {
    return this.#kind === UV_DIRENT_LINK;
  }

  isFIFO(): boolean {
    return this.#kind === UV_DIRENT_FIFO;
  }

  isSocket(): boolean {
    return this.#kind === UV_DIRENT_SOCKET;
  }
}
