/**
 * Server-side docs agent. Runs an @inbrowser/agent ReAct loop equipped
 * with the read-only graph tools, backed by a relay provider (default
 * Gemini Flash; Ollama optional via DOCS_AGENT_PROVIDER). Streams a
 * normalized event union the /api/ask endpoint forwards to the browser
 * as SSE.
 *
 *   token   - a chunk of the visible answer (qwen3 <think> stripped)
 *   tool    - the agent invoked a graph tool (status: searching/reading)
 *   visited - the agent opened a doc page (drives a nav card)
 *   error   - the run failed
 *   done    - the run finished
 */
import {
  type RuntimeState,
  type Workspace,
  createAgentSession,
  createDispatch,
  createMetricsCollector,
  createReactLoopStrategy,
} from '@inbrowser/agent';
import type { ChatMessage, ModelClient } from '@inbrowser/agent';
import { geminiProvider, ollamaProvider } from '@inbrowser/relay';
import type { DocsAgentEvent, TurnMessage, VisitedCard } from '../lib/agent-types';
import { getNode, searchDocs } from '../lib/graph';
import { relayModelClient } from '../lib/relay-client';
import { createGraphToolRegistry } from './graph-tools';

export type { DocsAgentEvent, TurnMessage, VisitedCard } from '../lib/agent-types';

// Backend is provider-switchable via env (default: Gemini Flash; set
// DOCS_AGENT_PROVIDER=ollama to use a local model). Read via
// import.meta.env so `astro dev` picks values up from site/.env, with a
// process.env fallback for runtime/CI.
const PROVIDER = import.meta.env.DOCS_AGENT_PROVIDER ?? process.env.DOCS_AGENT_PROVIDER ?? 'gemini';
const GEMINI_API_KEY = import.meta.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
const OLLAMA_BASE_URL =
  import.meta.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const MODEL =
  import.meta.env.DOCS_AGENT_MODEL ??
  process.env.DOCS_AGENT_MODEL ??
  (PROVIDER === 'ollama' ? 'qwen3:4b' : 'gemini-3.5-flash');

const isOllama = PROVIDER === 'ollama';

function buildLlm() {
  if (isOllama) {
    return relayModelClient({
      provider: ollamaProvider,
      providerName: 'ollama',
      model: MODEL,
      apiKey: OLLAMA_BASE_URL,
      temperature: 0.2,
    });
  }
  return relayModelClient({
    provider: geminiProvider,
    providerName: 'gemini',
    model: MODEL,
    apiKey: GEMINI_API_KEY,
    temperature: 0.2,
  });
}

// `/no_think` is a qwen3 directive; only prepend it for Ollama.
const SYSTEM_PROMPT = `${isOllama ? '/no_think\n' : ''}You are the documentation assistant for the "inbrowser" monorepo (packages: agent, relay, resumable, model).

Answer the user's question using ONLY the documentation, looked up with the provided tools:
- search_docs(query): find relevant pages.
- get_doc(route): read a page's full content.
- related_docs(route), list_packages(), list_docs(package): orient if needed.

BE DECISIVE. Use AT MOST 3 tool calls total: typically one search_docs, then get_doc on the single best page, then ANSWER. Do not call list_packages/list_docs unless the question is about which packages exist. Never repeat a tool call. Once you have read a relevant page, STOP looking things up and write the answer.

Ground every claim in what you read. Be concise (a short paragraph or a few bullets). Name the doc pages you used. If the docs don't cover it, say so.`;

// Used for the grounded fallback when the agent over-explores.
const FALLBACK_SYSTEM = `You are the documentation assistant for the "inbrowser" monorepo. Answer the question using ONLY the documentation provided below. Be concise (a short paragraph or a few bullets), name the doc pages you used, and if the docs don't cover it, say so.`;

// Keep at most this many prior turns as context (bounds prompt size).
const MAX_HISTORY_TURNS = 8;

/** Longest suffix of `s` that is a proper prefix of `tag`. */
function partialTailLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (tag.startsWith(s.slice(s.length - k))) return k;
  }
  return 0;
}

