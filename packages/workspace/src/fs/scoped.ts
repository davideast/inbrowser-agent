import { isPathInside, joinPath, normalizePath, relativePath } from './path.js';
import type {
  WorkspaceFileEvent,
  WorkspaceFileSystem,
  WorkspaceFileSystemPromises,
  WorkspaceSnapshot,
} from './types.js';

export interface ScopedFileSystemOptions {
  virtualRoot: string;
  realRoot: string;
}

export function createScopedFileSystem(
  base: WorkspaceFileSystem,
  options: ScopedFileSystemOptions,
): WorkspaceFileSystem {
  const virtualRoot = normalizePath(options.virtualRoot);
  const realRoot = normalizePath(options.realRoot);
  const toReal = (path: string) => joinPath(realRoot, relativePath(virtualRoot, path));
  const toVirtual = (path: string) => joinPath(virtualRoot, relativePath(realRoot, path));

  const promises: WorkspaceFileSystemPromises = {
    readFile(path: string, encoding?: 'utf8') {
      return base.promises.readFile(toReal(path), encoding as never) as never;
    },
    writeFile(path, data) {
      return base.promises.writeFile(toReal(path), data);
    },
    mkdir(path, options) {
      return base.promises.mkdir(toReal(path), options);
    },
    readdir(path: string, options?: { withFileTypes: true }) {
      const real = toReal(path);
      return base.promises.readdir(real, options as never).then((entries: unknown) => {
        if (!options?.withFileTypes) return entries;
        return (entries as Array<{ path: string }>).map((entry) => ({
          ...entry,
          path: toVirtual(entry.path),
        }));
      }) as never;
    },
    stat(path) {
      return base.promises.stat(toReal(path));
    },
    lstat(path) {
      return base.promises.lstat(toReal(path));
    },
    unlink(path) {
      return base.promises.unlink(toReal(path));
    },
    rmdir(path, options) {
      return base.promises.rmdir(toReal(path), options);
    },
    rename(from, to) {
      return base.promises.rename(toReal(from), toReal(to));
    },
  };

  return {
    kind: base.kind,
    root: virtualRoot,
    promises,
    watch(callback) {
      return base.watch((event: WorkspaceFileEvent) => {
        if (!isPathInside(event.path, realRoot)) return;
        callback({
          ...event,
          path: toVirtual(event.path),
          targetPath: event.targetPath ? toVirtual(event.targetPath) : undefined,
        });
      });
    },
    async snapshot(root = virtualRoot) {
      const snap = await base.snapshot(toReal(root));
      return {
        ...snap,
        root,
        entries: snap.entries.map((entry) => ({ ...entry, path: toVirtual(entry.path) })),
      };
    },
    async restore(snapshot: WorkspaceSnapshot, options) {
      await base.restore(
        {
          ...snapshot,
          root: toReal(snapshot.root),
          entries: snapshot.entries.map((entry) => ({ ...entry, path: toReal(entry.path) })),
        },
        options,
      );
    },
  };
}
