import pathPosix from 'internal/nodelib/path';
import { setGuestProcess } from '../node-internal/process-ref';
import { preserveFunctionNames } from '../node-internal/util';

for (const impl of [pathPosix, pathPosix.win32]) {
  preserveFunctionNames([
    [impl.resolve, 'resolve'],
    [impl.normalize, 'normalize'],
    [impl.isAbsolute, 'isAbsolute'],
    [impl.join, 'join'],
    [impl.relative, 'relative'],
    [impl.toNamespacedPath, 'toNamespacedPath'],
    [impl.dirname, 'dirname'],
    [impl.basename, 'basename'],
    [impl.extname, 'extname'],
    [impl.format, 'bound _format'],
    [impl.parse, 'parse'],
    [impl.matchesGlob, 'matchesGlob'],
  ]);
}

export function createPathBuiltins(process: { env: Record<string, unknown>; cwd: () => string }) {
  setGuestProcess(process);
  return {
    path: pathPosix,
    'path/posix': pathPosix,
    'path/win32': pathPosix.win32,
  };
}
