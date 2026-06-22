import { basename, createFsError, dirname, joinPath, normalizePath } from './path.js';
import type {
  ReaddirDirent,
  WorkspaceFileEvent,
  WorkspaceFileSystem,
  WorkspaceFileSystemPromises,
  WorkspaceSnapshot,
  WorkspaceSnapshotEntry,
  WorkspaceStats,
} from './types.js';

type DirectoryHandle = FileSystemDirectoryHandle & {
  values?: () => AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
};

export function opfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as { storage?: { getDirectory?: unknown } }).storage?.getDirectory ===
      'function'
  );
}

export interface OPFSFileSystemOptions {
  root?: string;
}

export function createOPFSFileSystem(options: OPFSFileSystemOptions = {}): WorkspaceFileSystem {
  const root = normalizePath(options.root ?? '/');
  const watchers = new Set<(event: WorkspaceFileEvent) => void>();
  let rootHandlePromise: Promise<FileSystemDirectoryHandle> | null = null;

  const rootHandle = async () => {
    if (!rootHandlePromise) rootHandlePromise = navigator.storage.getDirectory();
    return rootHandlePromise;
  };

  const emit = (event: Omit<WorkspaceFileEvent, 'timestamp'>) => {
    const full = { ...event, timestamp: Date.now() };
    for (const watcher of watchers) watcher(full);
  };

  async function readFile(path: string): Promise<Uint8Array>;
  async function readFile(path: string, encoding: 'utf8'): Promise<string>;
  async function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array> {
    const file = await getFileHandle(await rootHandle(), path, false);
    const blob = await file.getFile();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (encoding === 'utf8') return new TextDecoder().decode(bytes);
    return bytes;
  }

  async function readdir(path: string): Promise<string[]>;
  async function readdir(path: string, options: { withFileTypes: true }): Promise<ReaddirDirent[]>;
  async function readdir(
    path: string,
    options?: { withFileTypes: true },
  ): Promise<string[] | ReaddirDirent[]> {
    const target = normalizePath(path);
    const dir = (await getDirectoryHandle(await rootHandle(), target, false)) as DirectoryHandle;
    const values = dir.values?.();
    if (!values) return [];
    const entries: ReaddirDirent[] = [];
    for await (const handle of values) {
      const childPath = joinPath(target, handle.name);
      entries.push({
        name: handle.name,
        path: childPath,
        type: handle.kind,
        isFile: () => handle.kind === 'file',
        isDirectory: () => handle.kind === 'directory',
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (options?.withFileTypes) return entries;
    return entries.map((entry) => entry.name);
  }

  const promises: WorkspaceFileSystemPromises = {
    readFile,
    async writeFile(path, data) {
      const file = await getFileHandle(await rootHandle(), path, true);
      const writable = await file.createWritable();
      await writable.write(data as BlobPart);
      await writable.close();
      emit({ type: 'write', path: normalizePath(path) });
    },
    async mkdir(path, options) {
      const target = normalizePath(path);
      if (!options?.recursive) {
        const parent = await getDirectoryHandle(await rootHandle(), dirname(target), false);
        await parent.getDirectoryHandle(basename(target), { create: true });
      } else {
        await getDirectoryHandle(await rootHandle(), target, true);
      }
      emit({ type: 'mkdir', path: target });
    },
    readdir,
    async stat(path) {
      return statPath(await rootHandle(), path);
    },
    async lstat(path) {
      return statPath(await rootHandle(), path);
    },
    async unlink(path) {
      const target = normalizePath(path);
      const parent = await getDirectoryHandle(await rootHandle(), dirname(target), false);
      await parent.removeEntry(basename(target));
      emit({ type: 'delete', path: target });
    },
    async rmdir(path, options) {
      const target = normalizePath(path);
      const parent = await getDirectoryHandle(await rootHandle(), dirname(target), false);
      await parent.removeEntry(basename(target), { recursive: options?.recursive ?? false });
      emit({ type: 'delete', path: target });
    },
    async rename(from, to) {
      const source = normalizePath(from);
      const target = normalizePath(to);
      const stat = await statPath(await rootHandle(), source);
      if (stat.isFile()) {
        const bytes = await promises.readFile(source);
        await promises.writeFile(target, bytes);
        await promises.unlink(source);
      } else {
        const snapshot = await snapshotDirectory(source);
        await promises.mkdir(target, { recursive: true });
        for (const entry of snapshot.entries) {
          const nextPath = entry.path.replace(source, target);
          if (entry.type === 'directory') await promises.mkdir(nextPath, { recursive: true });
          else await promises.writeFile(nextPath, entry.content ?? '');
        }
        await promises.rmdir(source, { recursive: true });
      }
      emit({ type: 'rename', path: source, targetPath: target });
    },
  };

  async function snapshotDirectory(snapshotRoot: string): Promise<WorkspaceSnapshot> {
    const normalizedRoot = normalizePath(snapshotRoot);
    const entries: WorkspaceSnapshotEntry[] = [];
    await walk(normalizedRoot, async (path, entry) => {
      if (path === normalizedRoot) return;
      entries.push({
        path,
        type: entry.type,
        ...(entry.type === 'file' ? { content: await promises.readFile(path, 'utf8') } : {}),
      });
    });
    return { root: normalizedRoot, entries, createdAt: Date.now() };
  }

  async function walk(
    path: string,
    visit: (path: string, entry: { type: 'file' | 'directory' }) => Promise<void>,
  ): Promise<void> {
    const stat = await promises.stat(path);
    await visit(path, { type: stat.type });
    if (!stat.isDirectory()) return;
    const children = await promises.readdir(path, { withFileTypes: true });
    for (const child of children) await walk(child.path, visit);
  }

  return {
    kind: 'opfs',
    root,
    promises,
    watch(callback) {
      watchers.add(callback);
      return () => watchers.delete(callback);
    },
    snapshot: snapshotDirectory,
    async restore(snapshot, options) {
      if (options?.clearRoot) {
        try {
          await promises.rmdir(snapshot.root, { recursive: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      await promises.mkdir(snapshot.root, { recursive: true });
      for (const entry of snapshot.entries.filter((item) => item.type === 'directory')) {
        await promises.mkdir(entry.path, { recursive: true });
      }
      for (const entry of snapshot.entries.filter((item) => item.type === 'file')) {
        await promises.writeFile(entry.path, entry.content ?? '');
      }
    },
  };
}

async function getDirectoryHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  const parts = normalizePath(path).split('/').filter(Boolean);
  let current = root;
  for (const part of parts) {
    try {
      current = await current.getDirectoryHandle(part, { create });
    } catch (err) {
      if ((err as DOMException).name === 'NotFoundError') {
        throw createFsError('ENOENT', `No such directory: ${path}`);
      }
      throw err;
    }
  }
  return current;
}

async function getFileHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle> {
  const target = normalizePath(path);
  const parent = await getDirectoryHandle(root, dirname(target), create);
  try {
    return await parent.getFileHandle(basename(target), { create });
  } catch (err) {
    if ((err as DOMException).name === 'NotFoundError') {
      throw createFsError('ENOENT', `No such file: ${target}`);
    }
    throw err;
  }
}

async function statPath(root: FileSystemDirectoryHandle, path: string): Promise<WorkspaceStats> {
  const target = normalizePath(path);
  if (target === '/') return makeStats('directory', 0, Date.now());
  try {
    const file = await getFileHandle(root, target, false);
    const blob = await file.getFile();
    return makeStats('file', blob.size, blob.lastModified);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    await getDirectoryHandle(root, target, false);
    return makeStats('directory', 0, Date.now());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    throw err;
  }
}

function makeStats(type: 'file' | 'directory', size: number, mtimeMs: number): WorkspaceStats {
  return {
    type,
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
    mode: type === 'file' ? 0o100644 : 0o040755,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
  };
}
