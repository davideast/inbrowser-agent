# Remote Container Bridge

This note investigates how an in-browser bridge should drive remote container
runtimes such as Apple `container` on macOS and WSL containers on Windows.

The goal is to let the browser render results and drive the session while the
agent's normal file, shell, package, and server work happens inside a Linux
container.

## Recommendation

Build the first integration around `@inbrowser/sandbox`, not
`@inbrowser/workspace`, `@inbrowser/agent`, `@inbrowser/model`, or
`@inbrowser/relay`.

The clean package fit is:

| Package | Role in the bridge |
| --- | --- |
| `@inbrowser/sandbox` | Owns the runtime-neutral bridge contract, events, tools, checkpoints, and container-backed sandbox adapter. |
| `@inbrowser/workspace` | Owns the browser-side file mirror and preview compilation when a container project should be rendered in the browser. |
| `@inbrowser/agent` | Consumes the sandbox through `createSandboxAgentTools`; it should not know whether commands run in OPFS, a browser shell, Apple `container`, or WSL. |
| `@inbrowser/resumable` | Optional transport/logging layer for long-running command and agent event streams. |
| `@inbrowser/relay` | Optional server boundary when the bridge needs authenticated remote access across devices. |
| `@inbrowser/model` | Out of scope. Container execution is a tool/runtime concern, not a model provider concern. |

The concrete provider code should start as a sandbox subpath or example rather
than a new package. A new package is only warranted once the host-side bridge
pulls in platform-specific dependencies or release cadence that would make
`@inbrowser/sandbox` too heavy.

## Why Sandbox Is The Boundary

The current sandbox contract already models the right abstraction:

```ts
runtime.run(command, { cwd, signal });
```

It also already emits structured `run:start`, `run:finish`, `tool:start`,
`tool:finish`, file, checkpoint, and error events. That is the surface a browser
UI can render and an agent can consume.

A container bridge should preserve that layering:

```text
browser UI
  renders sandbox events, files, terminals, previews, artifacts, ports

@inbrowser/agent
  chooses tools and policy

@inbrowser/sandbox
  exposes read/write/edit/search/bash/git/package/preview tools
  normalizes container events and checkpoints

container bridge
  speaks RPC to a host-side daemon
  syncs files and command results

Apple container / WSL container
  run Linux processes, package installs, dev servers, tests, and builds
```

`@inbrowser/workspace` should not become a general remote runtime package. It is
browser-native infrastructure. In this design it becomes the local renderable
mirror of the container project, which lets existing React preview compilation,
file inspection, search, and snapshots keep working in the browser.

## Execution Model

The container should be the authority for agent work.

The browser-side workspace should be a mirror/cache used for rendering,
inspection, diffing, and preview compilation. Avoid dual-write flows where the
browser and container can both mutate the same path independently.

A typical run should look like this:

1. Browser requests a sandbox session.
2. Host bridge starts or reuses a container from a configured image.
3. Bridge mounts or syncs the project into the container at the sandbox root.
4. Agent calls sandbox tools through `@inbrowser/agent/sandbox`.
5. `bash`, package, git, test, and build operations execute inside the
   container.
6. File changes stream back to the browser mirror.
7. Browser renders events, file diffs, terminal output, exposed ports, and
   preview artifacts.
8. Checkpoints capture enough state to restore or audit the session.

## Provider Shape

The bridge should hide platform details behind a provider contract:

```ts
interface ContainerSandboxProvider {
  kind: 'apple-container' | 'wsl-container' | string;
  ensureReady(): Promise<void>;
  diagnose?(): Promise<ContainerHostDiagnostic>;
  cleanupStaleSessions?(): Promise<void>;
  createSession(options: ContainerSessionOptions): Promise<ContainerSession>;
}

interface ContainerSession {
  id: string;
  root: string;
  capabilities: ContainerCapabilities;
  run(command: string, options?: ContainerRunOptions): Promise<ContainerRunResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  watch(callback: (event: ContainerFileEvent) => void): () => void;
  exposePort(port: number, options?: PortExposeOptions): Promise<ExposedPort>;
  checkpoint(options?: ContainerCheckpointOptions): Promise<ContainerCheckpoint>;
  restore(checkpoint: ContainerCheckpoint): Promise<void>;
  dispose(): Promise<void>;
}
```

That provider can be adapted into the existing `Sandbox` shape by implementing
`SandboxFileSystem`, `SandboxRuntime`, and optional `SandboxServices`.
The example host starts before `ensureReady()` succeeds, reports diagnostics
through `/status` and `host.status`, and lazily starts the provider on
`session.create`.

