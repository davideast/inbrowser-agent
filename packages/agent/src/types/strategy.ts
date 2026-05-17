/**
 * `AgentStrategy` — the pluggable inference algorithm.
 *
 * The current ReAct-style single-loop behavior is one strategy;
 * future planner / graph / parallel-branch strategies are new files
 * implementing this same interface. The session's external event
 * surface stays stable; only the internals change.
 */

import type { Workspace } from './workspace.js';
import type { RuntimeState } from './runtime.js';
import type { ChatMessage, TurnDetails } from './chat.js';
import type { LlmClient, RawUsage } from './llm.js';
import type { ToolDispatch, ToolHandler, ToolContext, ToolResult } from './tools.js';
import type { Tracer } from './trace.js';

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
