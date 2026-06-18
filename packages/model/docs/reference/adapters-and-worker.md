# Adapters and Worker Reference

This page describes the three subpath exports that bridge an `Engine` to
other parts of the stack: `@inbrowser/model/relay`, `@inbrowser/model/agent`,
and `@inbrowser/model/worker`.

For the `Engine` surface and the `EngineEvent` vocabulary these adapters
translate, see [./engine.md](./engine.md).

## `@inbrowser/model/relay`

`@inbrowser/relay` is an optional peer dependency; this subpath is the only
point in the package that imports from it.

### `createLocalInferenceProvider`

```ts
function createLocalInferenceProvider(engine: Engine): InferenceProvider;
```

Adapts an `Engine` to the relay's `InferenceProvider` contract, so the relay's
handlers, durable storage, and SSE wire format treat a local model
indistinguishably from a cloud provider. `NormalizedRequest` fields with no
on-device analogue (`apiKey`, `provider`, `model`) are ignored; the engine is
bound to a single model at construction time.

`req.tools` are forwarded to the engine when present (mapped into `ToolSpec`
shape). The engine itself gates emission on `capabilities.supportsTools`, so
passing tools to a non-tools preset is a no-op rather than an error.

#### Message flattening

The engine vocabulary has no `tool` role. A `tool`-role `ChatMessage` is
flattened into a `user` message with text `[tool {name} result]\n{resultJson}`,
so the model retains the context while the tool-call structure is dropped.
`system`, `user`, and `assistant` messages map straight through.

#### Event mapping

The provider translates each `EngineEvent` to an `InferenceEvent`:

| `EngineEvent` | `InferenceEvent` | Mapping |
| --- | --- | --- |
| `{ kind: 'token', text }` | `{ kind: 'text', chunk }` | `text` becomes `chunk`. |
| `{ kind: 'thinking', text }` | `{ kind: 'thinking', chunk }` | `text` becomes `chunk`. |
| `{ kind: 'tool_call', id, name, args }` | `{ kind: 'tool_call', callId, name, args }` | `id` becomes `callId`. |
| `{ kind: 'usage', promptTokens, outputTokens, decodeMs }` | `{ kind: 'usage', promptTokens, outputTokens }` | `decodeMs` is dropped. |
| `{ kind: 'error', message, recoverable }` | `{ kind: 'error', message }` | `recoverable` is dropped; the provider returns after emitting. |

See the relay's own [reference](../../../relay/docs/reference.md) for the full
`InferenceEvent` and `InferenceProvider` contracts. How-to:
[../how-to/use-a-local-model-in-relay.md](../how-to/use-a-local-model-in-relay.md).

## `@inbrowser/model/agent`

`@inbrowser/agent` is an optional peer dependency; this subpath is the only
point in the package that imports from it.

### `createLocalLlmClient`

```ts
function createLocalLlmClient(engine: Engine, id: string): LlmClient;
```

Adapts an `Engine` to the agent runtime's `LlmClient`, so the runtime drives a
local model identically to a cloud provider. Returns:

| Member | Type | Description |
| --- | --- | --- |
| `id` | `string` | The client id passed to the factory. |
| `supportsTools` | `boolean` | Mirrors `engine.capabilities.supportsTools`. |
| `chat` | `(req: ChatRequest, signal: AbortSignal) => AsyncIterable<ChatEvent>` | Runs a turn. |

#### Tool gate

When `req.toolUseEnabled` is true and the engine does not natively support
tools, `chat` declines: it yields a single `error` event and returns. The
runtime can layer a tool-use polyfill (`withToolUsePolyfill`) over this client
to lift it into a tool-capable one. `req.tools` are forwarded to the engine only
when `req.toolUseEnabled` is set and tools are present.

#### Message flattening

Identical to the relay adapter: a `tool`-role `NormalizedMessage` becomes a
`user` message with text `[tool {name} result]\n{resultJson}`; `system`, `user`,
and `assistant` map straight through.

#### Event mapping

| `EngineEvent` | `ChatEvent` | Mapping |
| --- | --- | --- |
| `{ kind: 'token', text }` | `{ kind: 'text', chunk }` | `text` becomes `chunk`. |
| `{ kind: 'thinking', text }` | `{ kind: 'thinking', chunk }` | `text` becomes `chunk`. |
| `{ kind: 'tool_call', id, name, args }` | `{ kind: 'tool_call', id, name, args }` | Passed through. |
| `{ kind: 'usage', promptTokens, outputTokens, decodeMs }` | (folded into terminal `turn_complete`) | Accumulated, not emitted directly. |
| `{ kind: 'error', message, recoverable }` | `{ kind: 'error', message }` | `recoverable` is dropped; `chat` returns after emitting. |