## Apple Container Notes

Apple `container` is an OCI-compatible macOS container runtime optimized for
Apple silicon. Its documentation says it runs Linux containers as lightweight
virtual machines, consumes and produces OCI images, and is supported on macOS
26. The tutorial flow starts the service with `container system start`, then
uses commands such as `container run`, `container exec`, `container logs`,
`container build`, and `container image`.

The technical overview is especially relevant for this bridge: Apple runs a
lightweight VM per container instead of placing all containers in one shared VM.
It integrates with macOS Virtualization.framework, vmnet, XPC, launchd,
Keychain, and unified logging.

Best initial adapter:

- Use the CLI first because it is available to users immediately.
- Prefer machine-readable commands where they exist, such as `container list
  --format json`, `container stats --format json --no-stream`, and
  `container inspect`.
- Use `container exec` for `runtime.run`.
- Use `container copy` or bind mounts for file sync.
- Use `container run -p` or direct container IPs for preview ports.
- Treat macOS 26 as the supported target; document macOS 15 networking
  limitations as non-goals for the first pass.

## WSL Container Notes

The WSL container feature has both `wslc.exe` and a Windows app API. The
Microsoft Learn page describes `wslc.exe` as a built-in CLI for building,
running, and interacting with Linux containers. The API exposes `WslcService`,
`Session`, `Container`, and `Process` objects, including image operations,
container creation, stdin/stdout/stderr, file mounts, networking mounts, GPU
access, signals, and exit codes.

Best initial adapter:

- Prefer the WSL container API through a small host daemon when available,
  because it exposes structured process events and lifecycle objects.
- Use `wslc.exe` as a CLI fallback and for parity with Apple `container`.
- Keep the browser protocol identical to the Apple provider so the sandbox and
  agent layers do not fork by operating system.
- Model GPU access as a provider capability, not as a guaranteed sandbox
  feature.

## Browser Bridge Protocol

The browser should speak to a local or remote host daemon through a narrow RPC
protocol. The daemon owns platform access, credentials, process handles, file
sync, and port forwarding. The browser owns rendering and user intent.

The bridge has two provider layers:

| Provider | Responsibility | Examples |
| --- | --- | --- |
| `BridgeTransportProvider` | Moves protocol envelopes between browser and host, handles reconnects, ordering, and auth. | WebSocket, Firebase Realtime Database, BroadcastChannel for tests. |
| `ContainerSandboxProvider` | Turns protocol requests into container lifecycle, file, process, port, and checkpoint operations. | Apple `container`, WSL container, Docker, dev VM, WebContainer. |

Keep these separate. A WSL container should be drivable over WebSocket or RTDB
without changing the WSL provider. A WebSocket transport should be able to drive
Apple `container`, WSL, or a fake test provider without changing transport code.

Minimum messages:

| Direction | Message | Purpose |
| --- | --- | --- |
| Browser to host | `session.create` | Start a container session from image, root, env, mounts, resources. |
| Browser to host | `fs.read`, `fs.write`, `fs.list`, `fs.watch` | Back `SandboxFileSystem` and the browser mirror. |
| Browser to host | `run.start`, `run.cancel`, `stdin.write` | Back `SandboxRuntime.run` and interactive processes. |
| Browser to host | `port.expose`, `port.close` | Render dev servers and other container services. |
| Browser to host | `checkpoint.create`, `checkpoint.restore` | Back sandbox checkpoints. |
| Host to browser | `event` | Stream sandbox-shaped run, file, tool, checkpoint, and error events. |
| Host to browser | `artifact` | Surface logs, previews, build outputs, screenshots, or exported files. |

## Transport Provider Interface

The transport interface should know nothing about files, shells, containers, or
agent tools. It only moves typed envelopes and exposes enough lifecycle for a
browser client and host daemon to reconnect.

