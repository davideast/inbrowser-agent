# API Reference

This page describes the public surface of `@inbrowser/sandbox`.

## Import Paths

| Import path | Exports |
| --- | --- |
| `@inbrowser/sandbox` | Sandbox contracts, workspace adapter, standard tools, runtime adapter, checkpoints, and path helpers |
| `@inbrowser/agent/sandbox` | Agent bridge that adapts sandbox tools to `toolList` and `dispatch` |

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
| `tools` | Bound sandbox tool registry and runner. |
| `checkpoints` | Bound checkpoint create/restore API. |
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

## `standardSandboxTools`

```ts
function standardSandboxTools(): readonly SandboxTool[];
```

Returns the standard sandbox tool definitions. `createWorkspaceSandbox` installs
these tools by default. Low-level `createSandbox` callers can pass them with
`tools: standardSandboxTools()`.

`sandbox.tools`:

| Member | Description |
| --- | --- |
| `list` | Array of installed `SandboxTool` definitions. |
| `get(name)` | Returns a tool by name. |
| `run(name, args, options?)` | Executes a tool against this sandbox and emits `tool:start`, `tool:finish`, and `error` events. |

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

## `sandbox.checkpoints`

| Method | Description |
| --- | --- |
| `create(label?)` | Snapshots `sandbox.cwd`, stores it in memory, emits `checkpoint:create`, and returns the checkpoint. |
| `restore(id)` | Restores a stored checkpoint with `clearRoot: true` and emits `checkpoint:restore`. |
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
| `checkpoint:create` | A checkpoint was created. |
| `checkpoint:restore` | A checkpoint was restored. |
| `error` | A runtime or tool error occurred. |
| `destroyed` | The sandbox was destroyed. |

All events include `sandboxId` and `timestamp`.

## Agent Bridge

`@inbrowser/agent/sandbox` exports:

```ts
function createSandboxAgentTools(
  sandbox: Sandbox;
  options?: { names?: readonly string[] };
): SandboxAgentTools;
```

The bridge returns `toolList` and `dispatch` built from the sandbox's installed
tools. Pass `names` to expose only selected tools. Pure sandbox tools are marked
`parallelSafe`.
