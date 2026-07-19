/**
 * `@inbrowser/resumable` — resumable streaming-job engine.
 *
 * ONE root barrel, no subpaths. The engine + types + `JobStore` contract,
 * every store implementation (memory / rtdb / idb), the SSE HTTP binding,
 * the reconnecting client, the worker transport, and the conformance
 * probes all hang off this single entrypoint. Deep store/transport subpaths
 * stay closed on purpose — import from `@inbrowser/resumable`. Each backing
 * module is browser-safe (the RTDB store is fetch-based; its service-account
 * token provider lazy-`import()`s `node:` only when invoked), so the root
 * barrel never statically pulls a Node builtin.
 *
 * See `plans/resumable-and-llm-relay-extraction.md` for the design.
 */
export {
  createJobEngine,
  type CreateJobEngineOpts,
  type JobEngine,
  type SubscribeOpts,
  type SweepSchedule,
} from './engine.js';

export {
  silentLogger,
  type JobEvent,
  type JobMeta,
  type JobSnapshot,
  type JobStatus,
  type Logger,
  type Producer,
  type ProducerCtx,
  type TerminalStatus,
} from './types.js';

export type {
  JobStore,
  SweepOpts,
  SweepResult,
} from './store/contract.js';

// The IndexedDB store — the browser-durable backing store. Root barrel only.
export {
  createIdbJobStore,
  type CreateIdbJobStoreOpts,
  type IdbJobStore,
} from './store/idb.js';

export type { IdGenerator } from './ids.js';

// Worker transport — host a `JobEngine` inside a worker and drive it over a
// `MessagePort` from another context. Root barrel only (no `./worker` subpath).
export {
  connectJobEngine,
  hostJobEngine,
  type ConnectedJobEngine,
  type HostJobEngineOpts,
  type JobEngineHost,
  type PortLike,
} from './worker.js';

// ── Stores (formerly the `./memory` and `./rtdb` subpaths) ──────────
// In-process, zero-dependency store — the default for tests and local dev.
export {
  createMemoryJobStore,
  type CreateMemoryJobStoreOpts,
} from './store/memory.js';

// Firebase RTDB store — fetch/SSE-based, browser-safe. Its token providers
// lazy-`import()` `node:` only when called, so this stays browser-importable.
export {
  createRtdbJobStore,
  staticTokenProvider,
  serviceAccountTokenProvider,
  type CreateRtdbJobStoreOpts,
  type TokenProvider,
  type ServiceAccountTokenProviderOpts,
} from './store/rtdb/index.js';

// ── SSE HTTP binding (formerly the `./http` subpath) ────────────────
// Serve a job subscription as Server-Sent Events. Web-standard; browser-safe.
export {
  sseFromJob,
  encodeSseEvent,
  SSE_DONE_LINE,
  SSE_STREAM_OPEN,
  type SseFromJobOpts,
} from './http.js';

// ── Reconnecting client (formerly the `./client` subpath) ───────────
// Environment-agnostic reconnecting consumer of a job's start + stream
// HTTP endpoints. `installBrowserLifecycle` is SSR-safe (guards `document`).
export {
  createResumableClient,
  installBrowserLifecycle,
  type ClientMessage,
  type ResumableClient,
  type ResumableClientOptions,
} from './client.js';

// ── Conformance probes (formerly the `./testing` subpath) ───────────
// Durability + TTL-sweep probes any `JobStore` implementation can run.
export {
  probeStoreDurability,
  probeSweepTtl,
  type DurabilityProbeOpts,
  type ProbeResult,
  type SweepProbeOpts,
} from './testing.js';
