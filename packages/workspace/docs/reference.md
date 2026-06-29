# API Reference

This page describes the public surface of `@inbrowser/workspace`.

## Import Paths

| Import path | Exports |
| --- | --- |
| `@inbrowser/workspace` | `createBrowserWorkspace`, the core `BrowserWorkspace` types, and lightweight file/package helpers |
| `@inbrowser/workspace/fs` | file system adapters and path helpers |
| `@inbrowser/workspace/preview` | generic esbuild workspace compilation primitives |
| `@inbrowser/workspace/preview/react` | React-specific preview runtime helpers |
| `@inbrowser/workspace/shell` | `just-bash` workspace shell |
| `@inbrowser/workspace/git` | browser-native workspace git service |
| `@inbrowser/workspace/packages` | browser package registry and CDN resolver |
| `@inbrowser/workspace/agent-tools` | optional structural agent-tool factories |

The root import lazy-loads preview, shell, and git services. Use subpaths when
you need direct access to those services.

## `createBrowserWorkspace`

```ts
function createBrowserWorkspace(options: BrowserWorkspaceOptions): Promise<BrowserWorkspace>;
```

`BrowserWorkspaceOptions`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Stable workspace id. OPFS storage is scoped by this value. |
| `root` | `string` | Virtual workspace root. Defaults to `/work`. |
| `storage` | `'opfs-with-memory-fallback' \| 'opfs' \| 'memory'` | Storage mode. Defaults to OPFS with memory fallback. |

`BrowserWorkspace`:

| Member | Description |
| --- | --- |
| `id` | Workspace id passed at creation. |
| `root` | Virtual root path, usually `/work`. |
| `storageStatus` | `'best-effort'` for OPFS or `'memory'` for in-memory storage. |
| `fs` | Workspace file system. |
| `packages` | Browser package registry. |
| `createReactPreview(options)` | Lazily creates a React preview runtime. |
| `createShell(options?)` | Lazily creates a jailed shell. |
| `createGit(options?)` | Lazily creates a git service. |
| `dispose()` | Reserved lifecycle hook. |

## File System

```ts
interface WorkspaceFileSystem {
  kind: 'opfs' | 'memory';
  root: string;
  promises: WorkspaceFileSystemPromises;
  watch(callback: (event: WorkspaceFileEvent) => void): () => void;
  snapshot(root?: string): Promise<WorkspaceSnapshot>;
  restore(snapshot: WorkspaceSnapshot, options?: { clearRoot?: boolean }): Promise<void>;
}
```

`WorkspaceFileSystemPromises`:

| Method | Description |
| --- | --- |
| `readFile(path)` | Reads bytes. |
| `readFile(path, 'utf8')` | Reads text. |
| `writeFile(path, data)` | Writes bytes or text. Parent directories are created by the memory adapter. |
| `mkdir(path, options?)` | Creates a directory. |
| `readdir(path)` | Returns names. |
| `readdir(path, { withFileTypes: true })` | Returns dirent-like objects. |
| `stat(path)` | Returns file or directory stats. |
| `lstat(path)` | Same as `stat` in V1; symlinks are not part of the public promise. |
| `unlink(path)` | Deletes a file. |
| `rmdir(path, options?)` | Deletes a directory. |
| `rename(from, to)` | Moves a file or directory. |

## React Preview

```ts
function createReactPreviewRuntime(options: ReactPreviewRuntimeOptions): ReactPreviewRuntime;
```

`ReactPreviewRuntimeOptions`:

| Field | Type | Description |
| --- | --- | --- |
| `fs` | `WorkspaceFileSystem` | File system used for relative imports. |
| `entry` | `string` | Entry module path, such as `/work/src/App.tsx`. |
| `react` | `Record<string, unknown>` | Host React module. |
| `jsxRuntime` | `Record<string, unknown>` | Host `react/jsx-runtime` module. |
| `jsxDevRuntime` | `Record<string, unknown>` | Optional host `react/jsx-dev-runtime` module. |
| `extraHostModules` | `Record<string, PreviewHostModule>` | Additional host aliases. |
| `importMap` | `Record<string, string>` | Browser package imports. |

`ReactPreviewRuntime`:

| Method | Description |
| --- | --- |
| `compile(source?)` | Bundles the entry and returns diagnostics or an evaluator. |
| `scope(extra?)` | Builds the host-module scope passed to `evaluate`. |

## Shell

```ts
function createWorkspaceShell(options: CreateWorkspaceShellOptions): WorkspaceShell;
```

`WorkspaceShell`:

| Method | Description |
| --- | --- |
| `exec(command, options?)` | Runs a command through `just-bash`. |
| `cwd()` | Returns the persisted current directory. |
| `setCwd(path)` | Sets the current directory, clamped to the workspace root. |

The shell is not a Node process. It does not guarantee `npm`, Vite servers, or
native binaries.

## Git

```ts
function createWorkspaceGit(options: { fs: WorkspaceFileSystem; dir: string }): WorkspaceGit;
```

`WorkspaceGit`:

| Method | Description |
| --- | --- |
| `init()` | Initialises a git repository. |
| `currentBranch()` | Returns the current branch or `null`. |
| `status()` | Returns structured status rows. |
| `stageAll()` | Stages additions, modifications, and deletions. |
| `commit(options)` | Creates a commit and returns the oid. |
| `checkout(branch, options?)` | Checks out or creates a branch. |
| `log(options?)` | Returns commit log entries. |
| `listFiles(options?)` | Lists tracked files. |

## Packages

```ts
function createPackageRegistry(options: CreatePackageRegistryOptions): WorkspacePackageRegistry;
```

`WorkspacePackageRegistry`:

| Method | Description |
| --- | --- |
| `install(spec)` | Resolves and records a browser-compatible package. |
| `uninstall(name)` | Removes a package from the registry. |
| `list()` | Returns installed package records. |
| `getImportMap()` | Returns the import map used by preview compilation. |

The default resolver uses esm.sh. Hosts can inject another resolver.

## Agent Tools

`createWorkspaceTools({ workspace })` returns structural tool handlers for
reading, writing, listing, shell commands, git status, and package installs.

The returned tools are intentionally not tied to a specific agent package at
runtime. They are shaped to be compatible with `@inbrowser/agent` without
making `@inbrowser/workspace` depend on agent policy.
