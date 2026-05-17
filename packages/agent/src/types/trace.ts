/**
 * Agent-loop request/response trace surface.
 *
 * Captures the exact shape of every LLM request the strategy
 * dispatches — system prompt + messages + tool decls + model — at
 * the layer the agent author thinks in (`@inbrowser/agent` types), not
 * the provider-specific transform below it. A provider-level trace
 * (Gemini's `GeminiBody`, OpenRouter's `messages[].content` parts)
 * is a complementary concern that belongs to `@inbrowser/relay`;
 * this surface is for "what did the model see, in agent terms."
 *
 * Emission is opt-in. A `Tracer` plugs into `AgentSessionConfig`
 * (which threads it through `StrategyRunInput`); strategies that
 * support tracing call `tracer.emit(...)` at well-defined moments.
 * Strategies without a tracer field — or sessions that don't pass
 * one — incur zero cost.
 *
 * Phase 1 captures `llm_request` only (the priority the playground
 * needs to ship a prompt visualizer). `llm_response` shape is
 * defined here so consumers can write against the full union from
 * day one; emit-site wiring lands in Phase 2.
 */

import type { NormalizedMessage } from './chat.js';

/**
 * Wire-level snapshot of a single LLM request as it leaves the
 * strategy. Captured exactly once per ReAct iteration — N times per
 * user prompt, where N >= 1 (final-answer turn) and grows by 1 per
 * tool-using iteration.
 */
export interface LlmRequestTrace {
  /** Stable per-iteration id, scoped to its session. The recommended
   *  format is `${turnId}#${iteration}`; the agent loop generates
   *  the value, hosts treat it as opaque. */
  requestId: string;
  /** The session-scoped turn id (matches `SessionEvent.turnId`). */
  turnId: string;
  /** 0-indexed ReAct iteration within this turn. */
  iteration: number;
  /** Wall-clock ms at the moment the request was about to dispatch. */
  ts: number;
  /** The system-prompt string the strategy received from
   *  `StrategyRunInput.systemPrompt`. Captured verbatim. */
  systemPrompt: string;
  /** The messages array exactly as the provider will see it. Includes
   *  the synthesized leading system message, the prior history, the
   *  current user prompt, and any assistant+tool entries the ReAct
   *  loop appended this turn. */
  messages: NormalizedMessage[];
  /** Tool declarations as filtered + shaped by the strategy. The
   *  `parameters` value is captured opaquely — providers normalize
   *  it (Gemini sanitizes; OpenRouter is permissive), so the trace
   *  shows the pre-provider canonical view. */
  tools: ToolDeclarationView[];
  /** Agent-loop-level model identity. The host enriches this with
   *  provider label / model label / temperature / reasoning-effort
   *  at consumption time — those values aren't visible to the
   *  strategy. */
  llm: { id: string; supportsTools: boolean };
}

/**
 * Tool-decl row as the agent loop produced it pre-provider. Mirrors
 * the `toolDecls` shape strategy.ts builds when constructing the
 * `ChatRequest`. Not coupled to the in-process `ToolHandler` type —
 * the trace is a wire snapshot, not a live handle.
 */
export interface ToolDeclarationView {
  name: string;
  description: string;
  parameters: unknown;
}

/**
 * Response-side snapshot. Defined now so consumers can switch on
 * `TraceEvent.kind` and handle the full union from the start. The
 * emit-site in `strategy.ts` lands in Phase 2 — strategies are free
 * to emit it earlier when the data is available.
 */
export interface LlmResponseTrace {
  /** Same id as the matching `LlmRequestTrace.requestId`. */
  requestId: string;
  /** Wall-clock ms when the chat() iterator completed. */
  ts: number;
  /** Full assistant text emitted this iteration. */
  text: string;
  /** Hidden reasoning when the model surfaces it. Empty string for
   *  non-reasoning models. */
  thinking: string;
  /** Tool calls the model chose to emit this iteration. */
  toolCalls: {
    id: string;
    name: string;
    args: unknown;
    signature?: string;
  }[];
  /** Provider-reported usage; absent on error / streaming-cancel /
   *  for providers that don't surface usage. */
  usage?: { promptTokens: number; outputTokens: number; cachedTokens?: number };
}

export type TraceEvent =
  | { kind: 'llm_request'; data: LlmRequestTrace }
  | { kind: 'llm_response'; data: LlmResponseTrace };

/**
 * Pluggable trace sink. Hosts implement `emit()` to push events to a
 * UI store, a NDJSON file, an eval harness, etc. The agent loop
 * never inspects the implementation — it just hands off the event.
 *
 * Implementations MUST be synchronous and non-throwing. The agent
 * loop intentionally doesn't `await` emit; surfacing a trace must
 * never delay an LLM dispatch or fail it. If a host needs async
 * work (network ship, etc.), it should queue internally.
 */
export interface Tracer {
  emit(event: TraceEvent): void;
}