/** Stateful filter that strips qwen3 `<think>...</think>` spans from a
 *  token stream, tolerant of tags split across chunks. */
function makeThinkStripper() {
  let inThink = false;
  let carry = '';
  return {
    feed(chunk: string): string {
      let s = carry + chunk;
      carry = '';
      let out = '';
      while (s.length) {
        if (!inThink) {
          const i = s.indexOf('<think>');
          if (i === -1) {
            const keep = partialTailLen(s, '<think>');
            out += s.slice(0, s.length - keep);
            carry = s.slice(s.length - keep);
            break;
          }
          out += s.slice(0, i);
          s = s.slice(i + '<think>'.length);
          inThink = true;
        } else {
          const j = s.indexOf('</think>');
          if (j === -1) {
            carry = s.slice(s.length - partialTailLen(s, '</think>'));
            break;
          }
          s = s.slice(j + '</think>'.length);
          inThink = false;
        }
      }
      return out;
    },
    flush(): string {
      const rest = inThink ? '' : carry;
      carry = '';
      return rest;
    },
  };
}

/** Single-question convenience wrapper (the landing keystone). */
export function askDocs(question: string, signal: AbortSignal): AsyncIterable<DocsAgentEvent> {
  return runDocsAgent([{ role: 'user', text: question }], signal);
}

/**
 * Run the docs agent over a conversation. The last message must be the
 * user's latest turn; earlier messages seed the session history so the
 * agent can answer follow-ups in context.
 */
