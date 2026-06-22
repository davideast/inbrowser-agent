import { basename, createFsError, dirname, isPathInside, joinPath, normalizePath } from './path.js';
import type {
  ReaddirDirent,
  WorkspaceFileEvent,
  WorkspaceFileSystem,
  WorkspaceFileSystemPromises,
  WorkspaceSnapshot,
  WorkspaceSnapshotEntry,
  WorkspaceStats,
} from './types.js';

type NodeEntry =
  | { type: 'directory'; children: Set<string>; ctimeMs: number; mtimeMs: number; mode: number }
  | { type: 'file'; data: Uint8Array; ctimeMs: number; mtimeMs: number; mode: number };

export interface MemoryFileSystemOptions {
  root?: string;
}

export function createMemoryFileSystem(options: MemoryFileSystemOptions = {}): WorkspaceFileSystem {
  const root = normalizePath(options.root ?? '/');
  const nodes = new Map<string, NodeEntry>();
  const watchers = new Set<(event: WorkspaceFileEvent) => void>();
  const now = Date.now();
  nodes.set('/', {
    type: 'directory',
    children: new Set(),
    ctimeMs: now,
    mtimeMs: now,
    mode: 0o040755,
  });
  ensureDir(nodes, root);

  const emit = (event: Omit<WorkspaceFileEvent, 'timestamp'>) => {
    const full = { ...event, timestamp: Date.now() };
    for (const watcher of watchers) watcher(full);
  };

  async function readFile(path: string): Promise<Uint8Array>;
  async function readFile(path: string, encoding: 'utf8'): Promise<string>;
  async function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array> {
    const entry = fileAt(nodes, path);
    if (encoding === 'utf8') return new TextDecoder().decode(entry.data);
    return entry.data.slice();
  }

  async function readdir(path: string): Promise<string[]>;
  async function readdir(path: string, options: { withFileTypes: true }): Promise<ReaddirDirent[]>;
  async function readdir(
    path: string,
    options?: { withFileTypes: true },
  ): Promise<string[] | ReaddirDirent[]> {
    const target = normalizePath(path);
    const dir = dirAt(nodes, target);
    const names = [...dir.children].sort();
    if (options?.withFileTypes) {
      return names.map((name): ReaddirDirent => {
        const childPath = joinPath(target, name);
        const child = entryAt(nodes, childPath);
        return {
          name,
          path: childPath,
          type: child.type,
          isFile: () => child.type === 'file',
          isDirectory: () => child.type === 'directory',
        };
      });
    }
    return names;
  }

  const promises: WorkspaceFileSystemPromises = {
    readFile,
    async writeFile(path, data) {
      const target = normalizePath(path);
      ensureDir(nodes, dirname(target));
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
      const time = Date.now();
      nodes.set(target, {
        type: 'file',
        data: bytes,
        ctimeMs: time,
        mtimeMs: time,
        mode: 0o100644,
      });
      dirAt(nodes, dirname(target)).children.add(basename(target));
      emit({ type: 'write', path: target });
    },
    async mkdir(path, options) {
      const target = normalizePath(path);
      if (options?.recursive) {
        ensureDir(nodes, target);
      } else {
        const parent = dirAt(nodes, dirname(target));
        if (nodes.has(target)) throw createFsError('EEXIST', `Path exists: ${target}`);
        const time = Date.now();
        nodes.set(target, {
          type: 'directory',
          children: new Set(),
          ctimeMs: time,
          mtimeMs: time,
          mode: 0o040755,
        });
        parent.children.add(basename(target));
      }
      emit({ type: 'mkdir', path: target });
    },
    readdir,
    async stat(path) {
      return statsFor(entryAt(nodes, path));
    },
    async lstat(path) {
      return statsFor(entryAt(nodes, path));
    },
    async unlink(path) {
      const target = normalizePath(path);
      fileAt(nodes, target);
      nodes.delete(target);
      dirAt(nodes, dirname(target)).children.delete(basename(target));
      emit({ type: 'delete', path: target });
    },
    async rmdir(path, options) {
      const target = normalizePath(path);
      const dir = dirAt(nodes, target);
      if (target === '/') throw createFsError('EINVAL', 'Cannot remove root');
      if (dir.children.size > 0 && !options?.recursive) {
        throw createFsError('ENOTEMPTY', `Directory not empty: ${target}`);
      }
      for (const child of [...nodes.keys()].sort((a, b) => b.length - a.length)) {
        if (child === target || child.startsWith(`${target}/`)) nodes.delete(child);
      }
      dirAt(nodes, dirname(target)).children.delete(basename(target));
      emit({ type: 'delete', path: target });
    },
    async rename(from, to) {
      const source = normalizePath(from);
      const target = normalizePath(to);
      const entry = entryAt(nodes, source);
      ensureDir(nodes, dirname(target));
      if (entry.type === 'file') {
        nodes.set(target, { ...entry, data: entry.data.slice(), mtimeMs: Date.now() });
        nodes.delete(source);
      } else {
        const moving = [...nodes.entries()].filter(
          ([path]) => path === source || path.startsWith(`${source}/`),
        );
        for (const [path] of moving.sort((a, b) => b[0].length - a[0].length)) nodes.delete(path);
        for (const [path, value] of moving) {
          nodes.set(path.replace(source, target), cloneEntry(value));
        }
      }
      dirAt(nodes, dirname(source)).children.delete(basename(source));
      dirAt(nodes, dirname(target)).children.add(basename(target));
      emit({ type: 'rename', path: source, targetPath: target });
    },
  };

  return {
    kind: 'memory',
    root,
    promises,
    watch(callback) {
      watchers.add(callback);
      return () => watchers.delete(callback);
    },
    async snapshot(snapshotRoot = root) {
      const normalizedRoot = normalizePath(snapshotRoot);
      const entries: WorkspaceSnapshotEntry[] = [];
      for (const [path, entry] of [...nodes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!isPathInside(path, normalizedRoot)) continue;
        if (path === normalizedRoot) continue;
        entries.push({
          path,
          type: entry.type,
          ...(entry.type === 'file' ? { content: new TextDecoder().decode(entry.data) } : {}),
        });
      }
      return { root: normalizedRoot, entries, createdAt: Date.now() };
    },
    async restore(snapshot, options) {
      const restoreRoot = normalizePath(snapshot.root);
      if (options?.clearRoot) {
        for (const path of [...nodes.keys()].sort((a, b) => b.length - a.length)) {
          if (path !== '/' && isPathInside(path, restoreRoot)) nodes.delete(path);
        }
        ensureDir(nodes, restoreRoot);
      }
      for (const entry of snapshot.entries.filter((item) => item.type === 'directory')) {
        await promises.mkdir(entry.path, { recursive: true });
      }
      for (const entry of snapshot.entries.filter((item) => item.type === 'file')) {
        await promises.writeFile(entry.path, entry.content ?? '');
      }
    },
  };
}

