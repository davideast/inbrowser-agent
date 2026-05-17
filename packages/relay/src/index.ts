/**
 * `@inbrowser/relay` — resumable LLM inference relay.
 *
 * Built on `@inbrowser/resumable`. Wire format and provider plug-in
 * surface defined in `plans/resumable-and-llm-relay-extraction.md`.
 */
export { createRelay, type CreateRelayOpts, type Relay, type StreamCtx } from './relay';
export { geminiProvider } from './providers/gemini';
export { openrouterProvider } from './providers/openrouter';
export { anthropicProvider } from './providers/anthropic';

export type {
  InferenceEvent,
  InferenceProvider,
  LegacyChatMessage,
  LegacyToolDecl,
  Logger,
  NormalizedRequest,
  ReasoningEffort,
} from './types';