After the engine stream ends, `chat` emits a terminal event:

```ts
{
  kind: 'turn_complete',
  usage: { promptTokens, completionTokens },
  details: { requestedModel: engine.model.modelId },
}
```

`completionTokens` is the engine's `outputTokens`. How-to:
[../how-to/use-a-local-model-in-the-agent.md](../how-to/use-a-local-model-in-the-agent.md).

## `@inbrowser/model/worker`

Hosts an `Engine` inside a Web Worker and exposes the same `Engine` shape on the
main thread over a `postMessage` RPC.

The key invariant: `connectWorkerEngine` returns a value that satisfies the same
`Engine` interface as `createEngine`. Adapters, the agent runtime, and UI cannot
tell whether they hold a direct engine or a remote stub.

### `hostEngineInWorker`

```ts
function hostEngineInWorker(
  workerScope: DedicatedWorkerGlobalScope,
  opts?: HostEngineInWorkerOpts,
): WorkerHostHandle;
```

Installs the worker-side RPC. Call from inside a worker entry, passing `self`.

```ts
import { hostEngineInWorker } from '@inbrowser/model/worker';
hostEngineInWorker(self);
```

`HostEngineInWorkerOpts`:

| Field | Type | Description |
| --- | --- | --- |
| `factory?` | `(opts: CreateEngineOpts) => Engine` | Factory the host uses to build the real engine after receiving `init`. Default `createEngine`. |

`WorkerHostHandle`:

| Member | Type | Description |
| --- | --- | --- |
| `dispose` | `() => Promise<void>` | Abort in-flight generations, dispose the engine, and detach the message listener. |

### `connectWorkerEngine`

```ts
function connectWorkerEngine(opts: ConnectWorkerEngineOpts): Engine;
```

Connects to a worker that has called `hostEngineInWorker(self)` and returns an
`Engine` whose calls are RPC'd over `postMessage`. The `init` frame is sent
eagerly so the worker can begin fetching weights as soon as `ensureReady` fires.

`ConnectWorkerEngineOpts`:

| Field | Type | Description |
| --- | --- | --- |
| `worker` | `Worker` | The worker hosting the engine. |
| `engine` | `CreateEngineOpts` | The same preset-plus-hooks the host will build from. Supplies `model` and `capabilities` to the returned stub before the handshake completes. |
| `handshakeTimeoutMs?` | `number` | Handshake timeout for the initial capabilities exchange. Default `10000`. |

A `GenerateOpts.signal` cannot cross the `postMessage` boundary. The client
observes it locally and forwards a `generate-abort` frame; the host synthesizes
a fresh `AbortController` for the call. `signal` is stripped from the wire
payload before sending.

### Frame protocol

RPC framing is sequence-numbered. `generate` opens a per-call stream id; the
host tags `EngineEvent`s back with that id.

Main thread to worker (`ClientFrame`):

| Kind | Purpose |
| --- | --- |
| `init` | Sent once on connect; carries `CreateEngineOpts`. |
| `ensure-ready` | Request the engine to load. Replied with `ack` or `reject`. |
| `generate-start` | Open a stream; events flow back tagged with `seq`. |
| `generate-abort` | Request a stream to terminate (best effort). |
| `dispose` | Tear down engine and transport. |

Worker to main thread (`HostFrame`):

| Kind | Purpose |
| --- | --- |
| `init-ack` | Handshake reply; echoes `model` and `capabilities`. |
| `state` | An `EngineState` transition. |
| `load` | A `LoadProgress` event. |
| `ack` | Per-`seq` success for `ensure-ready` or `dispose`. |
| `reject` | Per-`seq` failure carrying a `message`. |
| `event` | A single `EngineEvent` for a generate stream. |
| `event-end` | Terminal marker for a generate stream. |

## Related

- Engine surface and event vocabulary: [./engine.md](./engine.md)
- Presets: [./presets.md](./presets.md)
- How-to (relay): [../how-to/use-a-local-model-in-relay.md](../how-to/use-a-local-model-in-relay.md)
- How-to (agent): [../how-to/use-a-local-model-in-the-agent.md](../how-to/use-a-local-model-in-the-agent.md)
- Design discussion: [../explanation/design.md](../explanation/design.md)
