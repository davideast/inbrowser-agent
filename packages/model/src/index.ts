/**
 * `@inbrowser/model` — shared model contract and utilities.
 *
 * This root stays free of provider factories and the on-device engine:
 * - Cloud providers: `@inbrowser/model/providers/<name>`
 * - On-device inference: `@inbrowser/model/local`
 *
 * Importing this root never statically pulls a provider module or the
 * Transformers-backed engine into the consumer's graph.
 */

export {
  emptyModelUsage,
  normalizeModelUsage,
  sumModelUsage,
  type ModelUsageInput,
} from './usage.js';

export { withRetry, type WithRetryOpts } from './with-retry.js';

// Shared provider config + the factory type relay routes on.
export type { CloudProviderConfig, ModelClientFactory } from './providers/types.js';

// The shared model-call contract (cloud providers + on-device engine implement
// it; relay + agent consume it). Type-only; importing it pulls no runtime.
export type {
  ModelClient,
  ModelErrorEvent,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelUsage,
  ReasoningEffort,
  ToolSpec,
} from './contract.js';
