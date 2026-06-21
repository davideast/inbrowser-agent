import type { TurnDetails } from '@inbrowser/agent';
import type { TraceEvent } from '@inbrowser/agent';
import type { AggregatedTurnMetrics, ContextWindowTraceHostContext } from '@inbrowser/agent/usage';

/**
 * Client-safe shared types for the agent stream. Pure types, no runtime
 * imports, so both the server agent and the browser UI can import them.
 */

export interface VisitedCard {
  route: string;
  title: string;
  package: string;
  packageLabel: string;
  breadcrumb: string[];
  summary: string;
}

/** One turn of the visible conversation sent to the agent. */
export interface TurnMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** One entry in the agent's activity log (a tool call it made). Persisted on
 *  the assistant turn so the log survives streaming, scroll-back, and reload. */
export interface AgentStep {
  name: string;
  detail: string;
}

export type AgentTurnMetrics = AggregatedTurnMetrics;

/** Normalized events the agent streams to the browser as SSE. */
export type DocsAgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'visited'; card: VisitedCard }
  | { type: 'error'; message: string }
  | { type: 'done' };

/**
 * Handlers the client-side agent runner dispatches its events to, so the chat
 * UI is identical regardless of which `ModelClient` produced the answer. Pure
 * types, client-safe — lives here so consumers don't import the (deleted)
 * server stream client.
 */
export interface AgentStreamHandlers {
  onTurnStarted?(turnId: string): void;
  onTrace?(event: TraceEvent, hostContext?: ContextWindowTraceHostContext): void;
  onUsage?(turnId: string, metrics: AgentTurnMetrics, details: TurnDetails): void;
  onToken?(text: string): void;
  onTool?(name: string, detail: string): void;
  onVisited?(card: VisitedCard): void;
  onError?(message: string): void;
  onDone?(): void;
}
