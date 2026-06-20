/**
 * `@inbrowser/relay` — resumable LLM inference relay.
 *
 * ONE root barrel, no subpaths. The relay, the SSE wire-format helpers,
 * the reconnecting client, and the Astro + Express adapters all hang off
 * this single entrypoint. The root barrel is browser-import-safe: the
 * Express adapter (re-exported below) keeps its `node:http` types
 * type-only and lazy-`import()`s `node:stream` inside the function that
 * uses it, so a browser bundle that imports `@inbrowser/relay` never
 * statically pulls a Node builtin.
 *
 * Built on `@inbrowser/resumable`. Wire format and provider plug-in
 * surface defined in `plans/resumable-and-llm-relay-extraction.md`.
 */
export {
  createRelay,
  type ApiKeySource,
  type CreateRelayOpts,
  type Relay,
  type StreamCtx,
} from './relay.js';
// The relay no longer owns providers — they live in `@inbrowser/model`
// as `ModelClientFactory`s (clean break, stage 4). Hosts import the
// factories from `@inbrowser/model/providers/<name>` and register them in
// `createRelay({ providers })`. `ModelClientFactory` is re-exported below
// for the registration site.

// Reconnecting consumer client. Available at `./client` for users who
// want narrow imports; also re-exported here because the common case
// is "consume the relay's stream from a browser/Node app" and forcing
// the subpath import for the universal client is friction without
// payoff (no peer-dep activation, no Node-only API leak —
// installBrowserLifecycle is SSR-safe; checks `typeof document`).
export {
  createResumableClient,
  installBrowserLifecycle,
  type ResumableClient,
  type ResumableClientOpts,
} from './client/index.js';

// SSE wire-format utilities. Re-exported because anyone writing a
// custom `ModelClient` that wraps an upstream SSE API needs them to
// parse the feed. Internal use today is via `./sse`; root re-export
// removes the "didn't know it existed" gotcha.
export {
  encodeSseEvent,
  readSseDataLines,
  SSE_DONE_LINE,
  SSE_STREAM_OPEN,
} from './sse.js';

// `ModelClientFactory` is the shape `createRelay`'s `providers` map holds
// (sourced from `@inbrowser/model`); re-exported here for the registration
// site so a host can type its provider map without a second import.
export type { ModelClientFactory } from '@inbrowser/model';

export type {
  Logger,
  NormalizedRequest,
  // The shared model-call contract, re-exported from the relay's import
  // site (sourced from `@inbrowser/model/contract`). There is no
  // relay-local `InferenceEvent` / `ChatMessage` / `ToolDecl` anymore.
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelUsage,
  ToolSpec,
  ReasoningEffort,
} from './types.js';

// Framework adapters (formerly the `./adapters/astro` + `./adapters/express`
// subpaths). Astro already speaks Web `Request`/`Response`, so its adapter is
// pure (type-only imports). The Express adapter is browser-import-safe: its
// `node:http` imports are type-only and it lazy-`import()`s `node:stream`
// inside the handler, so this root barrel never statically pulls `node:`.
export {
  createAstroRoutes,
  type AstroRoutes,
  type CreateAstroRoutesOpts,
} from './adapters/astro.js';

export {
  createExpressHandlers,
  type CreateExpressHandlersOpts,
  type ExpressHandlers,
} from './adapters/express.js';
