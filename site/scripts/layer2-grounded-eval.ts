import {
  type ChatMessage,
  createAgentSession,
  createDispatch,
  createMetricsCollector,
  createRetrievalStrategy,
} from '@inbrowser/agent';
/**
 * Layer-2 grounded-answer eval (plans/retrieval-strategy-and-eval.md).
 *
 * Runs `createRetrievalStrategy` with an ON-DEVICE SmolLM2 360M
 * (`createEngineModelClient(createEngine(smollm2_360m))`) over the REAL docs,
 * for the golden eval set, and grades each answer:
 *   - grounded-correct: every `mustInclude` fact appears in the answer
 *   - retrieval-hit:     a gold route was actually read (get_doc) this turn
 *   - no hallucinated routes: every `/route` cited in the answer is a real node
 *
 * Usage: `bun site/scripts/layer2-grounded-eval.ts [count]` (default: all).
 * The model is downloaded + compiled once (~180 MB), reused across questions.
 */
import {
  createEngine,
  createEngineModelClient,
  qwen2_5_0_5b,
  smollm2_360m,
} from '@inbrowser/model/local';
import { createGraphToolRegistry } from '../src/agent/graph-tools';
import { getNode } from '../src/lib/graph';

interface EvalItem {
  q: string;
  goldRoutes: string[];
  mustInclude: string[];
}

const SYSTEM_PROMPT =
  'You are the documentation assistant for the "inbrowser" monorepo. Answer the ' +
  "user's question concisely and accurately using only the provided documentation excerpts.";

async function main() {
  const limit = Number(process.argv[2]) || Number.POSITIVE_INFINITY;
  const evalSet = (await import('../test/fixtures/docs-eval.json', { with: { type: 'json' } }))
    .default as EvalItem[];
  const items = evalSet.slice(0, limit);

  const PRESETS = { smollm2_360m, qwen2_5_0_5b } as const;
  const presetName = (process.env.PRESET as keyof typeof PRESETS) ?? 'smollm2_360m';
  const preset = PRESETS[presetName] ?? smollm2_360m;
  process.stdout.write(`Loading ${presetName} (on-device, WASM)…\n`);
  const t0 = Date.now();
  const engine = createEngine(
    process.env.DTYPE ? { ...preset, dtype: process.env.DTYPE as typeof preset.dtype } : preset,
  );
  await engine.ensureReady();
  process.stdout.write(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n\n`);
  const llm = createEngineModelClient(engine);

  let groundedCorrect = 0;
  let retrievalHit = 0;
  let hallucinated = 0;
  const ROUTE_RE = /\/[a-z0-9-]+(?:\/[a-z0-9-]+)*/gi;

  for (const item of items) {
    const registry = createGraphToolRegistry();
    const ac = new AbortController();
    const topK = Number(process.env.TOPK) || 3;
    const contextBudget = Number(process.env.BUDGET) || 6000;
    const session = createAgentSession({
      strategy: createRetrievalStrategy({ topK, contextBudget }),
      llm,
      tools: createDispatch(registry),
      toolList: registry.list(),
      toolContext: () => ({ signal: ac.signal }),
      systemPromptBuilder: () => SYSTEM_PROMPT,
      metrics: createMetricsCollector(),
      history: [] as ChatMessage[],
    });

    let answer = '';
    const readRoutes = new Set<string>();
    const toolName = new Map<string, string>();
    const tStart = Date.now();
    for await (const ev of session.submit(item.q, ac.signal)) {
      if (ev.kind === 'text') answer += ev.chunk;
      else if (ev.kind === 'tool_started') toolName.set(ev.callId, ev.name);
      else if (ev.kind === 'tool_finished') {
        if (
          toolName.get(ev.callId) === 'get_doc' &&
          ev.result.ok &&
          ev.result.data &&
          typeof ev.result.data === 'object'
        ) {
          const r = (ev.result.data as { route?: string }).route;
          if (r) readRoutes.add(r);
        }
      }
    }

    const lower = answer.toLowerCase();
    const factsHit = item.mustInclude.filter((f) => lower.includes(f.toLowerCase()));
    const isGrounded = factsHit.length === item.mustInclude.length;
    const didRetrieve = item.goldRoutes.some((r) => readRoutes.has(r));
    const citedRoutes = [...new Set(answer.match(ROUTE_RE) ?? [])];
    const halluc = citedRoutes.filter((r) => !getNode(r));

    if (isGrounded) groundedCorrect++;
    if (didRetrieve) retrievalHit++;
    if (halluc.length > 0) hallucinated++;

    process.stdout.write(
      `${isGrounded ? '✅' : '❌'} ${didRetrieve ? '📄' : '∅'} ` +
        `[${((Date.now() - tStart) / 1000).toFixed(1)}s] ${item.q}\n` +
        `   facts ${factsHit.length}/${item.mustInclude.length} | read ${[...readRoutes].join(',') || '(none)'} | gold ${item.goldRoutes.join(',')}` +
        `${halluc.length ? ` | ⚠️ hallucinated: ${halluc.join(',')}` : ''}\n` +
        `   answer: ${answer.replace(/\s+/g, ' ').slice(0, 180)}\n\n`,
    );
  }

  const n = items.length;
  process.stdout.write(
    `\n=== Layer-2 (SmolLM2 360M + createRetrievalStrategy) over ${n} questions ===\n` +
      `grounded-correct: ${groundedCorrect}/${n} (${((100 * groundedCorrect) / n).toFixed(0)}%)\n` +
      `retrieval-hit:    ${retrievalHit}/${n} (${((100 * retrievalHit) / n).toFixed(0)}%)\n` +
      `hallucinated-routes: ${hallucinated}/${n}\n`,
  );
  engine.dispose?.();
}

main().catch((e) => {
  process.stderr.write(`FAILED: ${e?.stack || e}\n`);
  process.exit(1);
});
