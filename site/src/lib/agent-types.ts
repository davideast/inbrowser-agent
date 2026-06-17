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

/** Normalized events the agent streams to the browser as SSE. */
export type DocsAgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'visited'; card: VisitedCard }
  | { type: 'error'; message: string }
  | { type: 'done' };