export async function* runDocsAgent(
  messages: TurnMessage[],
  signal: AbortSignal,
): AsyncIterable<DocsAgentEvent> {
  if (!isOllama && !GEMINI_API_KEY) {
    yield {
      type: 'error',
      message:
        'GEMINI_API_KEY is not set — add it to site/.env (or set DOCS_AGENT_PROVIDER=ollama).',
    };
    return;
  }

  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== 'user' || !latest.text.trim()) {
    yield { type: 'error', message: 'the last message must be a non-empty user turn' };
    return;
  }
  const question = latest.text.trim();

  // Seed history with the prior turns (capped, non-empty), as ChatMessage[].
  const prior = messages
    .slice(0, -1)
    .filter((m) => m.text.trim())
    .slice(-MAX_HISTORY_TURNS);
  const history: ChatMessage[] = prior.map((m, i) => ({
    id: `h${i}`,
    role: m.role,
    text: m.text,
  }));

  const llm = buildLlm();
  const registry = createGraphToolRegistry();
  const session = createAgentSession({
    strategy: createReactLoopStrategy({ maxTurns: 10 }),
    llm,
    tools: createDispatch(registry),
    toolList: registry.list(),
    toolContext: () => ({ signal }),
    systemPromptBuilder: (_w: Workspace, _r: RuntimeState) => SYSTEM_PROMPT,
    metrics: createMetricsCollector(),
    history,
  });

  const stripper = makeThinkStripper();
  const seen = new Set<string>();
  // tool_finished carries only callId + result, so map callId -> name.
  const toolNames = new Map<string, string>();
  // Fallback cards: if the model answers straight from search_docs
  // without ever calling get_doc, surface the top search hits so the
  // "Sources" section is never empty.
  let lastSearchHits: VisitedCard[] = [];

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

  let hadAnswer = false;
  let degrade = false;
  let degradeMsg = '';

  try {
    for await (const ev of session.submit(question, signal)) {
      if (ev.kind === 'text') {
        const visible = stripper.feed(ev.chunk);
        if (visible) {
          hadAnswer = true;
          yield { type: 'token', text: visible };
        }
      } else if (ev.kind === 'tool_started') {
        toolNames.set(ev.callId, ev.name);
        const route =
          ev.args && typeof ev.args === 'object' && 'route' in ev.args
            ? String((ev.args as { route: unknown }).route)
            : ev.args && typeof ev.args === 'object' && 'query' in ev.args
              ? String((ev.args as { query: unknown }).query)
              : '';
        yield { type: 'tool', name: ev.name, detail: route };
      } else if (ev.kind === 'tool_finished') {
        const name = toolNames.get(ev.callId);
        const r = ev.result;
        if (name === 'get_doc' && r.ok && r.data && typeof r.data === 'object') {
          const card = toCard(r.data as Partial<VisitedCard>);
          if (card.route && !seen.has(card.route)) {
            seen.add(card.route);
            yield { type: 'visited', card };
          }
        } else if (name === 'search_docs' && r.ok && r.data && typeof r.data === 'object') {
          const hits = (r.data as { hits?: Partial<VisitedCard>[] }).hits ?? [];
          lastSearchHits = hits
            .slice(0, 3)
            .map(toCard)
            .filter((c) => c.route);
        }
      } else if (ev.kind === 'error') {
        // Any agent failure (turn cap, transient upstream after retries):
        // don't fail outright — degrade to a direct grounded completion.
        degrade = true;
        degradeMsg = ev.message;
        break;
      }
    }

    const tail = stripper.flush();
    if (tail) {
      hadAnswer = true;
      yield { type: 'token', text: tail };
    }

    // Graceful fallback: the loop failed (turn cap or upstream error)
    // without writing an answer. Ground a single no-tools completion on
    // the docs it already opened (or the top search hits for the
    // question) and stream that instead of failing.
    if (degrade && !hadAnswer) {
      const routes = seen.size > 0 ? [...seen] : lastSearchHits.map((c) => c.route);
      const docs = routes
        .map((r) => getNode(r))
        .filter((n): n is NonNullable<typeof n> => !!n)
        .slice(0, 3);
      const fallbackDocs = docs.length > 0 ? docs : topSearchNodes(question);

      // Surface any context docs not already carded.
      for (const d of fallbackDocs) {
        if (!seen.has(d.route)) {
          seen.add(d.route);
          yield { type: 'visited', card: toCard(d) };
        }
      }
      yield { type: 'tool', name: 'compose', detail: '' };
      let produced = false;
      for await (const text of groundedCompletion(question, fallbackDocs, llm, signal)) {
        const visible = stripper.feed(text);
        if (visible) {
          produced = true;
          yield { type: 'token', text: visible };
        }
      }
      const ftail = stripper.flush();
      if (ftail) {
        produced = true;
        yield { type: 'token', text: ftail };
      }
      // Even the grounded fallback failed — surface the error.
      if (!produced) {
        yield { type: 'error', message: degradeMsg || 'failed to produce an answer' };
        return;
      }
    }

    // No doc was opened at all — fall back to the last search hits as sources.
    if (seen.size === 0) {
      for (const card of lastSearchHits) {
        if (!seen.has(card.route)) {
          seen.add(card.route);
          yield { type: 'visited', card };
        }
      }
    }
    yield { type: 'done' };
  } catch (e) {
    yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Top search-hit nodes for a question (fallback context source). */
function topSearchNodes(question: string) {
  return searchDocs(question, 3)
    .map((h) => getNode(h.route))
    .filter((n): n is NonNullable<typeof n> => !!n);
}

/** One-shot, no-tools grounded completion over the given docs. Yields
 *  answer text chunks. Used when the agent loop over-explores. */
async function* groundedCompletion(
  question: string,
  docs: { title: string; route: string; body: string }[],
  llm: ModelClient,
  signal: AbortSignal,
): AsyncIterable<string> {
  const context = docs
    .map((d) => `## ${d.title} (${d.route})\n${d.body.slice(0, 3000)}`)
    .join('\n\n');
  for await (const e of llm.chat(
    {
      messages: [
        { role: 'system', text: FALLBACK_SYSTEM },
        { role: 'user', text: `${question}\n\nDocumentation:\n\n${context}` },
      ],
      tools: [],
      toolUseEnabled: false,
    },
    signal,
  )) {
    if (e.kind === 'text') yield e.text;
    else if (e.kind === 'error') return;
  }
}
