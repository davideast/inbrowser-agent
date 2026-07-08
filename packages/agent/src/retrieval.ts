/**
 * `createRetrievalStrategy()` — a code-orchestrated retrieve-then-read
 * (RAG) `AgentStrategy`.
 *
 * Where `createReactLoopStrategy` lets the model drive — deciding when
 * to call tools and when to stop — this strategy inverts the control
 * flow. The *code* does the retrieval (search + read top-K docs); the
 * model is invoked exactly ONCE, with NO tools advertised, to write a
 * grounded answer from the retrieved excerpts. This is the
 * "zero-agency" tier-1 shape from
 * `plans/retrieval-strategy-and-eval.md`: a small model (e.g. SmolLM2
 * 360M) that can't reliably emit tool calls or decide when to stop
 * still does one thing well — grounded generation over stuffed context.
 *
 * Lifecycle (`run`):
 *
 *   1. SEARCH (code). Synthesize a tool-call id, emit `tool_call`
 *      for the search tool with `{ query: input.prompt }`, dispatch it
 *      through `input.tools.execute`, emit `tool_result`.
 *   2. READ top-K (code). Pull routes from the search result via
 *      `extractRoutes`, take the first `topK`, and for each emit
 *      `tool_call`(read) → dispatch → `tool_result`. Collect the
 *      extracted text until `contextBudget` chars are reached.
 *   3. COMPOSE. Build `[system, ...history, user(composeContext(...))]`
 *      the same way the ReAct loop's `buildMessages` does — except the
 *      final user message is the grounded context+question, not the
 *      raw prompt.
 *   4. GENERATE. One `input.llm.chat({ messages, tools: [],
 *      toolUseEnabled: false })` call; map model `text` / `thinking` /
 *      `usage` / `error` events straight to `StrategyEvent`s.
 *   5. `turn_complete` carrying the captured usage.
 *
 * It emits the SAME `tool_call` / `tool_result` / `text` event surface
 * the ReAct loop does, so an existing host (cards, sources, streaming)
 * works unchanged — the only difference is the events are driven by
 * code, not the model.
 */

import type { TurnDetails } from './types/chat.js';
import type { ModelEvent, ModelMessage, ModelRequest, ModelUsage } from './types/llm.js';
import type { AgentStrategy, StrategyEvent, StrategyRunInput } from './types/strategy.js';

export interface RetrievalStrategyOpts {
  /** Tool that returns candidate doc hits for a query. Default `'search_docs'`. */
  searchTool?: string;
  /** Tool that returns a single doc's content by route. Default `'get_doc'`. */
  readTool?: string;
  /** How many of the search hits to read. Default 3. */
  topK?: number;
  /**
   * Pull the routes to read from the search tool's `ToolResult.data`.
   * Default: `(d as { hits: { route }[] }).hits.map((h) => h.route)`.
   */
  extractRoutes?(searchData: unknown): string[];
  /**
   * Pull the context text from a read tool's `ToolResult.data`.
   * Default: from `{ route, title, body }`.
   */
  extractText?(readData: unknown): { route: string; title: string; text: string };
  /**
   * Build the grounded user message from the question + retrieved docs.
   * Default: an instruction to answer ONLY from the excerpts and cite
   * the route(s), the labeled excerpts, then the question.
   */
  composeContext?(question: string, docs: { route: string; title: string; text: string }[]): string;
  /** Cap on total context chars fed to the model. Default ~6000. */
  contextBudget?: number;
}

const DEFAULT_SEARCH_TOOL = 'search_docs';
const DEFAULT_READ_TOOL = 'get_doc';
const DEFAULT_TOP_K = 3;
const DEFAULT_CONTEXT_BUDGET = 6000;

/** Default route extractor: `data.hits[].route`. Defensive against
 *  any non-conforming shape — returns `[]` rather than throwing so the
 *  strategy still completes (generating from whatever context it has). */
