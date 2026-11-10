import { Buffer } from 'buffer';
// fs.cpSync, fs.cp and fs.promises.cp for Node 22.18.0.
//
// The asynchronous form ports lib/internal/fs/cp/cp.js and the synchronous form
// ports lib/internal/fs/cp/cp-sync.js onto the guest fs primitives, so every
// operation goes through the kernel's syscalls and its owner-bit permission
// policy. Both files are modified versions of fs-extra's copy and copySync made for
// Node.js, and this file is a derivative work retained under the Node.js license
// (also vendor/node-v22.18.0/LICENSE):
//
//   Copyright Node.js contributors. All rights reserved.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to
//   deal in the Software without restriction, including without limitation the
//   rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
//   sell copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.
//
// Node 22.18's synchronous form does its path checks and, without a filter, its
// whole directory copy in C++ (cpSyncCheckPaths, cpSyncCopyDir,
// cpSyncOverrideFile). That code is not in the source tree, so its observable
// behavior was measured against the pinned oracle and is reproduced here for the
// common cases, including its message texts and the way it checks the source with
// stat when `dereference` is false and lstat when it is true. Corners where the
// native code fails oddly (it can abort the process, or raise ENOTSUP, when a
// directory or a symlink is copied onto an existing entry of another type) follow
// the JavaScript path's semantics instead; see docs/reference/architecture.md.
import path from 'path-browserify';
import {
  invalidArgType,
  validateBoolean,
  validateFunction,
  validateInteger,
  validateObject,
  validatedPath,
} from './arg-errors';
import { ERRNO, nodeError } from './fs-errors';
import { record } from './protocol';

type Fs = Record<string, (...args: unknown[]) => unknown>;

interface Stat {
  mode: number;
  ino: number;
  dev: number;
  atime: Date;
  mtime: Date;
}

export interface CpOptions {
  dereference: boolean;
  errorOnExist: boolean;
  filter: ((src: unknown, dest: unknown) => unknown) | undefined;
  force: boolean;
  mode: number;
  preserveTimestamps: boolean;
  recursive: boolean;
  verbatimSymlinks: boolean;
}

const S_IFMT = 0o170000;
const isDirectory = (stat: Stat) => (stat.mode & S_IFMT) === 0o040000;
const isSymbolicLink = (stat: Stat) => (stat.mode & S_IFMT) === 0o120000;
const isRegular = (stat: Stat) => [0o100000, 0o020000, 0o060000].includes(stat.mode & S_IFMT); // file, character, block
const isSocket = (stat: Stat) => (stat.mode & S_IFMT) === 0o140000;
const isFifo = (stat: Stat) => (stat.mode & S_IFMT) === 0o010000;

/**
 * Node's SystemError (lib/internal/errors.js) as raised by the ERR_FS_* codes:
 * the message wraps the detail in `<prefix>: <syscall> returned <errno name> (...)`.
 */
function systemError(
  code: string,
  prefix: string,
  errnoName: string,
  errno: number,
  detail: string,
  target: string,
): Error {
  const message = `${prefix}: cp returned ${errnoName} (${detail}) ${target}`;
  const error = new Error(message);
  const info = { message: detail, path: target, syscall: 'cp', errno, code: errnoName };
  Object.defineProperties(error, {
    name: { value: 'SystemError', writable: true, configurable: true },
    code: { value: code, writable: true, enumerable: true, configurable: true },
    info: { value: info, enumerable: true, configurable: true },
    errno: {
      get: () => info.errno,
      set: (value: number) => void (info.errno = value),
      enumerable: true,
      configurable: true,
    },
    syscall: {
      get: () => info.syscall,
      set: (value: string) => void (info.syscall = value),
      enumerable: true,
      configurable: true,
    },
    path: {
      get: () => info.path,
      set: (value: string) => void (info.path = value),
      enumerable: true,
      configurable: true,
    },
  });
  if (typeof error.stack === 'string')
    error.stack = error.stack.replace(/^Error:/, `SystemError [${code}]:`);
  return error;
}

const cpError = (code: string, message: string) => Object.assign(new Error(message), { code });

