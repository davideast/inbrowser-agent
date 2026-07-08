/**
 * `@inbrowser/model/contract` — the one model-call contract for the stack.
 *
 * A `ModelClient` is anything that, given a `ModelRequest`, streams `ModelEvent`s:
 * the cloud providers, the on-device engine, and any adapter all implement it.
 * Both `@inbrowser/relay` (transport) and `@inbrowser/agent` (runtime) consume a
 * `ModelClient`, so this is the single shared LLM contract.
 *
 * This module is TYPE-ONLY (zero runtime imports), so importing the contract
 * never pulls in the on-device engine or `@huggingface/transformers`.
 */

/** A turn of the conversation handed to a model. */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  /** Tool calls the assistant made (assistant turns). */
  toolCalls?: { id: string; name: string; args: unknown; signature?: string }[];
  /** The call this message answers (tool-result turns). */
  toolCallId?: string;
  /** Tool name (tool-result turns). */
  name?: string;
  /** Serialized tool result (tool-result turns). */
  resultJson?: string;
}

/**
 * Tool declaration in the OAI function-calling shape that modern chat templates
 * accept directly (Qwen, DeepSeek, Llama 3.2+, etc.). Cloud providers that speak
 * a different wire shape translate internally.
 */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

/** A single model call. */
export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolSpec[];
  /** Whether tool use is enabled this turn (cheaper than checking tools.length). */
  toolUseEnabled: boolean;
  temperature?: number;
  topP?: number;
  topK?: number;
  reasoningEffort?: ReasoningEffort;
}

/** Token + cost accounting for one turn. */
export interface ModelUsage {
  promptTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  /** Reasoning tokens, when a provider reports them. */
  reasoningTokens?: number;
  /** Real dollar cost, when a provider reports it (e.g. OpenRouter). */
  costUsd?: number;
}

/**
 * One streamed item from a model call.
 *
 * The turn ends when the async iterable returns. On a normal end a `usage` event
 * MUST be emitted before the return (it carries the final accounting); there is
 * no separate terminal event. The exception is `error`, which is itself terminal:
 * after an `error` event the iterable returns with no `usage` event. Consumers
 * can therefore rely on exactly one of {a `usage` event, an `error` event} per
 * turn.
 */
export interface ModelErrorEvent {
  kind: 'error';
  message: string;
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export type ModelEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown; signature?: string }
  | { kind: 'usage'; usage: ModelUsage }
  | ModelErrorEvent;

/**
 * The one model-call contract. Implemented by the cloud providers and the
 * on-device engine; consumed by the relay (transport) and the agent (runtime).
 */
export interface ModelClient {
  /** Stable id for metrics + provenance, e.g. `gemini:gemini-3.5-flash`. */
  readonly id: string;
  readonly supportsTools: boolean;
  chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
