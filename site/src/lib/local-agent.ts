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
  type AgentStrategy,
  type ChatMessage,
  type ModelClient,
  createAgentSession,
  createDispatch,
  createMetricsCollector,
  createRetrievalStrategy,
} from '@inbrowser/agent';
import { createGraphToolRegistry } from '../agent/graph-tools';
import type { AgentStreamHandlers, VisitedCard } from './agent-types';

/**
 * One unit of agent output, as plain structured-clone-serializable data (no
 * functions, no signals). This is the event type both the inline on-device path
 * and the durable cloud job stream over: the durable-jobs `JobEngine` persists
 * each one to IndexedDB and replays it on resume, so it MUST stay a plain value.
 * (`VisitedCard` is already a flat data record, so it's clone-safe.) Completion
 * and error are NOT members — `agentEvents` signals those by returning (done) or
 * throwing (error), which is exactly what the durable producer contract wants.
 */
export type DurableEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'visited'; card: VisitedCard };

/** Per-run knobs shared by `agentEvents` and `runLocalAgent`. */
export interface AgentRunOpts {
  strategy?: AgentStrategy;
  systemPrompt?: string;
}

export const SYSTEM_PROMPT =
  'You are the documentation assistant for the "inbrowser" monorepo. Answer the ' +
  "user's question concisely and accurately, using only the provided documentation excerpts.";

/**
 * ReAct system prompt for capable cloud models (Gemini, OpenRouter). Ported from
 * the (deleted) server docs-agent: the model drives a multi-tool lookup loop
 * (search/get_doc) rather than the single-shot retrieval the tiny on-device
 * model uses. No qwen `/no_think` prefix here — that was Ollama-only.
 */
export const REACT_SYSTEM_PROMPT = `You are the documentation assistant for the "inbrowser" monorepo (packages: agent, relay, resumable, model).

Answer the user's question using ONLY the documentation, looked up with the provided tools:
- search_docs(query): find relevant pages.
- get_doc(route): read a page's full content.
- related_docs(route), list_packages(), list_docs(package): orient if needed.

BE DECISIVE. Use AT MOST 3 tool calls total: typically one search_docs, then get_doc on the single best page, then ANSWER. Do not call list_packages/list_docs unless the question is about which packages exist. Never repeat a tool call. Once you have read a relevant page, STOP looking things up and write the answer.

Ground every claim in what you read. Be concise (a short paragraph or a few bullets). Name the doc pages you used. If the docs don't cover it, say so.`;

/**
 * The reusable event CORE of the agent loop. Drives the client-side agent
 * against an arbitrary `ModelClient` and YIELDS each unit of output as a plain
 * `DurableEvent` instead of calling handlers — so the SAME loop can run inline
 * (on-device) or inside the durable-jobs worker (cloud), where the yielded
 * values are persisted + replayed.
 *
 * Completion and error follow the async-generator / durable-producer contract:
 * normal return = the agent completed (the engine finishes 'done'); a thrown
 * error = the agent failed (the engine finishes 'error'). The caller owns the
 * `ModelClient` lifecycle and cancellation via `opts.signal`.
 *
 * This mirrors the dispatch the old `runLocalAgent` did one-for-one: `text` →
 * `token`, `tool_started` → `tool`, the deduped `get_doc` result → `visited`,
 * `error` → throw, `completed`/stream-end → return.
 */
export async function* agentEvents(
  llm: ModelClient,
  question: string,
  history: { role: 'user' | 'assistant'; text: string }[],
  opts: AgentRunOpts & { signal: AbortSignal },
): AsyncIterable<DurableEvent> {
  const { signal } = opts;
  const registry = createGraphToolRegistry();
  const hist: ChatMessage[] = history
    .filter((m) => m.text.trim())
    .map((m, i) => ({ id: `h${i}`, role: m.role, text: m.text }));

  // On-device (tiny model) defaults: single-shot retrieval + the terse prompt.
  // Capable cloud models pass a ReAct strategy + REACT_SYSTEM_PROMPT.
  const strategy = opts.strategy ?? createRetrievalStrategy();
  const systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;

  const session = createAgentSession({
    strategy,
    llm,
    tools: createDispatch(registry),
    toolList: registry.list(),
    toolContext: () => ({ signal }),
    systemPromptBuilder: () => systemPrompt,
    metrics: createMetricsCollector(),
    history: hist,
  });

  const toolNames = new Map<string, string>();
  const seen = new Set<string>();

  for await (const ev of session.submit(question, signal)) {
    if (ev.kind === 'text') {
      if (ev.chunk) yield { kind: 'token', text: ev.chunk };
    } else if (ev.kind === 'tool_started') {
      toolNames.set(ev.callId, ev.name);
      yield { kind: 'tool', name: ev.name, detail: readArg(ev.args) };
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
          yield { kind: 'visited', card };
        }
      }
    } else if (ev.kind === 'error') {
      // Surface as a thrown error so the durable producer finishes 'error'; the
      // inline wrapper catches it and calls `onError` (same as before).
      throw new Error(ev.message);
    } else if (ev.kind === 'completed') {
      return;
    }
  }
}

/**
 * Run one question through the client-side agent against an arbitrary
 * `ModelClient`, dispatching the loop's events to the same handlers the cloud
 * path uses (so the chat UI is identical regardless of source). A thin wrapper
 * over `agentEvents`: for-await each `DurableEvent` to a handler, then call
 * `onDone` on completion or `onError` on failure — byte-for-byte the behavior of
 * the prior inline implementation (this is the ON-DEVICE inline path). The
 * caller owns the `ModelClient` lifecycle and cancellation via `signal`.
 */
export async function runLocalAgent(
  llm: ModelClient,
  question: string,
  history: { role: 'user' | 'assistant'; text: string }[],
  handlers: AgentStreamHandlers,
  signal: AbortSignal,
  opts?: AgentRunOpts,
): Promise<void> {
  try {
    for await (const ev of agentEvents(llm, question, history, { ...opts, signal })) {
      dispatchDurableEvent(ev, handlers);
    }
    handlers.onDone?.();
  } catch (e) {
    handlers.onError?.(e instanceof Error ? e.message : String(e));
  }
}

/** Dispatch one `DurableEvent` to the stream handlers. Shared by the inline
 *  wrapper and the durable subscription mapping, so both produce identical UX. */
export function dispatchDurableEvent(ev: DurableEvent, handlers: AgentStreamHandlers): void {
  if (ev.kind === 'token') handlers.onToken?.(ev.text);
  else if (ev.kind === 'tool') handlers.onTool?.(ev.name, ev.detail);
  else if (ev.kind === 'visited') handlers.onVisited?.(ev.card);
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
