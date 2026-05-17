/**
 * Chat message shape — the cross-session transcript surface.
 *
 * Matches the playground's existing `ChatMessage` shape closely so
 * the React host can drop in `@inbrowser/agent` types without
 * rewriting render code. The neutral shape lets non-React hosts
 * (CLI, eval harness) consume the same transcripts.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Streaming flag — true while the LLM is still emitting chunks. */
  streaming?: boolean;
  /** Hidden reasoning ("thinking") text — surface only when the host opts in. */
  thinking?: string;
  toolCalls?: ToolCall[];
  /** Turn-scoped usage + cost — stamped on the assistant message at turn end. */
  metrics?: TurnMetrics;
  /** Per-turn detail block (servedModel, requestedModel, fingerprint, …). */
  details?: TurnDetails;
  /** Wall-clock milliseconds the turn took. */
  timestamp?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  argsJson: string;
  /** Stringified result; absent while the call is in flight. */
  resultJson?: string;
  ok?: boolean;
  /** Optional human-readable one-liner the model can quote on the next turn. */
  summary?: string;
  /** Provider-specific signature carried through round-trips (Gemini thoughtSignature). */
  signature?: string;
}

export interface TurnMetrics {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  costUsd: number;
  /** True when cost is computed client-side from a pricing table vs returned by the provider. */
  costEstimated?: boolean;
  /** True when the user supplied their own key — affects billing display. */
  isByok?: boolean;
}

export interface TurnDetails {
  /** The model name the host requested. */
  requestedModel: string;
  /** The model name the provider actually served (e.g. an OpenRouter routing fallback). */
  servedModel?: string;
  /** Provider-stable fingerprint when offered (Gemini systemFingerprint, OpenAI fingerprint). */
  fingerprint?: string;
  /** Free-form provider routing info (OpenRouter "provider" field, etc.). */
  routing?: Record<string, unknown>;
}

/** A normalized message shape providers consume — drops React-specific fields like `streaming`. */
export interface NormalizedMessage {
  role: ChatRole;
  text: string;
  toolCalls?: { callId: string; name: string; args: unknown; signature?: string }[];
  /** For `role: 'tool'` only — the result of a previous tool call. */
  callId?: string;
  name?: string;
  resultJson?: string;
}
