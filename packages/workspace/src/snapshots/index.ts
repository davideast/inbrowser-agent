import type { WorkspaceFileSystem, WorkspaceSnapshot } from '../fs/index.js';
import { dirname, joinPath, normalizePath, relativePath } from '../fs/path.js';

export interface WorkspaceSnapshotRecord {
  id: string;
  label: string;
  createdAt: number;
  entryCount: number;
}

export interface CreateWorkspaceSnapshotOptions {
  label?: string;
}

export interface WorkspaceSnapshotManager {
  create(options?: CreateWorkspaceSnapshotOptions): Promise<WorkspaceSnapshotRecord>;
  list(): Promise<WorkspaceSnapshotRecord[]>;
  get(id: string): Promise<WorkspaceSnapshotRecord | null>;
  restore(id: string): Promise<WorkspaceSnapshotRecord>;
}

export interface CreateWorkspaceSnapshotManagerOptions {
  workspaceFs: WorkspaceFileSystem;
  metadataFs: WorkspaceFileSystem;
  root: string;
  storageRoot: string;
}

interface StoredWorkspaceSnapshotRecord extends WorkspaceSnapshotRecord {
  snapshot: WorkspaceSnapshot;
}

const INDEX_FILE = 'index.json';
const SNAPSHOT_FILE_EXTENSION = '.json';
const PRESERVED_TOP_LEVEL_NAMES = new Set(['.git']);

export function createWorkspaceSnapshotManager(
  options: CreateWorkspaceSnapshotManagerOptions,
): WorkspaceSnapshotManager {
  const root = normalizePath(options.root);
  const storageRoot = normalizePath(options.storageRoot);
  const snapshotRoot = joinPath(storageRoot, 'snapshots');
  const indexPath = joinPath(snapshotRoot, INDEX_FILE);

  return {
    async create(createOptions = {}) {
      await options.metadataFs.promises.mkdir(snapshotRoot, { recursive: true });
      const snapshot = withoutPreservedEntries(await options.workspaceFs.snapshot(root), root);
      const records = await readIndex();
      const record: StoredWorkspaceSnapshotRecord = {
        id: `snapshot-${snapshot.createdAt}-${records.length + 1}`,
        label: createOptions.label ?? `workspace snapshot ${records.length + 1}`,
        createdAt: snapshot.createdAt,
        entryCount: snapshot.entries.length,
        snapshot,
      };
      await writeSnapshot(record);
      await writeIndex([...records, publicRecord(record)]);
      return publicRecord(record);
    },
    async list() {
      return readIndex();
    },
    async get(id) {
      const record = await readSnapshot(id);
      return record ? publicRecord(record) : null;
    },
    async restore(id) {
      const record = await readSnapshot(id);
      if (!record) throw new Error(`Missing workspace snapshot: ${id}`);
      await restoreWorkingTree(options.workspaceFs, record.snapshot, root);
      return publicRecord(record);
    },
  };

  async function readIndex(): Promise<WorkspaceSnapshotRecord[]> {
    try {
      const value = JSON.parse(
        await options.metadataFs.promises.readFile(indexPath, 'utf8'),
      ) as WorkspaceSnapshotRecord[];
      return value.sort((a, b) => a.createdAt - b.createdAt);
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  async function writeIndex(records: readonly WorkspaceSnapshotRecord[]): Promise<void> {
    await options.metadataFs.promises.mkdir(snapshotRoot, { recursive: true });
    await options.metadataFs.promises.writeFile(indexPath, `${JSON.stringify(records, null, 2)}\n`);
  }

  async function readSnapshot(id: string): Promise<StoredWorkspaceSnapshotRecord | null> {
    try {
      return JSON.parse(
        await options.metadataFs.promises.readFile(snapshotPath(id), 'utf8'),
      ) as StoredWorkspaceSnapshotRecord;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async function writeSnapshot(record: StoredWorkspaceSnapshotRecord): Promise<void> {
    const path = snapshotPath(record.id);
    await options.metadataFs.promises.mkdir(dirname(path), { recursive: true });
    await options.metadataFs.promises.writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  }

  function snapshotPath(id: string): string {
    return joinPath(snapshotRoot, `${safeSnapshotId(id)}${SNAPSHOT_FILE_EXTENSION}`);
  }
}

async function restoreWorkingTree(
  fs: WorkspaceFileSystem,
  snapshot: WorkspaceSnapshot,
  root: string,
): Promise<void> {
  for (const path of await listRestorablePaths(fs, root)) {
    await removePath(fs, path);
  }
  await fs.promises.mkdir(root, { recursive: true });
  for (const entry of snapshot.entries.filter((item) => item.type === 'directory')) {
    await fs.promises.mkdir(entry.path, { recursive: true });
  }
  for (const entry of snapshot.entries.filter((item) => item.type === 'file')) {
    await fs.promises.writeFile(entry.path, entry.content ?? '');
  }
}

async function listRestorablePaths(fs: WorkspaceFileSystem, root: string): Promise<string[]> {
  const paths: string[] = [];

  async function visit(path: string): Promise<void> {
    let entries: Awaited<ReturnType<WorkspaceFileSystem['promises']['readdir']>>;
    try {
      entries = await fs.promises.readdir(path, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    for (const entry of entries) {
      if (shouldPreservePath(root, entry.path)) continue;
      if (entry.isDirectory()) await visit(entry.path);
      paths.push(entry.path);
    }
  }

  await visit(root);
  return paths.sort((a, b) => b.length - a.length);
}

async function removePath(fs: WorkspaceFileSystem, path: string): Promise<void> {
  try {
    const stats = await fs.promises.stat(path);
    if (stats.isDirectory()) await fs.promises.rmdir(path, { recursive: true });
    else await fs.promises.unlink(path);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

function withoutPreservedEntries(snapshot: WorkspaceSnapshot, root: string): WorkspaceSnapshot {
  return {
    ...snapshot,
    entries: snapshot.entries.filter((entry) => !shouldPreservePath(root, entry.path)),
  };
}

function shouldPreservePath(root: string, path: string): boolean {
  const relative = relativePath(root, path);
  const [topLevelName] = relative.split('/');
  return topLevelName ? PRESERVED_TOP_LEVEL_NAMES.has(topLevelName) : false;
}

function publicRecord(record: StoredWorkspaceSnapshotRecord): WorkspaceSnapshotRecord {
  return {
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    entryCount: record.entryCount,
  };
}

function safeSnapshotId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

function isMissing(err: unknown): boolean {
  const code =
    typeof err === 'object' && err && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
  if (code === 'ENOENT') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ENOENT|No such (?:file|directory|file or directory)/i.test(message);
}
