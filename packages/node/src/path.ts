import paths from 'path-browserify-win32';

export function createPath(cwd: () => string) {
  // The browser package implements lexical operations but has no process cwd.
  // Supply the owning guest's cwd each time instead of caching a global base.
  const wrap = (implementation: typeof paths.posix) => {
    const resolve = (...parts: string[]) => implementation.resolve(cwd(), ...parts);
    return {
      ...implementation,
      resolve,
      relative: (from: string, to: string) => implementation.relative(resolve(from), resolve(to)),
    };
  };
  const posix = wrap(paths.posix);
  const win32 = wrap(paths.win32);
  win32.toNamespacedPath = (value: string) =>
    typeof value === 'string' && value.length > 0
      ? paths.win32.toNamespacedPath(win32.resolve(value))
      : value;
  posix.posix = win32.posix = posix;
  posix.win32 = win32.win32 = win32;
  return posix;
}