function entryAt(nodes: Map<string, NodeEntry>, path: string): NodeEntry {
  const target = normalizePath(path);
  const entry = nodes.get(target);
  if (!entry) throw createFsError('ENOENT', `No such file or directory: ${target}`);
  return entry;
}

function fileAt(nodes: Map<string, NodeEntry>, path: string): Extract<NodeEntry, { type: 'file' }> {
  const entry = entryAt(nodes, path);
  if (entry.type !== 'file')
    throw createFsError('EISDIR', `Is a directory: ${normalizePath(path)}`);
  return entry;
}

function dirAt(
  nodes: Map<string, NodeEntry>,
  path: string,
): Extract<NodeEntry, { type: 'directory' }> {
  const entry = entryAt(nodes, path);
  if (entry.type !== 'directory')
    throw createFsError('ENOTDIR', `Not a directory: ${normalizePath(path)}`);
  return entry;
}

function ensureDir(nodes: Map<string, NodeEntry>, path: string): void {
  const target = normalizePath(path);
  if (nodes.has(target)) {
    dirAt(nodes, target);
    return;
  }
  ensureDir(nodes, dirname(target));
  const time = Date.now();
  nodes.set(target, {
    type: 'directory',
    children: new Set(),
    ctimeMs: time,
    mtimeMs: time,
    mode: 0o040755,
  });
  dirAt(nodes, dirname(target)).children.add(basename(target));
}

function statsFor(entry: NodeEntry): WorkspaceStats {
  return {
    type: entry.type,
    size: entry.type === 'file' ? entry.data.byteLength : 0,
    ctimeMs: entry.ctimeMs,
    mtimeMs: entry.mtimeMs,
    mode: entry.mode,
    isFile: () => entry.type === 'file',
    isDirectory: () => entry.type === 'directory',
  };
}

function cloneEntry(entry: NodeEntry): NodeEntry {
  return entry.type === 'file'
    ? { ...entry, data: entry.data.slice() }
    : { ...entry, children: new Set(entry.children) };
}