```ts
type BridgePeerRole = 'browser' | 'host';
type BridgeEnvelopeKind = 'request' | 'response' | 'event' | 'ack' | 'error';

interface BridgeEnvelope<T = unknown> {
  id: string;
  sessionId: string;
  kind: BridgeEnvelopeKind;
  type: string;
  sentAt: number;
  seq?: number;
  replyTo?: string;
  peer?: BridgePeerRole;
  payload: T;
}

interface BridgeTransportProvider {
  readonly kind: string;
  connect(options: BridgeConnectOptions): Promise<BridgeConnection>;
}

interface BridgeConnectOptions {
  sessionId: string;
  role: BridgePeerRole;
  auth?: BridgeAuth;
  resumeFromSeq?: number;
  signal?: AbortSignal;
}

interface BridgeConnection {
  readonly sessionId: string;
  readonly role: BridgePeerRole;
  send(envelope: BridgeEnvelope): Promise<void>;
  request<TResponse = unknown>(
    envelope: Omit<BridgeEnvelope, 'kind'> & { kind?: 'request' },
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BridgeEnvelope<TResponse>>;
  subscribe(callback: (envelope: BridgeEnvelope) => void): () => void;
  close(reason?: string): Promise<void>;
}
```

`request()` is convenience over `send()` plus a matching `response` envelope.
The low-level `send()` and `subscribe()` methods are still required because run
output, file watches, port events, and artifacts are long-lived streams rather
than single responses.

Transport guarantees should be modest and explicit:

- Envelopes have stable ids and are safe to retry.
- Host-emitted stream envelopes have monotonically increasing `seq` per session.
- A reconnecting browser passes `resumeFromSeq` and receives newer stream
  envelopes when the provider supports replay.
- Requests are at-least-once across reconnects. Mutating handlers must be
  idempotent by envelope id.
- Binary payloads are represented as `Uint8Array` in memory, base64 strings on
  JSON-only transports, or artifact URLs when large.
- Auth is scoped to one bridge session unless the host explicitly grants broader
  access.

`@inbrowser/resumable` can back the host event log for providers that need
durable replay. It should not replace the bridge protocol; it is the ordered
event storage and subscription primitive under one transport implementation.

## WebSocket Provider

`WebSocketProvider` should be the first transport because it matches the local
host-daemon MVP: full duplex, low latency, easy cancellation, and natural
terminal streaming.

Suggested shape:

```ts
interface WebSocketBridgeProviderOptions {
  url: string | URL;
  token?: string | (() => Promise<string>);
  protocols?: string | string[];
  heartbeatMs?: number;
}

function createWebSocketBridgeProvider(
  options: WebSocketBridgeProviderOptions,
): BridgeTransportProvider;
```

Provider behavior:

- Browser connects to the daemon at a local or remote URL.
- The daemon authenticates the connection with a browser-compatible token query
  parameter and validates browser `Origin` headers by default.
- Requests and stream events are JSON envelopes.
- `Uint8Array` payloads use base64 for MVP.
- The host keeps an in-memory or resumable event log so reconnect can replay
  from `resumeFromSeq`.
- Heartbeats distinguish a slow command from a dead transport.

This provider is best for local Apple `container`, local WSL sidecars, and
single-user remote hosts.

## Realtime Database Provider

`RealtimeDatabaseProvider` should be the durable/shared-device transport. It is
slower than WebSocket but useful when the browser, host daemon, and observer UIs
may not be online at the same time.

Suggested shape:

```ts
interface RealtimeDatabaseBridgeProviderOptions {
  url: string;
  rootPath?: string;
  auth: TokenProvider;
  now?: () => number;
}

function createRealtimeDatabaseBridgeProvider(
  options: RealtimeDatabaseBridgeProviderOptions,
): BridgeTransportProvider;
```

Suggested RTDB layout:

```text
bridgeSessions/{sessionId}
  meta
    createdAt
    hostId
    status
    leaseExpiresAt
  inbox/{pushId}
    envelopeJson
    claimedBy
    claimedAt
  outbox/{seq}
    envelopeJson
  responses/{requestId}
    envelopeJson
  presence/{peerId}
    role
    lastSeenAt
```

Provider behavior:

- Browsers write `request` envelopes to `inbox`.
- The host daemon watches `inbox`, claims each request, executes it, and writes
  a matching response plus any stream events.
- Browsers watch `outbox` from `resumeFromSeq` and `responses/{requestId}` for
  request completion.
- Envelopes are stored as JSON strings so RTDB cannot coerce array-like payloads
  into different shapes.
- Large binaries should go through artifact storage; RTDB stores metadata and a
  signed URL or storage path.
- Security rules must restrict each peer to its own session path and validate
  allowed envelope directions.
- Host leases make orphaned sessions visible and allow a new host to recover or
  mark the session failed.

This provider is best for durable cloud sessions, multi-tab observers,
cross-device reconnect, and queued work that should survive a closed browser.

## Rendering Results

There are three rendering paths, and the bridge should support all three over
time:

