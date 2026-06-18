/**
 * Public types for `@inbrowser/relay`.
 *
 * The model-call shapes (`ModelEvent`, `ModelMessage`, `ToolSpec`,
 * `ModelRequest`, `ModelUsage`, `ReasoningEffort`) are NOT relay-owned —
 * they are the one shared contract in `@inbrowser/model/contract`, which
 * the cloud providers, the on-device engine, the relay (transport), and
 * the agent (runtime) all speak. The relay re-exports them so its
 * provider/handler/client code (and downstream consumers) keep a single
 * import site, and adds the relay-only transport extension on top.
 *
 * The relay routes on `NormalizedRequest.provider` — a string keyed
 * into the `providers` map at `createRelay` time. The chosen
 * `InferenceProvider` is just an async generator of `ModelEvent`s;
 * the relay drives it under a `@inbrowser/resumable` engine, so every
 * provider gets durability + resume "for free" without per-provider
 * code.
 */

import type { ModelEvent, ModelRequest } from '@inbrowser/model/contract';

/**
 * The shared model-call contract, re-homed under the relay's import
 * site. These are the SAME types `@inbrowser/agent` consumes — relay no
 * longer owns its own `ChatMessage` / `ToolDecl` / `InferenceEvent`.
 */
export type {
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelUsage,
  ReasoningEffort,
  ToolSpec,
} from '@inbrowser/model/contract';

/**
 * The wire shape the relay accepts at `handleStart`. It is the shared
 * `ModelRequest` plus the relay-only transport concerns: `provider` (the
 * routing key, looked up in `createRelay`'s `providers` map), the model
 * id, the wire `apiKey`, and a consumer-side `signal`. Those are
 * transport details — NOT part of the model contract — so they live
 * here, not in `@inbrowser/model/contract`.
 *
 * `apiKey` is optional because the relay supports two modes:
 *   - BYOK (default): the client supplies the key and it round-trips
 *     to the provider; the relay treats it as opaque. Missing it is a
 *     400.
 *   - Server-managed: the provider is configured in
 *     `CreateRelayOpts.apiKeys`, the relay resolves the key itself,
 *     and the client must NOT send one (a non-empty value is a 400).
 *
 * By the time a provider's generator runs, the relay has guaranteed a
 * resolved key, so providers read `req.apiKey` directly.
 */
export type NormalizedRequest = ModelRequest & {
  /** Routing key — looked up in `createRelay`'s `providers` map. */
  provider: string;
  /** Model id passed through to the provider's upstream call. */
  model: string;
  apiKey?: string;
  /**
   * Optional — propagated to the provider and used to abort upstream
   * fetches when the caller cancels. The relay layer manages its own
   * signal for the durable producer; this one is for consumer-side
   * cancellation when the call runs page-direct.
   */
  signal?: AbortSignal;
};

/**
 * The provider plug-in surface. Each provider is just an async
 * generator of `ModelEvent`s for a given `NormalizedRequest`.
 * Pure function — the relay handles durability, resumability, and
 * HTTP transport; the provider only handles the upstream protocol.
 *
 * A provider that throws is wrapped by the engine as
 * `finish(jobId, 'error', message)`. To surface a clean error to
 * the client, yield `{ kind: 'error', message }` and return — same
 * effect, but the event also flows down the stream.
 */
export type InferenceProvider = (req: NormalizedRequest) => AsyncIterable<ModelEvent>;

/**
 * Pluggable logger — matches the `@inbrowser/resumable` `Logger` shape so
 * a host can pass the same instance to both layers.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