function defaultExtractRoutes(searchData: unknown): string[] {
  if (!searchData || typeof searchData !== 'object') return [];
  const hits = (searchData as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return [];
  const routes: string[] = [];
  for (const hit of hits) {
    if (hit && typeof hit === 'object') {
      const route = (hit as { route?: unknown }).route;
      if (typeof route === 'string' && route.length > 0) routes.push(route);
    }
  }
  return routes;
}

/** Default text extractor: from `{ route, title, body }`. */
function defaultExtractText(readData: unknown): { route: string; title: string; text: string } {
  const obj = (readData && typeof readData === 'object' ? readData : {}) as {
    route?: unknown;
    title?: unknown;
    body?: unknown;
  };
  return {
    route: typeof obj.route === 'string' ? obj.route : '',
    title: typeof obj.title === 'string' ? obj.title : '',
    text: typeof obj.body === 'string' ? obj.body : '',
  };
}

/** Default context composer: a tight grounding instruction, the
 *  labeled excerpts, then the question. Mirrors the wording in the
 *  plan: answer ONLY from the excerpts + cite the route(s). */
function defaultComposeContext(
  question: string,
  docs: { route: string; title: string; text: string }[],
): string {
  const instruction =
    'Answer the question using ONLY the documentation excerpts below. ' +
    'Cite the route(s) you used. If the answer is not in the excerpts, say so.';
  const excerpts = docs.map((doc) => `--- [${doc.route}] ${doc.title}\n${doc.text}`).join('\n\n');
  const excerptBlock =
    excerpts.length > 0 ? excerpts : '(no documentation excerpts were retrieved)';
  return `${instruction}\n\n${excerptBlock}\n\nQuestion: ${question}`;
}

/**
 * Build `[system, ...history, user(<groundedContext>)]`. Identical to
 * the ReAct loop's `buildMessages` except the trailing user message is
 * the grounded context rather than the raw prompt. This strategy never
 * encodes assistant tool-calls of its own — the only tool activity is
 * the code-driven retrieval, which the model never sees.
 */
function buildMessages(input: StrategyRunInput, groundedUserText: string): ModelMessage[] {
  const out: ModelMessage[] = [];
  out.push({ role: 'system', text: input.systemPrompt });
  for (const m of input.history) {
    if (m.role === 'system') continue; // already emitted
    if (m.role === 'assistant') {
      const tc =
        m.toolCalls?.map((c) => ({
          id: c.id,
          name: c.name,
          args: safeParse(c.argsJson),
          ...(c.signature ? { signature: c.signature } : {}),
        })) ?? [];
      out.push({
        role: 'assistant',
        text: m.text,
        ...(tc.length > 0 ? { toolCalls: tc } : {}),
      });
      for (const c of m.toolCalls ?? []) {
        if (c.resultJson !== undefined) {
          out.push({
            role: 'tool',
            toolCallId: c.id,
            name: c.name,
            resultJson: c.resultJson,
            text: '',
          });
        }
      }
    } else {
      out.push({ role: m.role, text: m.text });
    }
  }
  out.push({ role: 'user', text: groundedUserText });
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

let idSeq = 0;
/** Per-call id for the synthetic, code-driven tool calls. Mirrors the
 *  ReAct loop's per-iteration `requestId` discipline — the host only
 *  needs the id to be stable + unique across a single run so it can
 *  pair `tool_call` with `tool_result`. */
function rid(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}

export function createRetrievalStrategy(opts: RetrievalStrategyOpts = {}): AgentStrategy {
  const searchTool = opts.searchTool ?? DEFAULT_SEARCH_TOOL;
  const readTool = opts.readTool ?? DEFAULT_READ_TOOL;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const extractRoutes = opts.extractRoutes ?? defaultExtractRoutes;
  const extractText = opts.extractText ?? defaultExtractText;
  const composeContext = opts.composeContext ?? defaultComposeContext;
  const contextBudget = opts.contextBudget ?? DEFAULT_CONTEXT_BUDGET;

  return {
    id: 'retrieval',
    async *run(input: StrategyRunInput, signal: AbortSignal): AsyncIterable<StrategyEvent> {
      if (signal.aborted) {
        yield { kind: 'error', message: 'aborted' };
        return;
      }

      // 1. SEARCH (code-driven). Emit the same `tool_call` /
      //    `tool_result` surface the ReAct loop emits for a model-driven
      //    call, so the host's "searching" UI + Sources work unchanged.
      const searchId = rid('search');
      yield { kind: 'tool_call', id: searchId, name: searchTool, args: { query: input.prompt } };
      const searchResult = await input.tools.execute(
        { id: searchId, name: searchTool, args: { query: input.prompt } },
        input.toolContext(),
      );
      yield { kind: 'tool_result', id: searchId, result: searchResult };

      // 2. READ top-K (code-driven). Even when search failed or
      //    returned no usable routes we still proceed to generate — the
      //    model grounds on whatever context we managed to collect (or
      //    on an explicit "nothing retrieved" note). It never crashes.
      const routes = searchResult.ok ? extractRoutes(searchResult.data).slice(0, topK) : [];
      const docs: { route: string; title: string; text: string }[] = [];
      let usedChars = 0;
      for (const route of routes) {
        if (signal.aborted) {
          yield { kind: 'error', message: 'aborted' };
          return;
        }
        if (usedChars >= contextBudget) break;
        const readId = rid('read');
        yield { kind: 'tool_call', id: readId, name: readTool, args: { route } };
        const readResult = await input.tools.execute(
          { id: readId, name: readTool, args: { route } },
          input.toolContext(),
        );
        yield { kind: 'tool_result', id: readId, result: readResult };
        if (!readResult.ok) continue;
        const doc = extractText(readResult.data);
        // Trim the excerpt so the running total never exceeds the
        // budget — a small local model can't hold several full bodies.
        const remaining = contextBudget - usedChars;
        const text = doc.text.length > remaining ? doc.text.slice(0, remaining) : doc.text;
        docs.push({ route: doc.route, title: doc.title, text });
        usedChars += text.length;
      }

      if (signal.aborted) {
        yield { kind: 'error', message: 'aborted' };
        return;
      }

      // 3. COMPOSE. The model's only input is system + history + the
      //    grounded question. No tools are advertised → no tool-call
      //    parsing, no loop.
      const groundedUserText = composeContext(input.prompt, docs);
      const messages = buildMessages(input, groundedUserText);
      const chatRequest: ModelRequest = {
        messages,
        tools: [],
        toolUseEnabled: false,
      };

      // Emit the trace BEFORE dispatch — same agent-layer view the
      // ReAct loop captures. A single-iteration run, so iteration 0.
      const turnIdForReq = input.turnId ?? 'turn-anon';
      const requestId = `${turnIdForReq}#0`;
      if (input.tracer) {
        input.tracer.emit({
          kind: 'llm_request',
          data: {
            requestId,
            turnId: turnIdForReq,
            iteration: 0,
            ts: Date.now(),
            systemPrompt: input.systemPrompt,
            messages: messages.map((m) => ({ ...m })),
            tools: [],
            llm: { id: input.llm.id, supportsTools: input.llm.supportsTools },
          },
        });
      }

      // 4. GENERATE (the model's ONLY job).
      let turnUsage: ModelUsage | undefined;
      const turnDetails: TurnDetails = { requestedModel: input.llm.id };
      let assistantText = '';
      let assistantThinking = '';

      for await (const ev of input.llm.chat(chatRequest, signal) as AsyncIterable<ModelEvent>) {
        if (ev.kind === 'text') {
          assistantText += ev.text;
          yield { kind: 'text', chunk: ev.text };
        } else if (ev.kind === 'thinking') {
          assistantThinking += ev.text;
          yield { kind: 'thinking', chunk: ev.text };
        } else if (ev.kind === 'usage') {
          turnUsage = ev.usage;
        } else if (ev.kind === 'error') {
          yield ev;
          return;
        }
        // `tool_call` events are impossible here (toolUseEnabled:false,
        // no tools advertised); a misbehaving stub that emits one is
        // ignored rather than dispatched — this is a zero-agency
        // strategy and the code already retrieved everything.
      }

      // Pair the `llm_request` with its response — the closing endpoint
      // of this run's language-model wall-clock segment.
      if (input.tracer) {
        input.tracer.emit({
          kind: 'llm_response',
          data: {
            requestId,
            ts: Date.now(),
            text: assistantText,
            thinking: assistantThinking,
            toolCalls: [],
            ...(turnUsage
              ? {
                  usage: {
                    promptTokens: turnUsage.promptTokens,
                    outputTokens: turnUsage.outputTokens,
                    ...(turnUsage.cachedTokens !== undefined
                      ? { cachedTokens: turnUsage.cachedTokens }
                      : {}),
                    ...(turnUsage.reasoningTokens !== undefined
                      ? { reasoningTokens: turnUsage.reasoningTokens }
                      : {}),
                    ...(turnUsage.costUsd !== undefined ? { costUsd: turnUsage.costUsd } : {}),
                  },
                }
              : {}),
          },
        });
      }

      // 5. turn_complete. Synthesize a zero-usage accounting when the
      //    stub never emitted a `usage` event so the strategy always
      //    terminates with a `turn_complete` (the contract a host
      //    relies on), matching the plan.
      yield {
        kind: 'turn_complete',
        usage: turnUsage ?? { promptTokens: 0, outputTokens: 0 },
        details: turnDetails,
      };
    },
  };
}
