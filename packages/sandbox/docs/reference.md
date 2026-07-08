# API Reference

This page describes the public surface of `@inbrowser/sandbox`.

## Import Paths

| Import path | Exports |
| --- | --- |
| `@inbrowser/sandbox` | Sandbox contracts, workspace adapter, standard tools, runtime adapter, checkpoints, and path helpers |
| `@inbrowser/sandbox/remote` | Remote bridge contracts, `createRemoteSandbox`, generic bridge connection helpers, and WebSocket transport |
| `@inbrowser/sandbox/remote/host` | Host-side `startRemoteContainerBridge`, provider/host contracts, and auto-resolution types |
| `@inbrowser/sandbox/remote/node` | Node bridge host server and Node command runner for local WebSocket container providers |
| `@inbrowser/sandbox/remote/bun` | Bun bridge host server and Bun command runner for local WebSocket container providers |
| `@inbrowser/sandbox/remote/apple-container` | Apple `container` CLI provider for macOS host demos and integrations |
| `@inbrowser/agent/sandbox` | Agent bridge that adapts sandbox tools to `AgentTools` |

Related guides:

- [How to wire a sandbox into an agent](./how-to-wire-an-agent.md)
- [How to manage checkpoint history](./how-to-manage-checkpoint-history.md)
- [Why sandbox tools and agent tools are separate](./why-sandbox-and-agent-tools-are-separate.md)

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
| `create(labelOrOptions?)` | Snapshots `sandbox.cwd`, stores it in memory, emits `checkpoint:create`, and returns the checkpoint. |
| `restore(id, options?)` | Restores a stored checkpoint with `clearRoot: true`. Emits `checkpoint:restore` unless `recordEvent: false` is passed. |
| `list(filter?)` | Returns checkpoints in creation order, optionally filtered by turn/message/tool/reason. |
| `history(filter?)` | Alias for timeline-oriented checkpoint listing. |
| `latest(filter?)` | Returns the newest checkpoint matching an optional filter. |
| `get(id)` | Returns one checkpoint by id. |
| `prune(options)` | Removes matching checkpoints and emits `checkpoint:prune` when anything was removed. |

`create` accepts either a label string or metadata:

```ts
const checkpoint = await sandbox.checkpoints.create({
  label: 'before write',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  reason: 'before-tool',
  summary: 'Before editing src/App.tsx',
  metadata: { file: 'src/App.tsx' },
});
```

Checkpoint records include `id`, `createdAt`, `snapshot`, and optional
`label`, `parentId`, `turnId`, `messageId`, `toolCallId`, `reason`, `summary`,
and `metadata`.

Reasons are:

```ts
'manual' | 'before-turn' | 'before-tool' | 'after-turn' | 'restore'
```

Restore options:

```ts
await sandbox.checkpoints.restore(checkpoint.id, {
  mode: 'replace-current',
  recordEvent: true,
});
```

Pruning keeps automatic checkpoint history bounded:

```ts
sandbox.checkpoints.prune({
  reason: 'before-tool',
  keepLatest: 20,
});
```

## `createRuntimeAdapter`

```ts
function createRuntimeAdapter(run: SandboxRuntime['run']): SandboxRuntime;
```

Wraps a command-run function in the `SandboxRuntime` shape. Use this when a
host already has a command runner and only needs to adapt it into a sandbox.

## Remote Bridge

`@inbrowser/sandbox/remote` exports the browser-safe bridge surface for running
a sandbox against a host-side container or VM process.

```ts
import {
  createRemoteSandbox,
  createWebSocketBridgeProvider,
} from '@inbrowser/sandbox/remote';

const sandbox = await createRemoteSandbox({
  id: 'local-container-session',
  transport: createWebSocketBridgeProvider({
    url: 'ws://127.0.0.1:8790/bridge',
    token: '<bridge-token-from-/bridge-config>',
  }),
});
```

The bridge separates transport from runtime:

| Type | Purpose |
| --- | --- |
| `BridgeTransportProvider` | Connects a browser or host peer and returns a `BridgeConnection`. |
| `BridgeConnection` | Sends envelopes, issues request/response calls, subscribes to stream envelopes, and closes the peer connection. |
| `BridgeEnvelope` | Typed protocol envelope with `id`, `sessionId`, `kind`, `type`, `sentAt`, optional `seq`, optional `replyTo`, and payload. |
| `createRemoteSandbox` | Adapts a `BridgeTransportProvider` into `SandboxFileSystem`, `SandboxRuntime`, and standard sandbox tools. |
| `createWebSocketBridgeProvider` | First concrete browser transport for local or remote host daemons. |

Remote sandbox requests use `REMOTE_PROTOCOL_TYPES`, including `host.status`,
`session.create`, `fs.read`, `fs.write`, `fs.list`, `run.start`, `run.cancel`,
`port.expose`, `checkpoint.create`, and `checkpoint.restore`. Host stream
envelopes can carry file events, sandbox events, port metadata, and artifact
metadata. `createRemoteSandbox` re-emits remote artifacts and ports as normal
`SandboxEvent` values.

Host-side bridge code can use the decision-less host API:

```ts
import { startRemoteContainerBridge } from '@inbrowser/sandbox/remote/host';

const bridge = await startRemoteContainerBridge({
  image: 'ubuntu:latest',
});

const sandbox = await createRemoteSandbox({
  id: 'local-container-session',
  transport: bridge.createWebSocketProvider(),
});
```

The default resolver chooses Bun under Bun, Node under Node, and Apple
`container` when the CLI is available on macOS. Explicit composition remains
available when an app wants to choose every layer:

```ts
import { createAppleContainerProvider } from '@inbrowser/sandbox/remote/apple-container';
import { startNodeBridgeHostServer } from '@inbrowser/sandbox/remote/node';

const server = await startNodeBridgeHostServer({
  provider: createAppleContainerProvider({
    image: 'ubuntu:latest',
  }),
  port: 8790,
});

console.log(server.bridgeOrigin);
```

The provider contract exported from `@inbrowser/sandbox/remote/host` is runtime
specific and intentionally separate from `BridgeTransportProvider`. A WebSocket,
Realtime Database, or test transport can drive the same Apple, WSL, Docker, or
fake container provider without changing the sandbox client API.

## Events

`SandboxEvent` variants:

| Type | Description |
| --- | --- |
| `file` | A file-system watch event. |
| `artifact` | A streamed artifact, such as `run.output` stdout/stderr chunks from a remote runtime. |
| `port` | Metadata for a remote port exposed by the bridge host. |
| `run:start` | A command started. |
| `run:finish` | A command completed. |
| `tool:start` | A sandbox tool started. |
| `tool:finish` | A sandbox tool completed. |
| `checkpoint:create` | A checkpoint was created. |
| `checkpoint:restore` | A checkpoint was restored. |
| `checkpoint:prune` | One or more checkpoints were removed. |
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

The bridge returns an `AgentTools` object built from the sandbox's installed
tools. Pass `names` to expose only selected tools. Pure sandbox tools are marked
`parallelSafe`.
