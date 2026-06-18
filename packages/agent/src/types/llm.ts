/**
 * The agent's model-call contract is now the shared `ModelClient`
 * contract from `@inbrowser/model/contract` — the one type the cloud
 * providers, the on-device engine, the relay (transport), and the
 * agent (runtime) all speak. This module re-exports it so the
 * `./types/llm.js` import site downstream code already uses keeps
 * working, and keeps the agent-local construction helpers (`LlmConfig`,
 * `LlmClientFactory`) plus the agent-local `JsonSchema` type.
 */

import type { ModelClient } from '@inbrowser/model/contract';

export type {
  ModelClient,
  ModelRequest,
  ModelEvent,
  ModelMessage,
  ModelUsage,
  ToolSpec,
  ReasoningEffort,
} from '@inbrowser/model/contract';

export interface LlmConfig {
  apiKey?: string;
  model: string;
  /** Base URL override (e.g. for OpenAI-compatible proxies). */
  baseUrl?: string;
  /** Reasoning effort for providers that support it (OpenRouter). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Caller-side flag — affects metrics' `isByok`. */
  isByok?: boolean;
}

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  [key: string]: unknown;
};

export interface LlmClientFactory {
  create(config: LlmConfig): ModelClient;
}

/** Re-export so consumers don't have to dig into `./chat.js`. */
export type { TurnDetails, TurnMetrics } from './chat.js';