// What Node's native directory copy raises for a failing system call: libc text,
// a positive errno, and the destination it was copying to.
const STRERROR: Record<string, [number, string]> = {
  EPERM: [1, 'Operation not permitted'],
  ENOENT: [2, 'No such file or directory'],
  EACCES: [13, 'Permission denied'],
  EEXIST: [17, 'File exists'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
};
const nativeError = (code: string, target: string) => {
  const [errno, text] = STRERROR[code] ?? [5, 'Input/output error'];
  return Object.assign(new Error(`${code}, ${text} '${target}'`), {
    errno,
    code,
    path: target,
    syscall: 'cp',
  });
};

const dirToNonDir = (src: string, dest: string) =>
  systemError(
    'ERR_FS_CP_DIR_TO_NON_DIR',
    'Cannot overwrite non-directory with directory',
    'EISDIR',
    21,
    `cannot overwrite non-directory ${dest} with directory ${src}`,
    dest,
  );
const nonDirToDir = (src: string, dest: string) =>
  systemError(
    'ERR_FS_CP_NON_DIR_TO_DIR',
    'Cannot overwrite directory with non-directory',
    'ENOTDIR',
    20,
    `cannot overwrite directory ${dest} with non-directory ${src}`,
    dest,
  );
const exists = (dest: string) =>
  systemError(
    'ERR_FS_CP_EEXIST',
    'Target already exists',
    'EEXIST',
    17,
    `${dest} already exists`,
    dest,
  );
const invalidCopy = (detail: string, dest: string) =>
  systemError('ERR_FS_CP_EINVAL', 'Invalid src or dest', 'EINVAL', 22, detail, dest);

const notPromise = (value: unknown) => {
  if (value instanceof Promise)
    throw Object.assign(
      new TypeError(
        'Expected boolean to be returned from the "filter" function but got an instance of Promise.',
      ),
      { code: 'ERR_INVALID_RETURN_VALUE' },
    );
  return value;
};

function validatedOptions(options: unknown): CpOptions {
  const defaults = {
    dereference: false,
    errorOnExist: false,
    filter: undefined,
    force: true,
    preserveTimestamps: false,
    recursive: false,
    verbatimSymlinks: false,
  };
  if (options === undefined) return { ...defaults, mode: 0 };
  validateObject(options, 'options');
  const merged: Record<string, unknown> = { ...defaults, ...(options as object) };
  for (const key of [
    'dereference',
    'errorOnExist',
    'force',
    'preserveTimestamps',
    'recursive',
    'verbatimSymlinks',
  ])
    validateBoolean(merged[key], `options.${key}`);
  // getValidMode(mode, 'copyFile'): COPYFILE_* flags are the integers 0 through 7.
  const mode = merged.mode ?? 0;
  validateInteger(mode, 'mode', 0, 7);
  if (merged.dereference === true && merged.verbatimSymlinks === true)
    throw Object.assign(
      new TypeError(
        'Option "dereference" cannot be used in combination with option "verbatimSymlinks"',
      ),
      { code: 'ERR_INCOMPATIBLE_OPTION_PAIR' },
    );
  if (merged.filter !== undefined) validateFunction(merged.filter, 'options.filter');
  // Invariant: each field was validated above, and `filter` is a function or absent.
  return { ...merged, mode } as unknown as CpOptions;
}

export function createCp(
  fs: Fs,
  /** True when a proper ancestor of the path is a non-directory (ENOTDIR, not ENOENT). */
  throughFile: (target: unknown) => boolean,
  cwd: () => string,
  /** Told when a callback or promise operation starts: Node counts it as loop work. */
  worked: () => void,
) {
  const absolute = (target: string) => path.resolve(cwd(), target);

  // Runs one fs call. Kernel failures carry a code but not always Node's errno,
  // syscall and paths; those are restored here, from the paths the caller gave.
  const guard = <T>(
    syscall: string,
    target: string,
    dest: string | undefined,
    operation: () => T,
  ): T => {
    try {
      return operation();
    } catch (error) {
      if (record(error) && typeof error.code === 'string' && error.code in ERRNO)
        throw nodeError(
          error.code,
          typeof error.syscall === 'string' ? error.syscall : syscall,
          target,
          dest,
        );
      throw error;
    }
  };

  // stat or lstat as Node reports them. A missing entry is ENOENT, or ENOTDIR when
  // an ancestor is a regular file. With `quiet`, a missing entry is undefined, and
  // so is a path through a file for stat (lstat still throws it), as Node's
  // throwIfNoEntry: false does.
  const statOf = (
    target: string,
    follow: boolean,
    quiet: boolean,
    syscall = follow ? 'stat' : 'lstat',
  ): Stat | undefined => {
    // The empty path names nothing; resolving it would name the working directory.
    if (target === '') {
      if (quiet) return undefined;
      throw nodeError('ENOENT', syscall, target);
    }
    const stat = guard(syscall, target, undefined, () =>
      fs[follow ? 'statSync' : 'lstatSync'](target, { throwIfNoEntry: false }),
    );
    if (stat) return stat as Stat;
    const code = throughFile(absolute(target)) ? 'ENOTDIR' : 'ENOENT';
    if (quiet && (code === 'ENOENT' || follow)) return undefined;
    throw nodeError(code, syscall, target);
  };
  const missing = (error: unknown) => record(error) && error.code === 'ENOENT';
  const followed = (target: string) => statOf(target, true, false) as Stat;

  const sameFile = (a: Stat | undefined, b: Stat | undefined) =>
    a !== undefined && b !== undefined && a.ino !== 0 && a.ino === b.ino && a.dev === b.dev;

  // Both comparisons are on path text, as Node's isSrcSubdir is.
  const segments = (target: string) => absolute(target).split('/').filter(Boolean);
  const isSrcSubdir = (src: string, dest: string) => {
    const from = segments(src);
    const to = segments(dest);
    return from.every((part, index) => to[index] === part);
  };

  const setMode = (dest: string, mode: number) => {
    guard('chmod', dest, undefined, () => fs.chmodSync(dest, mode & 0o7777));
  };
  const setTimestamps = (src: string, dest: string) => {
    // The initial source atime cannot be trusted: reading the file changes it.
    const updated = followed(src);
    guard('utime', dest, undefined, () => fs.utimesSync(dest, updated.atime, updated.mtime));
  };
  const copyOne = (src: string, dest: string, mode: number) => {
    guard('copyfile', src, dest, () => fs.copyFileSync(src, dest, mode));
  };
  // Copies one regular file, then applies its mode and, on request, timestamps.
  const copyFile = (srcStat: Stat, src: string, dest: string, options: CpOptions) => {
    copyOne(src, dest, options.mode);
    if (options.preserveTimestamps) {
      // The file must be writable before its times are set.
      if ((srcStat.mode & 0o200) === 0) setMode(dest, srcStat.mode | 0o200);
      setTimestamps(src, dest);
    }
    setMode(dest, srcStat.mode);
  };
  const readLink = (target: string) =>
    guard('readlink', target, undefined, () => String(fs.readlinkSync(target)));
  const makeLink = (resolvedSrc: string, dest: string) => {
    guard('symlink', resolvedSrc, dest, () => fs.symlinkSync(resolvedSrc, dest));
  };
  const removeFile = (target: string) => {
    guard('unlink', target, undefined, () => fs.unlinkSync(target));
  };
  const entries = (src: string) =>
    guard('scandir', src, undefined, () => {
      const names = fs.readdirSync(src);
      return Array.isArray(names) ? names.map(String) : [];
    });

  // The symlink handling shared by both forms (cp.js onLink and cp-sync.js onLink
  // differ only in how they wait). `resolvedSrc` is already resolved; `overwritten`
  // is the path whose type decides whether replacing the destination is safe (the
  // destination in the synchronous form, the source in the asynchronous one).
  const linkPlan = (
    destStat: Stat | undefined,
    dest: string,
    resolvedSrc: string,
    overwritten: string,
  ) => {
    if (!destStat) return 'create';
    let resolvedDest: string;
    try {
      resolvedDest = readLink(dest);
    } catch (error) {
      // The destination exists and is not a symlink; symlink() reports the conflict.
      if (record(error) && error.code === 'EINVAL') return 'create';
      throw error;
    }
    if (!path.isAbsolute(resolvedDest))
      resolvedDest = path.resolve(cwd(), path.dirname(dest), resolvedDest);
    if (isSrcSubdir(resolvedSrc, resolvedDest))
      throw invalidCopy(
        `cannot copy ${resolvedSrc} to a subdirectory of self ${resolvedDest}`,
        dest,
      );
    // Replacing the destination would remove the source's own contents.
    if (isDirectory(followed(overwritten)) && isSrcSubdir(resolvedDest, resolvedSrc))
      throw systemError(
        'ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY',
        'Cannot overwrite symlink in subdirectory of self',
        'EINVAL',
        22,
        `cannot overwrite ${resolvedDest} with ${resolvedSrc}`,
        dest,
      );
    return 'replace';
  };
  const resolveLinkSource = (src: string, options: CpOptions) => {
    let resolvedSrc = readLink(src);
    if (!options.verbatimSymlinks && !path.isAbsolute(resolvedSrc))
      resolvedSrc = path.resolve(cwd(), path.dirname(src), resolvedSrc);
    return resolvedSrc;
  };

  // ---- Synchronous form -------------------------------------------------------

  const followedOrUndefined = (target: string) => statOf(target, true, true);

  // cpSyncCheckPaths. Measured against Node 22.18: the source and destination are
  // examined with stat when `dereference` is false and lstat when it is true (the
  // reverse of what the option implies), while error messages name the call that
  // the option implies. A symlink source counts as a directory under `dereference`.
  const checkPathsSync = (src: string, dest: string, options: CpOptions) => {
    const follow = !options.dereference;
    const label = options.dereference ? 'stat' : 'lstat';
    const srcStat = statOf(src, follow, false, label) as Stat;
    let destStat: Stat | undefined;
    try {
      destStat = statOf(dest, follow, false, label);
    } catch (error) {
      if (!record(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
    }
    const srcIsDir = isDirectory(srcStat) || (options.dereference && isSymbolicLink(srcStat));
    if (destStat) {
      if (sameFile(followedOrUndefined(src), followedOrUndefined(dest)))
        throw cpError('ERR_FS_CP_EINVAL', `src and dest cannot be the same ${dest}`);
      const destIsDir = isDirectory(destStat);
      // Node's C++ passes the two paths of the first message in this order.
      if (srcIsDir && !destIsDir)
        throw cpError(
          'ERR_FS_CP_DIR_TO_NON_DIR',
          `Cannot overwrite non-directory ${src} with directory ${dest}`,
        );
      if (!srcIsDir && destIsDir)
        throw cpError(
          'ERR_FS_CP_NON_DIR_TO_DIR',
          `Cannot overwrite directory ${dest} with non-directory ${src}`,
        );
    }
    if (srcIsDir) {
      const directory = src.endsWith('/') ? src : src + '/';
      const subdirectory = () =>
        cpError('ERR_FS_CP_EINVAL', `Cannot copy ${directory} to a subdirectory of self ${dest}`);
      if ((absolute(dest) + '/').startsWith(absolute(src).replace(/\/?$/, '/')))
        throw subdirectory();
      // A destination below a symlink or other alias of the source.
      const srcFollowed = followedOrUndefined(src);
      for (
        let parent = path.dirname(absolute(dest));
        parent !== path.dirname(absolute(src)) && parent !== path.dirname(parent);
        parent = path.dirname(parent)
      ) {
        const parentStat = statOf(parent, true, true);
        if (!parentStat) break;
        if (sameFile(srcFollowed, parentStat)) throw subdirectory();
      }
      if (!options.recursive)
        throw cpError(
          'ERR_FS_EISDIR',
          `Recursive option not enabled, cannot copy a directory: ${directory}`,
        );
    }
    // The destination's parent directories are created up front; a failure to do
    // so surfaces when the destination is examined next.
    try {
      fs.mkdirSync(path.dirname(absolute(dest)), { recursive: true });
    } catch {
      // Reported by the examination that follows.
    }
  };

  const copyDirSync = (
    src: string,
    dest: string,
    options: CpOptions,
    makeDir: boolean,
    srcMode?: number,
  ) => {
    // Node does the whole copy natively when there is no filter, and that code
    // neither calls back into JavaScript nor applies the source directory's mode.
    const native = !options.filter;
    if (makeDir) {
      try {
        guard('mkdir', dest, undefined, () => fs.mkdirSync(dest));
      } catch (error) {
        if (native && record(error) && typeof error.code === 'string')
          throw nativeError(error.code, dest);
        throw error;
      }
    }
    try {
      for (const name of entries(src)) {
        const srcItem = path.join(src, name);
        const destItem = path.join(dest, name);
        if (options.filter && !notPromise(options.filter(srcItem, destItem))) continue;
        getStatsSync(srcItem, destItem, options, native);
      }
    } finally {
      if (!native && srcMode !== undefined) setMode(dest, srcMode);
    }
  };

  const getStatsSync = (src: string, dest: string, options: CpOptions, native = false) => {
    const follow = options.dereference;
    const srcStat = statOf(src, follow, false) as Stat;
    const destStat = statOf(dest, follow, true);
    if (isDirectory(srcStat) && options.recursive) {
      if (!destStat) return copyDirSync(src, dest, options, true, srcStat.mode);
      return copyDirSync(src, dest, options, false);
    }
    if (isRegular(srcStat)) return onFileSync(srcStat, destStat, src, dest, options, native);
    if (isSymbolicLink(srcStat)) return onLinkSync(destStat, src, dest, options);
    throw cpError('ERR_FS_CP_UNKNOWN', `cannot copy an unknown file type: ${dest}`);
  };

  const onFileSync = (
    srcStat: Stat,
    destStat: Stat | undefined,
    src: string,
    dest: string,
    options: CpOptions,
    native: boolean,
  ) => {
    if (!destStat) return copyFile(srcStat, src, dest, options);
    if (options.force) {
      // cpSyncOverrideFile: remove the destination, then copy over a fresh file.
      removeFile(dest);
      return copyFile(srcStat, src, dest, options);
    }
    if (options.errorOnExist) {
      if (native)
        throw cpError(
          'ERR_FS_CP_EEXIST',
          `[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (${dest} already exists)`,
        );
      throw exists(dest);
    }
  };

  const onLinkSync = (
    destStat: Stat | undefined,
    src: string,
    dest: string,
    options: CpOptions,
  ) => {
    const resolvedSrc = resolveLinkSource(src, options);
    const plan = linkPlan(destStat, dest, resolvedSrc, dest);
    if (plan === 'replace') removeFile(dest);
    makeLink(resolvedSrc, dest);
  };

  const cpSyncRun = (
    srcArg: string | Uint8Array,
    destArg: string | Uint8Array,
    options: CpOptions,
  ) => {
    const src = String(Buffer.from(srcArg));
    const dest = String(Buffer.from(destArg));
    if (options.filter && !notPromise(options.filter(srcArg, destArg))) return;
    checkPathsSync(src, dest, options);
    getStatsSync(src, dest, options);
  };

  // ---- Asynchronous form ------------------------------------------------------

  const statsAsync = (src: string, dest: string, options: CpOptions) => {
    const follow = options.dereference;
    const srcStat = statOf(src, follow, false) as Stat;
    let destStat: Stat | undefined;
    try {
      destStat = statOf(dest, follow, false);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return { srcStat, destStat };
  };

  const checkPathsAsync = async (src: string, dest: string, options: CpOptions) => {
    if (options.filter && !(await options.filter(src, dest))) return { skipped: true as const };
    const { srcStat, destStat } = statsAsync(src, dest, options);
    if (destStat) {
      if (sameFile(srcStat, destStat)) throw invalidCopy('src and dest cannot be the same', dest);
      if (isDirectory(srcStat) && !isDirectory(destStat)) throw dirToNonDir(src, dest);
      if (!isDirectory(srcStat) && isDirectory(destStat)) throw nonDirToDir(src, dest);
    }
    if (isDirectory(srcStat) && isSrcSubdir(src, dest))
      throw invalidCopy(`cannot copy ${src} to a subdirectory of self ${dest}`, dest);
    return { skipped: false as const, srcStat, destStat };
  };

  // Rejects a destination below the source even through symlinks, by identity.
  const checkParentPathsAsync = (src: string, srcStat: Stat, dest: string) => {
    for (;;) {
      const srcParent = absolute(path.dirname(src));
      const destParent = absolute(path.dirname(dest));
      if (destParent === srcParent || destParent === '/') return;
      const stat = statOf(destParent, true, true);
      if (!stat) return;
      if (sameFile(srcStat, stat))
        throw invalidCopy(`cannot copy ${src} to a subdirectory of self ${dest}`, dest);
      dest = destParent;
    }
  };

  const getStatsForCopyAsync = async (
    destStat: Stat | undefined,
    src: string,
    dest: string,
    options: CpOptions,
  ): Promise<void> => {
    const srcStat = statOf(src, options.dereference, false) as Stat;
    if (isDirectory(srcStat) && options.recursive) {
      if (!destStat) {
        guard('mkdir', dest, undefined, () => fs.mkdirSync(dest));
        await copyDirAsync(src, dest, options);
        return setMode(dest, srcStat.mode);
      }
      return copyDirAsync(src, dest, options);
    }
    if (isDirectory(srcStat))
      throw systemError(
        'ERR_FS_EISDIR',
        'Path is a directory',
        'EISDIR',
        21,
        `${src} is a directory (not copied)`,
        src,
      );
    if (isRegular(srcStat)) {
      if (!destStat) return copyFile(srcStat, src, dest, options);
      if (options.force) {
        removeFile(dest);
        return copyFile(srcStat, src, dest, options);
      }
      if (options.errorOnExist) throw exists(dest);
      return;
    }
    if (isSymbolicLink(srcStat)) {
      const resolvedSrc = resolveLinkSource(src, options);
      const plan = linkPlan(destStat, dest, resolvedSrc, src);
      if (plan === 'replace') removeFile(dest);
      return makeLink(resolvedSrc, dest);
    }
    if (isSocket(srcStat))
      throw systemError(
        'ERR_FS_CP_SOCKET',
        'Cannot copy a socket file',
        'EINVAL',
        22,
        `cannot copy a socket file: ${dest}`,
        dest,
      );
    if (isFifo(srcStat))
      throw systemError(
        'ERR_FS_CP_FIFO_PIPE',
        'Cannot copy a FIFO pipe',
        'EINVAL',
        22,
        `cannot copy a FIFO pipe: ${dest}`,
        dest,
      );
    throw systemError(
      'ERR_FS_CP_UNKNOWN',
      'Cannot copy an unknown file type',
      'EINVAL',
      22,
      `cannot copy an unknown file type: ${dest}`,
      dest,
    );
  };

  const copyDirAsync = async (src: string, dest: string, options: CpOptions) => {
    for (const name of entries(src)) {
      const srcItem = path.join(src, name);
      const destItem = path.join(dest, name);
      const checked = await checkPathsAsync(srcItem, destItem, options);
      if (!checked.skipped)
        await getStatsForCopyAsync(checked.destStat, srcItem, destItem, options);
    }
  };

  const cpAsyncRun = async (
    srcArg: string | Uint8Array,
    destArg: string | Uint8Array,
    options: CpOptions,
  ) => {
    const src = String(Buffer.from(srcArg));
    const dest = String(Buffer.from(destArg));
    const checked = await checkPathsAsync(src, dest, options);
    if (checked.skipped) return;
    // Node's path.dirname rejects anything but a string, so a Buffer path fails here.
    for (const original of [srcArg, destArg])
      if (typeof original !== 'string') throw invalidArgType('path', 'of type string', original);
    checkParentPathsAsync(src, checked.srcStat, dest);
    const parent = path.dirname(dest);
    try {
      statOf(parent, true, false);
    } catch (error) {
      if (!missing(error)) throw error;
      guard('mkdir', parent, undefined, () => fs.mkdirSync(parent, { recursive: true }));
    }
    return getStatsForCopyAsync(checked.destStat, src, dest, options);
  };

  // ---- Public functions -------------------------------------------------------

  function cpSync(src: unknown, dest: unknown, options?: unknown): void {
    const validated = validatedOptions(options);
    cpSyncRun(validatedPath(src, 'src'), validatedPath(dest, 'dest'), validated);
  }

  function cp(src: unknown, dest: unknown, options?: unknown, callback?: unknown): void {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== 'function') throw invalidArgType('cb', 'of type function', callback);
    const done = callback as (error: unknown, value?: unknown) => void;
    const validated = validatedOptions(options);
    const source = validatedPath(src, 'src');
    const destination = validatedPath(dest, 'dest');
    worked();
    cpAsyncRun(source, destination, validated).then(
      (value) => queueMicrotask(() => done(null, value)),
      (error) => queueMicrotask(() => done(error)),
    );
  }

  async function cpPromise(src: unknown, dest: unknown, options?: unknown): Promise<void> {
    const validated = validatedOptions(options);
    const source = validatedPath(src, 'src');
    const destination = validatedPath(dest, 'dest');
    worked();
    return cpAsyncRun(source, destination, validated);
  }

  return { cpSync, cp, cpPromise };
}
