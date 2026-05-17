/**
 * `AgentStrategy` — the pluggable inference algorithm.
 *
 * The current ReAct-style single-loop behavior is one strategy;
 * future planner / graph / parallel-branch strategies are new files
 * implementing this same interface. The session's external event
 * surface stays stable; only the internals change.
 */

import type { ChatMessage, TurnDetails } from './chat.js';
import type { LlmClient, RawUsage } from './llm.js';
import type { RuntimeState } from './runtime.js';
import type { ToolContext, ToolDispatch, ToolHandler, ToolResult } from './tools.js';
import type { Tracer } from './trace.js';
import type { Workspace } from './workspace.js';

export interface AgentStrategy {
  readonly id: string;
  /**
   * Execute one user prompt to completion. Returns the strategy's
   * event stream — the session translates it into `SessionEvent`s.
   */
  run(input: StrategyRunInput, signal: AbortSignal): AsyncIterable<StrategyEvent>;
}

export interface StrategyRunInput {
  prompt: string;
  history: ChatMessage[];
  workspace: Workspace;
  runtime: RuntimeState;
  llm: LlmClient;
  tools: ToolDispatch;
  /** Already filtered by the active capabilities. */
  toolList: ToolHandler[];
  /** Factory — call per tool exec so the latest workspace/runtime flows in. */
  toolContext(): ToolContext;
  /** Pre-built by the session from `Workspace` + `RuntimeState`. */
  systemPrompt: string;
  /** Optional trace sink — emitted at well-defined moments in the
   *  loop (request about to dispatch; response complete). The
   *  strategy never inspects the impl. Absent = zero-cost no-op. */
  tracer?: Tracer;
  /** Optional session-scoped id used by the strategy when generating
   *  per-iteration `requestId`s. The session is what owns the turn
   *  identity; the strategy receives it for trace labeling only. */
  turnId?: string;
}

export type StrategyEvent =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown; signature?: string }
  | { kind: 'tool_result'; id: string; result: ToolResult }
  | { kind: 'turn_complete'; usage: RawUsage; details: TurnDetails }
  | { kind: 'error'; message: string }
  /** Custom milestone — name + arbitrary payload, surfaced as
   *  `SessionEvent.kind === 'strategy_event'` to the host. */
  | { kind: 'custom'; name: string; data?: unknown };

/**
 * Opt-in critique-and-retry pass after a candidate final-answer turn.
 *
 * When `enabled === true`, the ReAct loop runs as usual, but instead of
 * returning immediately on a turn that produced no tool calls the
 * strategy issues a second chat call asking the model to evaluate its
 * own last response against the prior tool results visible in the
 * conversation. The evaluation returns a JSON verdict of the shape
 * `{ "ok": boolean, "feedback"?: string }`. When the verdict is `ok`
 * the original answer stands. When the verdict flags problems and the
 * retry budget has not been exhausted, the strategy injects the
 * feedback as a synthetic user message and loops back into the next
 * ReAct iteration. When the retry budget is exhausted the strategy
 * returns the most recent final-answer turn as-is — reflexion never
 * blocks completion.
 *
 * A malformed verdict (non-JSON critique text, or JSON missing the
 * `ok` field) is treated as `{ ok: true }`: fail-open, never block on a
 * critique the strategy could not parse.
 *
 * The critique runs through the same `LlmClient` as the main loop; the
 * trace emits an additional `llm_request` for the critique call with a
 * `requestId` suffixed `#critique`, so trace consumers can distinguish
 * critique requests from main-loop requests. The strategy emits a
 * `custom` `StrategyEvent` named `'reflexion_critique'` with a
 * `{ verdict, text, feedback? }` payload at every critique decision.
 *
 * Defaults: `maxRetries: 1`. When `enabled === false` (or the option
 * is absent) the strategy's behavior is byte-for-byte identical to the
 * pre-reflexion loop.
 */
export interface ReflexionConfig {
  /** Opt-in switch. */
  enabled: boolean;
  /**
   * Maximum retries after the critique flags problems. Defaults to 1.
   * Setting to 0 disables retries entirely (the critique runs and its
   * verdict is emitted, but no retry is attempted on `ok: false`).
   */
  maxRetries?: number;
  /**
   * System prompt used for the critique call. Defaults to a neutral
   * prompt that asks the model to evaluate consistency with prior
   * tool results and reply with `{"ok": boolean, "feedback"?: string}`
   * JSON. Override when a skill needs a tighter verifier rubric.
   */
  critiqueSystemPrompt?: string;
}
