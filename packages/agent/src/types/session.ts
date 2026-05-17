/**
 * `AgentSession` + `SessionEvent` — host-facing surfaces for one
 * in-flight agent run.
 *
 * The session is a generic container — it owns the id, the workspace
 * + runtime references, the cancellation token, and the typed event
 * stream. The actual inference algorithm lives in an `AgentStrategy`
 * (`./strategy.ts`).
 */

import type { ChatMessage, TurnDetails, TurnMetrics } from './chat.js';
import type { LlmClient } from './llm.js';
import type { MetricsCollector } from './metrics.js';
import type { RuntimeState } from './runtime.js';
import type { AgentStrategy } from './strategy.js';
import type { ToolContext, ToolDispatch, ToolHandler, ToolResult } from './tools.js';
import type { Tracer } from './trace.js';
import type { Workspace } from './workspace.js';

export interface AgentSessionConfig {
  /** Pluggable inference algorithm. See `./strategy.ts`. */
  strategy: AgentStrategy;
  llm: LlmClient;
  tools: ToolDispatch;
  /** Tool declarations the LLM should see this turn. Caller filters by
   *  capabilities before construction. Empty list disables function
   *  calling and the LLM is driven via plain-chat — typically a host
   *  bug rather than an intended state. */
  toolList: ToolHandler[];
  /** Factory producing a fresh `ToolContext` for each tool exec — lets the
   *  session thread its current workspace/runtime through without
   *  closing over stale references. */
  toolContext(): ToolContext;
  /** Build the system prompt from live workspace + runtime. */
  systemPromptBuilder(workspace: Workspace, runtime: RuntimeState): string;
  metrics: MetricsCollector;
  /** Empty for fresh sessions; loaded for resume. */
  history: ChatMessage[];
  /** Optional session id; one is generated when absent. */
  id?: string;
  /** Optional trace sink. Forwarded to the strategy alongside the
   *  session-owned `turnId` so the host can correlate
   *  `LlmRequestTrace.turnId` back to `SessionEvent`s. Absent =
   *  zero-cost no-op. */
  tracer?: Tracer;
}

export interface AgentSession {
  readonly id: string;
  readonly workspace: Workspace;
  readonly runtime: RuntimeState;
  /** Run one prompt to completion. The iterable closes when the run is done. */
  submit(prompt: string, signal: AbortSignal): AsyncIterable<SessionEvent>;
  /** Cancel any in-flight submit. Safe to call when idle. */
  cancel(): void;
}

export type SessionEvent =
  | { kind: 'turn_started'; turnId: string }
  | { kind: 'text'; turnId: string; chunk: string }
  | { kind: 'thinking'; turnId: string; chunk: string }
  | {
      kind: 'tool_started';
      turnId: string;
      callId: string;
      name: string;
      args: unknown;
      signature?: string;
    }
  | { kind: 'tool_finished'; turnId: string; callId: string; result: ToolResult }
  | { kind: 'workspace_changed'; workspace: Workspace }
  | { kind: 'runtime_changed'; runtime: RuntimeState }
  | { kind: 'turn_completed'; turnId: string; metrics: TurnMetrics; details: TurnDetails }
  | { kind: 'error'; turnId?: string; message: string }
  | { kind: 'completed' }
  /** Strategy-emitted milestones (planner phases, branch expansions, …)
   *  — generic envelope so new strategies can surface custom events
   *  without expanding the union. */
  | { kind: 'strategy_event'; name: string; data?: unknown };
