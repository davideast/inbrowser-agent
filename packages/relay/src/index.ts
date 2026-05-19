/**
 * `@inbrowser/relay` — resumable LLM inference relay.
 *
 * Built on `@inbrowser/resumable`. Wire format and provider plug-in
 * surface defined in `plans/resumable-and-llm-relay-extraction.md`.
 */
export { createRelay, type CreateRelayOpts, type Relay, type StreamCtx } from './relay.js';
export { geminiProvider } from './providers/gemini.js';
export { openrouterProvider } from './providers/openrouter.js';
export { anthropicProvider } from './providers/anthropic.js';
// ollamaProvider was added in the 0.2.0 cycle; the original three are
// re-exported from root for one-import-convenience, so include the
// fourth too (consistency, fixes a real consumer-side gotcha).
export { ollamaProvider } from './providers/ollama.js';

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
// custom InferenceProvider needs them to parse upstream SSE feeds.
// Internal use today is via `./sse`; root re-export removes the
// "didn't know it existed" gotcha.
export {
  encodeSseEvent,
  readSseDataLines,
  SSE_DONE_LINE,
  SSE_STREAM_OPEN,
} from './sse.js';

export type {
  InferenceEvent,
  InferenceProvider,
  LegacyChatMessage,
  LegacyToolDecl,
  Logger,
  NormalizedRequest,
  ReasoningEffort,
} from './types.js';
