# API Reference

This page describes the public surface of `@inbrowser/sandbox`.

## Import Paths

| Import path | Exports |
| --- | --- |
| `@inbrowser/sandbox` | Sandbox contracts, workspace adapter, standard tools, runtime adapter, checkpoints, and path helpers |
| `@inbrowser/agent/sandbox` | Agent bridge that turns sandbox tools into `ToolHandler` values |

## `createSandbox`

```ts
function createSandbox(options: CreateSandboxOptions): Sandbox;
```

`CreateSandboxOptions`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Optional sandbox id. Generated when absent. |
| `cwd` | `string` | Default working directory. Defaults to the file-system root. |
| `fs` | `SandboxFileSystem` | File system used by tools and checkpoints. |
| `runtime` | `SandboxRuntime` | Command runner used by the `bash` tool. |
| `capabilities` | `Partial<RuntimeCapabilities>` | Runtime capability flags. |
| `services` | `SandboxServices` | Optional git, preview, and package services. |

`Sandbox`:

| Member | Description |
| --- | --- |
| `id` | Stable sandbox id. |
| `cwd` | Default working directory. |
| `fs` | Sandbox file system. |
| `runtime` | Evented command runner. |
| `capabilities` | Runtime capability flags. |
| `services` | Optional git, preview, and package services. |
| `on(callback)` | Subscribes to sandbox events. Returns an unsubscribe function. |
| `emit(event)` | Emits a structured sandbox event. |
| `destroy()` | Emits `destroyed`, removes listeners, and stops file watching. |

## `createWorkspaceSandbox`

```ts
function createWorkspaceSandbox(options: CreateWorkspaceSandboxOptions): Promise<Sandbox>;
```

Adapts a `BrowserWorkspace` from `@inbrowser/workspace` into a sandbox. The
adapter creates a workspace shell, git service, package service, and optional
preview service, then passes them to `createSandbox`.

## `createStandardToolset`

```ts
function createStandardToolset(): SandboxToolset;
```

`SandboxToolset`:

| Member | Description |
| --- | --- |
| `tools` | Array of `SandboxTool` definitions. |
| `get(name)` | Returns a tool by name. |
| `run(name, args, sandbox, options?)` | Executes a tool and emits `tool:start`, `tool:finish`, and `error` events. |

Standard tools:

| Tool | Description |
| --- | --- |
| `read` | Read a UTF-8 file. |
| `write` | Write a UTF-8 file, creating parent directories. |
| `edit` | Replace text inside a file. |
| `ls` | List a directory. |
| `grep` | Search UTF-8 files for a literal string. |
| `find` | Find files by path/name substring. |
| `bash` | Run a command through the sandbox runtime. |
| `git_status` | Return changed file rows from the git service. |
| `package_install` | Resolve and record a browser-compatible package. |
| `preview_compile` | Compile the preview entry through the preview service. |

## `createCheckpointManager`

```ts
function createCheckpointManager(sandbox: Sandbox): CheckpointManager;
```

`CheckpointManager`:

| Method | Description |
| --- | --- |
| `create(label?)` | Snapshots `sandbox.cwd`, stores it in memory, emits `checkpoint`, and returns the checkpoint. |
| `restore(id)` | Restores a stored checkpoint with `clearRoot: true`. |
| `list()` | Returns checkpoints in creation order. |
| `get(id)` | Returns one checkpoint by id. |

## `createRuntimeAdapter`

```ts
function createRuntimeAdapter(run: SandboxRuntime['run']): SandboxRuntime;
```

Wraps a command-run function in the `SandboxRuntime` shape. Use this when a
host already has a command runner and only needs to adapt it into a sandbox.

## Events

`SandboxEvent` variants:

| Type | Description |
| --- | --- |
| `file` | A file-system watch event. |
| `run:start` | A command started. |
| `run:finish` | A command completed. |
| `tool:start` | A sandbox tool started. |
| `tool:finish` | A sandbox tool completed. |
| `checkpoint` | A checkpoint was created. |
| `error` | A runtime or tool error occurred. |
| `destroyed` | The sandbox was destroyed. |

All events include `sandboxId` and `timestamp`.

## Agent Bridge

`@inbrowser/agent/sandbox` exports:

```ts
function createSandboxToolHandlers(options: {
  sandbox: Sandbox;
  toolset?: SandboxToolset;
}): ToolHandler[];

function registerSandboxTools(options: {
  registry: ToolRegistry;
  sandbox: Sandbox;
  toolset?: SandboxToolset;
  replace?: boolean;
}): ToolRegistry;
```

The bridge captures the sandbox in each handler closure and forwards tool calls
through the sandbox toolset. Pure sandbox tools are marked `parallelSafe`.
