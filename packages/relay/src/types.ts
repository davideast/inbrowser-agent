/**
 * Public types for `@inbrowser/relay`.
 *
 * The model-call shapes (`ModelEvent`, `ModelMessage`, `ToolSpec`,
 * `ModelRequest`, `ModelUsage`, `ReasoningEffort`) are NOT relay-owned —
 * they are the one shared contract in `@inbrowser/model`, which
 * the cloud providers, the on-device engine, the relay (transport), and
 * the agent (runtime) all speak. The relay re-exports them so its
 * provider/handler/client code (and downstream consumers) keep a single
 * import site, and adds the relay-only transport extension on top.
 *
 * The relay routes on `NormalizedRequest.provider` — a string keyed
 * into the `providers` map at `createRelay` time. The chosen value is a
 * `ModelClientFactory` (from `@inbrowser/model`): the relay constructs a
 * `ModelClient` per request and drives its `.chat()` under a
 * `@inbrowser/resumable` engine, so every provider gets durability +
 * resume "for free" without per-provider code.
 */

import type { ModelRequest } from '@inbrowser/model';

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
} from '@inbrowser/model';

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
 * By the time the relay constructs a provider's `ModelClient`, it has
 * guaranteed a resolved key: it passes `{ apiKey: body.apiKey, model:
 * body.model }` to the `ModelClientFactory`, and the per-call settings
 * (messages / tools / sampling) ride the `ModelRequest` into `.chat()`.
 */
export type NormalizedRequest = ModelRequest & {
  /** Routing key — looked up in `createRelay`'s `providers` map. */
  provider: string;
  /** Model id passed through to the provider's upstream call. */
  model: string;
  apiKey?: string;
  /**
   * Optional — used to abort upstream fetches when the caller cancels.
   * The relay layer manages its own signal for the durable producer
   * (threaded into `.chat()`); this one is for consumer-side
   * cancellation when the call runs page-direct.
   */
  signal?: AbortSignal;
};

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
