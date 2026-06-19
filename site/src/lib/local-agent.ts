/**
 * Shared client-side agent runner. Drives the SAME agent loop the server runs,
 * but entirely in the browser, against ANY `ModelClient` — the on-device engine
 * (wrapped via `createEngineModelClient`), OpenRouter (browser-direct BYOK), or a
 * local Ollama server. Code does the doc retrieval (`createRetrievalStrategy`);
 * the model only writes a grounded answer. The graph tools + content graph are
 * client-safe, so nothing hits the server.
 *
 * This module imports ONLY `@inbrowser/agent` + the client graph tools + types —
 * no engine / worker / transformers imports — so the lean cloud/local providers
 * (OpenRouter, Ollama) don't drag the on-device engine into their bundle.
 */
import {
  type ChatMessage,
  type ModelClient,
  createAgentSession,
  createDispatch,
  createMetricsCollector,
  createRetrievalStrategy,
} from '@inbrowser/agent';
import { createGraphToolRegistry } from '../agent/graph-tools';
import type { VisitedCard } from './agent-types';
import type { AgentStreamHandlers } from './stream-client';

export const SYSTEM_PROMPT =
  'You are the documentation assistant for the "inbrowser" monorepo. Answer the ' +
  "user's question concisely and accurately, using only the provided documentation excerpts.";

/**
 * Run one question through the client-side agent against an arbitrary
 * `ModelClient`, dispatching SessionEvents to the same handlers the cloud path
 * uses (so the chat UI is identical regardless of source). The caller owns the
 * `ModelClient` lifecycle (engine load, key validation, …) and cancellation via
 * `signal`.
 */
export async function runLocalAgent(
  llm: ModelClient,
  question: string,
  history: { role: 'user' | 'assistant'; text: string }[],
  handlers: AgentStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const registry = createGraphToolRegistry();
  const hist: ChatMessage[] = history
    .filter((m) => m.text.trim())
    .map((m, i) => ({ id: `h${i}`, role: m.role, text: m.text }));

  const session = createAgentSession({
    strategy: createRetrievalStrategy(),
    llm,
    tools: createDispatch(registry),
    toolList: registry.list(),
    toolContext: () => ({ signal }),
    systemPromptBuilder: () => SYSTEM_PROMPT,
    metrics: createMetricsCollector(),
    history: hist,
  });

  const toolNames = new Map<string, string>();
  const seen = new Set<string>();

  try {
    for await (const ev of session.submit(question, signal)) {
      if (ev.kind === 'text') {
        if (ev.chunk) handlers.onToken?.(ev.chunk);
      } else if (ev.kind === 'tool_started') {
        toolNames.set(ev.callId, ev.name);
        handlers.onTool?.(ev.name, readArg(ev.args));
      } else if (ev.kind === 'tool_finished') {
        if (
          toolNames.get(ev.callId) === 'get_doc' &&
          ev.result.ok &&
          ev.result.data &&
          typeof ev.result.data === 'object'
        ) {
          const card = toCard(ev.result.data as Partial<VisitedCard>);
          if (card.route && !seen.has(card.route)) {
            seen.add(card.route);
            handlers.onVisited?.(card);
          }
        }
      } else if (ev.kind === 'error') {
        handlers.onError?.(ev.message);
        return;
      } else if (ev.kind === 'completed') {
        handlers.onDone?.();
        return;
      }
    }
    handlers.onDone?.();
  } catch (e) {
    handlers.onError?.(e instanceof Error ? e.message : String(e));
  }
}

function readArg(args: unknown): string {
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    if (typeof a.route === 'string') return a.route;
    if (typeof a.query === 'string') return a.query;
  }
  return '';
}

function toCard(d: Partial<VisitedCard>): VisitedCard {
  return {
    route: d.route ?? '',
    title: d.title ?? d.route ?? '',
    package: d.package ?? '',
    packageLabel: d.packageLabel ?? '',
    breadcrumb: d.breadcrumb ?? [],
    summary: d.summary ?? '',
  };
}
