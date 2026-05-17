/**
 * `LlmClient` — narrow provider interface.
 *
 * Implementations live in adapter packages (one per provider). The
 * client knows about model calls and streamed events; it knows
 * **nothing** about BYOK forms, localStorage, model pickers, or
 * pricing tables. Receives its config explicitly at construction
 * time so concurrent sessions can use different keys/models against
 * the same provider without contention.
 */

import type { NormalizedMessage } from './chat.js';
import type { TurnDetails, TurnMetrics } from './chat.js';

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

export interface ChatRequest {
  messages: NormalizedMessage[];
  /** Tool declarations the model may invoke. Empty array → plain chat. */
  tools: ToolDeclaration[];
  /** Lighter than `tools.length === 0`; lets adapters skip tool-mode encoding entirely. */
  toolUseEnabled: boolean;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema describing the tool's arguments. */
  parameters: JsonSchema;
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

export interface LlmClient {
  readonly id: string;
  readonly supportsTools: boolean;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

export type ChatEvent =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown; signature?: string }
  | { kind: 'turn_complete'; usage: RawUsage; details: TurnDetails }
  | { kind: 'error'; message: string };

/**
 * Raw token usage as the provider reports it — interpreted by
 * `MetricsCollector` to derive `TurnMetrics` (cost, cached
 * fraction, reasoning fraction). Different providers report
 * different shapes; the collector handles them.
 */
export interface RawUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  /** Provider-supplied cost (OpenRouter), when available — bypasses pricing tables. */
  costUsd?: number;
}

export interface LlmClientFactory {
  create(config: LlmConfig): LlmClient;
}

/** Re-export so consumers don't have to dig into `./chat.js`. */
export type { TurnDetails, TurnMetrics };
