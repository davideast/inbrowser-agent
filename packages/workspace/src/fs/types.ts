export type WorkspaceStorageKind = 'opfs' | 'memory';
export type WorkspaceStorageStatus = 'persistent' | 'best-effort' | 'memory';

export interface WorkspaceStats {
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode?: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ReaddirDirent {
  name: string;
  path: string;
  type: 'file' | 'directory';
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface WorkspaceFileSystemPromises {
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<ReaddirDirent[]>;
  stat(path: string): Promise<WorkspaceStats>;
  lstat(path: string): Promise<WorkspaceStats>;
  unlink(path: string): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface WorkspaceFileEvent {
  type: 'write' | 'delete' | 'rename' | 'mkdir';
  path: string;
  targetPath?: string;
  timestamp: number;
}

export interface WorkspaceSnapshotEntry {
  path: string;
  type: 'file' | 'directory';
  content?: string;
}

export interface WorkspaceSnapshot {
  root: string;
  entries: WorkspaceSnapshotEntry[];
  createdAt: number;
}

export interface WorkspaceFileSystem {
  readonly kind: WorkspaceStorageKind;
  readonly root: string;
  readonly promises: WorkspaceFileSystemPromises;
  watch(callback: (event: WorkspaceFileEvent) => void): () => void;
  snapshot(root?: string): Promise<WorkspaceSnapshot>;
  restore(snapshot: WorkspaceSnapshot, options?: { clearRoot?: boolean }): Promise<void>;
}
