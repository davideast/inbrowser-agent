# Worker Reference

This page describes the in-worker host/connect helpers (exported from
`@inbrowser/model`), which host an `Engine` inside a Web Worker and expose the
same `Engine` shape on the main thread.

For the `Engine` surface and the `EngineEvent` vocabulary the worker transports,
see [./engine.md](./engine.md).

## Bridging the engine to the relay/agent — `createEngineModelClient`

This package owns the one `ModelClient` contract that `@inbrowser/relay` and
`@inbrowser/agent` consume (see [../README.md](../README.md) and
[../../src/contract.ts](../../src/contract.ts)). The **cloud providers** already
implement that contract directly — each `*ModelClient` factory returns a
`ModelClient`, so they plug into the relay and agent as-is.

The **on-device engine is now a `ModelClient` too**, via
`createEngineModelClient`. The engine itself still speaks `EngineEvent`; the
adapter widens that stream to the contract's `ModelEvent`. The earlier
`@inbrowser/model/relay` and `@inbrowser/model/agent` adapter subpaths
(`createLocalInferenceProvider` / `createLocalLlmClient`) — and the
`InferenceProvider` / `LlmClient` contracts they targeted — **have been
removed**; `createEngineModelClient` is their single replacement against the
shared `ModelClient` contract.

```ts
import { createEngineModelClient, createEngine, smollm2_360m } from '@inbrowser/model';

const engine = createEngine(smollm2_360m);
const client = createEngineModelClient(engine); // a ModelClient
```

```ts
function createEngineModelClient(engine: Engine, id?: string): ModelClient;
```

| Param | Type | Description |
| --- | --- | --- |
| `engine` | `Engine` | The on-device engine to drive. |
| `id?` | `string` | Stable id for metrics + provenance. Defaults to `local:${engine.model.modelId}` when the engine exposes a model id, else `'local'`. |

`supportsTools` mirrors `engine.capabilities.supportsTools`. `chat(req, signal)`
builds `EngineMessage[]` from `req.messages` and calls
`engine.generate(messages, { tools: req.toolUseEnabled ? req.tools : undefined, temperature, topP, topK, signal })`.

Message flattening: `EngineMessage` is toolless (role `system | user |
assistant` + `text`). A `role: 'tool'` result is flattened to a `user` line
(`Tool ${name} result: ${resultJson}`), and an `assistant` turn carrying
`toolCalls` keeps its text plus a `Tool call: ${name}(${args})` line per call —
so no grounding information is lost and nothing is passed in a shape the engine
can't represent. For the retrieval strategy these are just system/user messages
and pass straight through.

Event mapping (`EngineEvent` → `ModelEvent`):

| `EngineEvent` | `ModelEvent` | Notes |
| --- | --- | --- |
| `token` | `{ kind: 'text', text }` | |
| `thinking` | `{ kind: 'thinking', text }` | |
| `tool_call` | `{ kind: 'tool_call', id, name, args }` | The engine emits no signature — omitted. |
| `usage` | `{ kind: 'usage', usage: { promptTokens, outputTokens } }` | `decodeMs` is dropped. |
| `error` | `{ kind: 'error', message }` | `recoverable` is dropped. |

The engine already emits exactly one terminal `usage` (success) or `error`
(failure) before its stream returns, so the contract's "exactly one of {usage,
error} per turn" invariant carries through — the adapter synthesizes nothing.

> The site's on-device docs-chat path (the in-browser toggle that runs the
> agent against a local engine) is still forthcoming — see
> [../../../../plans/on-device-inference-5b.md](../../../../plans/on-device-inference-5b.md).
> `createEngineModelClient` is the building block it depends on; the engine is
> now a `ModelClient`, but the site wiring is not yet in place. See
> [../how-to/use-a-local-model-in-relay.md](../how-to/use-a-local-model-in-relay.md)
> and
> [../how-to/use-a-local-model-in-the-agent.md](../how-to/use-a-local-model-in-the-agent.md)
> for the current state.

## Worker host/connect helpers

Host an `Engine` inside a Web Worker and expose the same `Engine` shape on the
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
import { hostEngineInWorker } from '@inbrowser/model';
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
