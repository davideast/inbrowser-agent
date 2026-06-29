import {
  type WorkspaceFileSystem,
  type WorkspaceStorageStatus,
  createMemoryFileSystem,
  createOPFSFileSystem,
  createScopedFileSystem,
  normalizePath,
  opfsAvailable,
} from './fs/index.js';
import type { WorkspaceGit } from './git/index.js';
import { type WorkspacePackageRegistry, createPackageRegistry } from './packages/index.js';
import type { ReactPreviewRuntime, ReactPreviewRuntimeOptions } from './preview/react.js';
import type { CreateWorkspaceShellOptions, WorkspaceShell } from './shell/index.js';
import {
  type WorkspaceSnapshotManager,
  createWorkspaceSnapshotManager,
} from './snapshots/index.js';

export interface BrowserWorkspaceOptions {
  id: string;
  root?: string;
  storage?: 'opfs-with-memory-fallback' | 'opfs' | 'memory';
}

export interface BrowserWorkspace {
  readonly id: string;
  readonly root: string;
  readonly storageStatus: WorkspaceStorageStatus;
  readonly fs: WorkspaceFileSystem;
  readonly packages: WorkspacePackageRegistry;
  readonly snapshots: WorkspaceSnapshotManager;
  createReactPreview(options: Omit<ReactPreviewRuntimeOptions, 'fs'>): Promise<ReactPreviewRuntime>;
  createShell(
    options?: Partial<Omit<CreateWorkspaceShellOptions, 'fs' | 'root'>>,
  ): Promise<WorkspaceShell>;
  createGit(options?: { dir?: string }): Promise<WorkspaceGit>;
  dispose(): void;
}

export async function createBrowserWorkspace(
  options: BrowserWorkspaceOptions,
): Promise<BrowserWorkspace> {
  const root = normalizePath(options.root ?? '/work');
  const storage = options.storage ?? 'opfs-with-memory-fallback';
  const shouldUseOpfs = storage !== 'memory' && opfsAvailable();
  if (storage === 'opfs' && !shouldUseOpfs) {
    throw new Error('OPFS is not available in this browser context.');
  }
  const storageFs = shouldUseOpfs
    ? createOPFSFileSystem({ root: '/' })
    : createMemoryFileSystem({ root: '/' });
  const fs = createScopedFileSystem(storageFs, {
    virtualRoot: root,
    realRoot: workspaceRealRoot(options.id, root),
  });
  await fs.promises.mkdir(root, { recursive: true });
  const storageStatus: WorkspaceStorageStatus = shouldUseOpfs ? 'best-effort' : 'memory';
  const packages = createPackageRegistry({ fs });
  const snapshots = createWorkspaceSnapshotManager({
    workspaceFs: fs,
    metadataFs: storageFs,
    root,
    storageRoot: workspaceMetadataRoot(options.id),
  });

  return {
    id: options.id,
    root,
    storageStatus,
    fs,
    packages,
    snapshots,
    async createReactPreview(previewOptions) {
      const { createReactPreviewRuntime } = await import('./preview/react.js');
      return createReactPreviewRuntime({
        ...previewOptions,
        fs,
        importMap: previewOptions.importMap,
      });
    },
    async createShell(shellOptions = {}) {
      const { createWorkspaceShell } = await import('./shell/index.js');
      return createWorkspaceShell({
        fs,
        root,
        cwd: shellOptions.cwd,
        builtins: shellOptions.builtins,
      });
    },
    async createGit(gitOptions = {}) {
      const { createWorkspaceGit } = await import('./git/index.js');
      return createWorkspaceGit({ fs, dir: gitOptions.dir ?? root });
    },
    dispose() {
      // Reserved for future adapter cleanup. Kept in the public shape so hosts
      // can treat workspaces as explicit resources from day one.
    },
  };
}

function workspaceRealRoot(id: string, root: string): string {
  return `${workspaceStorageRoot(id)}${root}`;
}

function workspaceMetadataRoot(id: string): string {
  return `${workspaceStorageRoot(id)}/metadata`;
}

function workspaceStorageRoot(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_');
  return `/.inbrowser/workspaces/${safe}`;
}

export type {
  ReaddirDirent,
  WorkspaceFileEvent,
  WorkspaceFileSystem,
  WorkspaceFileSystemPromises,
  WorkspaceSnapshot,
  WorkspaceSnapshotEntry,
  WorkspaceStats,
  WorkspaceStorageKind,
  WorkspaceStorageStatus,
} from './fs/index.js';
export {
  createMemoryFileSystem,
  createOPFSFileSystem,
  createScopedFileSystem,
  opfsAvailable,
} from './fs/index.js';
export type { WorkspaceGit, GitCommitOptions, GitLogEntry, GitStatusRow } from './git/index.js';
export type {
  InstalledPackage,
  PackageInstallSpec,
  PackageRegistryState,
  PackageResolver,
  WorkspacePackageRegistry,
} from './packages/index.js';
export { createEsmShResolver, createPackageRegistry } from './packages/index.js';
export type {
  CompileWorkspaceEntryOptions,
  PreviewCompileFailure,
  PreviewCompileResult,
  PreviewCompileSuccess,
  PreviewDiagnostic,
  PreviewHostModule,
  PreviewModuleScope,
} from './preview/index.js';
export type { ReactPreviewRuntime, ReactPreviewRuntimeOptions } from './preview/react.js';
export type {
  CreateWorkspaceShellOptions,
  CreateWorkspaceGitCommandOptions,
  ShellExecOptions,
  ShellResult,
  WorkspaceShell,
} from './shell/index.js';
export { createWorkspaceGitCommand } from './shell/index.js';
export type {
  CreateWorkspaceSnapshotOptions,
  WorkspaceSnapshotManager,
  WorkspaceSnapshotRecord,
} from './snapshots/index.js';
export { createWorkspaceSnapshotManager } from './snapshots/index.js';
