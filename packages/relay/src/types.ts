/**
 * Public types for `@inbrowser/relay`.
 *
 * The relay routes on `NormalizedRequest.provider` — a string keyed
 * into the `providers` map at `createRelay` time. The chosen
 * `InferenceProvider` is just an async generator of `InferenceEvent`s;
 * the relay drives it under a `@inbrowser/resumable` engine, so every
 * provider gets durability + resume "for free" without per-provider
 * code.
 */

/**
 * One message in a chat-completion request. Provider-agnostic shape;
 * each provider adapter (Gemini, OpenRouter, Anthropic) translates
 * this into its native wire format.
 */
export interface LegacyChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: { callId: string; name: string; args: unknown; signature?: string }[];
  callId?: string;
  name?: string;
  resultJson?: string;
}

/** One tool declaration advertised to the LLM. */
export interface LegacyToolDecl {
  name: string;
  description: string;
  parameters: unknown;
}

/**
 * Reasoning effort. OpenRouter's REST surface uses this; Gemini
 * ignores it. New providers may interpret it however they like.
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

/**
 * The wire shape the relay accepts at `handleStart`. `provider` is
 * the routing key — looked up in `createRelay`'s `providers` map.
 * `apiKey` is BYOK and round-trips to the provider; the relay treats
 * it as opaque.
 */
export interface NormalizedRequest {
  provider: string;
  model: string;
  messages: LegacyChatMessage[];
  tools: LegacyToolDecl[];
  apiKey: string;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  topP?: number;
  topK?: number;
  /**
   * Optional — propagated to the provider and used to abort upstream
   * fetches when the caller cancels. The relay layer manages its own
   * signal for the durable producer; this one is for consumer-side
   * cancellation when the call runs page-direct.
   */
  signal?: AbortSignal;
}

/**
 * The streamed event union producers yield: incremental text and
 * thinking, structured `tool_call`s, terminal `usage`, and `error`.
 *
 * The shape is intentionally provider-agnostic — Gemini's
 * `thoughtSignature` is a free-form `signature` field; OpenRouter's
 * dollar cost is a free-form `costUsd`. New providers extend the
 * union by adding fields, not new kinds.
 */
export type InferenceEvent =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | {
      kind: 'tool_call';
      callId: string;
      name: string;
      args: unknown;
      /** Gemini 3 thoughtSignature — opaque, echoed on tool-result. */
      signature?: string;
    }
  | {
      kind: 'usage';
      promptTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      /** Real dollar cost when the provider reports it (OpenRouter). */
      costUsd?: number;
    }
  | { kind: 'error'; message: string };

/**
 * The provider plug-in surface. Each provider is just an async
 * generator of `InferenceEvent`s for a given `NormalizedRequest`.
 * Pure function — the relay handles durability, resumability, and
 * HTTP transport; the provider only handles the upstream protocol.
 *
 * A provider that throws is wrapped by the engine as
 * `finish(jobId, 'error', message)`. To surface a clean error to
 * the client, yield `{ kind: 'error', message }` and return — same
 * effect, but the event also flows down the stream.
 */
export type InferenceProvider = (req: NormalizedRequest) => AsyncIterable<InferenceEvent>;

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
