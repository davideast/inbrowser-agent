# Worker Reference

This page describes the `@inbrowser/model/worker` subpath, which hosts an
`Engine` inside a Web Worker and exposes the same `Engine` shape on the main
thread.

For the `Engine` surface and the `EngineEvent` vocabulary the worker transports,
see [./engine.md](./engine.md).

## Bridging the engine to the relay/agent (forthcoming)

This package owns the one `ModelClient` contract that `@inbrowser/relay` and
`@inbrowser/agent` consume (see [../README.md](../README.md) and
[../../src/contract.ts](../../src/contract.ts)). The **cloud providers** already
implement that contract directly — each `*ModelClient` factory returns a
`ModelClient`, so they plug into the relay and agent as-is.

The **on-device engine does not yet implement `ModelClient`**. It speaks
`EngineEvent`, not the contract's `ModelEvent`. The earlier
`@inbrowser/model/relay` and `@inbrowser/model/agent` adapter subpaths
(`createLocalInferenceProvider` / `createLocalLlmClient`) — and the
`InferenceProvider` / `LlmClient` contracts they targeted — **have been
removed**. A single `createEngineModelClient(engine)` wrapper that widens
`EngineEvent` to `ModelEvent` (mapping `token` → `text`, folding the engine's
`usage` into a terminal `ModelEvent` `usage`, etc.) is the planned replacement,
but it is **not built yet**.

Until it lands, drive the engine directly via its `EngineEvent` stream
(`engine.generate(...)`) rather than through the relay/agent. See
[../how-to/use-a-local-model-in-relay.md](../how-to/use-a-local-model-in-relay.md)
and
[../how-to/use-a-local-model-in-the-agent.md](../how-to/use-a-local-model-in-the-agent.md)
for the current state.

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
