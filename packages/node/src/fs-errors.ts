// System errors as Node's fs raises them (lib/internal/errors.js UVException):
// `<CODE>: <description>, <syscall> '<path>'`, then errno, code, syscall, path and
// dest in that order. Kernel failures carry a code but not always these fields; the
// fs APIs that ported Node's logic restore them from the paths the caller gave.

// errno and strerror text (libuv) for the codes an fs call can fail with.
export const ERRNO: Record<string, [number, string]> = {
  EPERM: [-1, 'operation not permitted'],
  ENOENT: [-2, 'no such file or directory'],
  EBADF: [-9, 'bad file descriptor'],
  EAGAIN: [-11, 'resource temporarily unavailable'],
  EACCES: [-13, 'permission denied'],
  EEXIST: [-17, 'file already exists'],
  ENOTDIR: [-20, 'not a directory'],
  EISDIR: [-21, 'illegal operation on a directory'],
  EINVAL: [-22, 'invalid argument'],
  ESPIPE: [-29, 'invalid seek'],
  ENOTEMPTY: [-39, 'directory not empty'],
  ELOOP: [-40, 'too many symbolic links encountered'],
};

/** A system error as `fs` raises it: message, errno, code, syscall, path, dest. */
export function nodeError(code: string, syscall: string, target?: string, dest?: string): Error {
  const [errno, description] = ERRNO[code] ?? [-5, 'i/o error'];
  const error = new Error(
    `${code}: ${description}, ${syscall}` +
      (target === undefined ? '' : ` '${target}'`) +
      (dest === undefined ? '' : ` -> '${dest}'`),
  );
  Object.assign(error, { errno, code, syscall });
  if (target !== undefined) Object.assign(error, { path: target });
  if (dest !== undefined) Object.assign(error, { dest });
  return error;
}
