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
 * needs to ship a prompt visualizer). `llm_response` and
 * `turn_dispatch_complete` complete the per-iteration wall-clock
 * triple — request-dispatched, response-completed, tool-dispatch-
 * completed — that the eval harness uses to split language-model
 * time from tool-dispatch time.
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
  /** Wall-clock ms captured immediately before the strategy hands
   *  the request to `LlmClient.chat()`. Pair with
   *  `LlmResponseTrace.ts` (response completed) and
   *  `TurnDispatchCompleteTrace.ts` (tool dispatch completed) to
   *  derive the language-model vs tool-dispatch wall-clock split for
   *  this iteration. */
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
 * Response-side snapshot. Emitted once per ReAct iteration, paired
 * one-to-one with `LlmRequestTrace` via `requestId`. Captures the
 * full assistant output and the timestamp at which the chat()
 * iterator drained — `ts - LlmRequestTrace.ts` is the iteration's
 * language-model wall-clock segment.
 */
export interface LlmResponseTrace {
  /** Same id as the matching `LlmRequestTrace.requestId`. */
  requestId: string;
  /** Wall-clock ms captured immediately after the `chat()` iterator
   *  has yielded its terminal event for this iteration (typically
   *  `turn_complete`, or `error` on a streaming failure). Not
   *  emitted on mid-stream error — callers should treat a missing
   *  `llm_response` as "language-model time unknown for this
   *  iteration." */
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

/**
 * End-of-iteration tool-dispatch marker. Emitted once per ReAct
 * iteration that actually ran tool calls, immediately after the
 * per-turn dispatch loop drained. Paired one-to-one with
 * `LlmResponseTrace` via `requestId`. NOT emitted for the final
 * assistant turn (no tool calls → no dispatch segment to close).
 *
 * `ts - LlmResponseTrace.ts` is the iteration's tool-dispatch
 * wall-clock segment; `ts - LlmRequestTrace.ts` is the iteration's
 * total wall-clock from request dispatch through tool-result append.
 *
 * Only the aggregate is captured. Per-tool wall-clock can be added
 * later — the existing `tool_call`/`tool_result` events on the
 * strategy event stream are the right place for that, not the
 * trace.
 */
export interface TurnDispatchCompleteTrace {
  /** Same id as the matching `LlmRequestTrace.requestId`. */
  requestId: string;
  /** Mirror of `LlmRequestTrace.turnId`, carried for grouping
   *  consumers that key by turn rather than by iteration. */
  turnId: string;
  /** 0-indexed ReAct iteration within the turn. Mirrors
   *  `LlmRequestTrace.iteration`. */
  iteration: number;
  /** Wall-clock ms captured immediately after the last tool result
   *  for this iteration was appended to the messages array, before
   *  the loop steps to the next iteration. */
  ts: number;
  /** Number of tool calls executed in this iteration. Always >= 1
   *  in practice (an iteration with zero tool calls does not emit
   *  this event). */
  toolCallCount: number;
}

export type TraceEvent =
  | { kind: 'llm_request'; data: LlmRequestTrace }
  | { kind: 'llm_response'; data: LlmResponseTrace }
  | { kind: 'turn_dispatch_complete'; data: TurnDispatchCompleteTrace };

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