| Path | Use when | Mechanism |
| --- | --- | --- |
| Browser preview mirror | App code is browser-compatible React/TSX. | Sync files into `@inbrowser/workspace` and reuse `createReactPreview`. |
| Port forwarding | The container runs a real dev server, API, notebook, or static server. | Host daemon exposes a container port through a same-origin proxy or local URL. |
| Artifacts | The container produces files, logs, images, test reports, or bundles. | Host streams artifact metadata and bytes to the browser. |

The MVP should implement browser preview mirror plus port forwarding. Artifact
rendering can follow once the event protocol has stable IDs.

## Checkpoints And Restore

The current sandbox checkpoint shape is file-system oriented. Container-backed
sessions need a stronger implementation because package installs, generated
files, and process state live outside OPFS.

Recommended order:

1. Use Git commits or tar snapshots of the project root for MVP restore.
2. Add provider-specific filesystem export/import when available.
3. Treat live processes as disposable across restore. After restore, the host
   should stop stale processes and ask the agent or UI to restart the preview.
4. Record container image, image digest, env, resource limits, mounts, and
   provider kind in checkpoint metadata for auditability.

Avoid promising full VM snapshots in the generic sandbox contract until both
Apple and WSL can support it consistently.

## Security Defaults

The bridge should default to one container per sandbox session, explicit mounts,
bounded CPU and memory, and explicit port exposure. Host credentials should
remain on the host daemon. The browser should receive only scoped session
tokens, not registry credentials or platform API handles.

Recommended defaults:

- Generate a unique container name per sandbox session.
- Mount only the project root and selected cache directories.
- Disable privileged container options unless the host explicitly opts in.
- Require explicit user or host policy approval for `--ssh`, GPU, host socket,
  and broad volume mounts.
- Stop and remove idle containers.
- Require the bridge token for WebSocket upgrades and browser-facing port proxy
  routes.
- Surface all mounts, ports, and provider capabilities in sandbox events.

## MVP Plan

1. Define the provider-neutral bridge envelope and `BridgeTransportProvider`
   contract. Done in `@inbrowser/sandbox/remote`.
2. Add `WebSocketProvider` as the first transport for local host daemons. Done
   as `createWebSocketBridgeProvider`.
3. Add a browser-safe `RemoteSandboxClient` that adapts a
   `BridgeTransportProvider` into `SandboxFileSystem`, `SandboxRuntime`, and
   `SandboxServices`. Done as `createRemoteSandbox`.
4. Add a Node host daemon example that implements the protocol for one container
   provider. Done in `examples/remote-container-bridge`.
5. Implement Apple `container` first through the CLI on macOS 26 because its
   commands cover run, exec, copy, inspect, logs, stats, ports, and image
   lifecycle. Implemented in the example host with diagnostics, cleanup, and an
   opt-in real integration test.
6. Add WSL support through the WSL container API when a Windows test host is
   available; keep `wslc.exe` as the parity fallback.
7. Add `RealtimeDatabaseProvider` once the event protocol and idempotency rules
   are stable enough for durable queued requests.
8. Wire the remote sandbox into `createSandboxAgentTools` without changing
   `@inbrowser/agent`. Available because `createRemoteSandbox` returns the
   normal `Sandbox` contract.
9. Add an example app that renders status, streamed terminal output, and
   authenticated forwarded preview ports. The current demo covers status,
   streaming, and proxy URLs; richer file/diff views can build on the same event
   stream.

## Open Questions

- Should the host daemon live in an example first, or should `@inbrowser/sandbox`
  grow explicit `./remote` and `./remote/node` subpaths?
- What is the smallest acceptable file sync primitive for interactive editing:
  `copy` per operation, tar deltas, rsync-like manifests, or git patches?
- Does Apple `container` expose enough stable Swift API surface for a structured
  provider, or should the package stay CLI-first until `container` reaches 1.0?
- Can the WSL API be hosted cleanly from a small .NET sidecar while the rest of
  the repo remains TypeScript-first?
- Should checkpoints be project-root-only at first, or include selected caches
  such as package manager stores?

## Sources

- Apple `container` README:
  <https://github.com/apple/container/blob/main/README.md>
- Apple `container` tutorial:
  <https://github.com/apple/container/blob/main/docs/tutorials/start-here.md>
- Apple `container` technical overview:
  <https://github.com/apple/container/blob/main/docs/technical-overview.md>
- Apple `container` command reference:
  <https://github.com/apple/container/blob/main/docs/command-reference.md>
- Microsoft Learn, WSL container:
  <https://learn.microsoft.com/en-us/windows/wsl/wsl-container>
