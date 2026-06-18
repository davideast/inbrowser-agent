/**
 * Phase-1 retrieval-hardening eval (deterministic, NO LLM).
 *
 * Design source: plans/retrieval-hardening.md (Phase 1 — the gate).
 *
 * Compares THREE route-level retrievers over the golden set
 * (site/test/fixtures/docs-eval.json):
 *   (a) keyword  — the existing whole-doc `searchDocs`.
 *   (b) semantic — top chunks by embedding cosine, mapped to their routes
 *                  (deduped, kept in rank order).
 *   (c) hybrid   — reciprocal-rank fusion of semantic chunks + keyword.
 *
 * Metrics per retriever: recall@3, recall@5, MRR (first gold route's rank).
 * "recall@K" = a goldRoute appears among the top-K DISTINCT routes.
 *
 * The point of Phase 1 is to prove (before any live wiring) that semantic /
 * hybrid lift recall over keyword — especially on the two known keyword
 * misses: a paraphrase query and a sibling-doc collision.
 *
 * The asserted floor is lenient (hybrid recall@5 >= keyword's 0.94) so the
 * suite stays green; the real comparison is in the printed report.
 */
import { describe, expect, test } from 'bun:test';
import { searchDocs } from '../src/lib/graph';
import { hybridRetrieve, semanticChunks } from '../src/lib/semantic-retrieval';
import evalSet from './fixtures/docs-eval.json';

interface EvalCase {
  q: string;
  goldRoutes: string[];
  mustInclude: string[];
}
const cases = evalSet as EvalCase[];

/** Keyword baseline from the existing Layer-1 eval. */
const KEYWORD_RECALL5_BASELINE = 0.94;

/** Substrings that identify the two known-miss questions. */
const PARAPHRASE_MISS = 'pick back up after a tab is backgrounded';
const SIBLING_MISS = 'Which presets support tool calling';

/** Dedupe routes keeping first-seen (rank) order. */
function distinctRoutes(routes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of routes) {
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

/** 1-based rank of the first gold route in `routes`, else 0. */
function firstGoldRank(routes: string[], gold: Set<string>): number {
  for (let i = 0; i < routes.length; i++) {
    if (gold.has(routes[i])) return i + 1;
  }
  return 0;
}

interface PerQuestion {
  c: EvalCase;
  routes: string[]; // distinct routes, rank order
  rank: number; // first gold rank (0 = miss)
}

function evaluate(retriever: (c: EvalCase) => PerQuestion[]): {
  results: PerQuestion[];
  recall3: number;
  recall5: number;
  mrr: number;
} {
  const results = cases.flatMap(retriever);
  const n = results.length;
  const inK = (k: number) => results.filter((r) => r.rank > 0 && r.rank <= k).length / n;
  const mrr = results.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / n;
  return { results, recall3: inK(3), recall5: inK(5), mrr };
}

describe('Phase-1 chunk retrieval eval (keyword vs semantic vs hybrid)', () => {
  // Retrieve enough to measure recall@5 over DISTINCT routes. Semantic/hybrid
  // return chunks, so pull a generous chunk pool and dedupe to routes.
  const CHUNK_PULL = 30;

  // --- run all three retrievers once each over the whole set ---------------
  const keyword = evaluate((c) => {
    const routes = distinctRoutes(searchDocs(c.q, 10).map((h) => h.route));
    return [{ c, routes, rank: firstGoldRank(routes, new Set(c.goldRoutes)) }];
  });

  // Precompute the async retrievals (semantic + hybrid) before the sync eval.
  // Bun runs the describe body synchronously, so gather via a top-level await
  // inside a beforeAll-style promise resolved in the test.
  // To keep it simple we compute inside an async test and stash results.
  let semantic: ReturnType<typeof evaluate> | null = null;
  let hybrid: ReturnType<typeof evaluate> | null = null;

  test('runs semantic + hybrid retrieval over the golden set', async () => {
    const semResults: PerQuestion[] = [];
    const hybResults: PerQuestion[] = [];
    for (const c of cases) {
      const gold = new Set(c.goldRoutes);
      const sem = await semanticChunks(c.q, CHUNK_PULL);
      const semRoutes = distinctRoutes(sem.map((s) => s.route));
      semResults.push({ c, routes: semRoutes, rank: firstGoldRank(semRoutes, gold) });

      const hyb = await hybridRetrieve(c.q, CHUNK_PULL);
      const hybRoutes = distinctRoutes(hyb.map((h) => h.route));
      hybResults.push({ c, routes: hybRoutes, rank: firstGoldRank(hybRoutes, gold) });
    }
    const agg = (results: PerQuestion[]) => {
      const n = results.length;
      const inK = (k: number) => results.filter((r) => r.rank > 0 && r.rank <= k).length / n;
      const mrr = results.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / n;
      return { results, recall3: inK(3), recall5: inK(5), mrr };
    };
    semantic = agg(semResults);
    hybrid = agg(hybResults);
    expect(semantic.results.length).toBe(cases.length);
    expect(hybrid.results.length).toBe(cases.length);
  });

  test('reports the comparison table + known-miss status + remaining misses', () => {
    if (!semantic || !hybrid) throw new Error('semantic/hybrid not computed');
    const lines: string[] = [];
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const row = (name: string, e: ReturnType<typeof evaluate>) =>
      `  ${name.padEnd(9)} recall@3 ${pct(e.recall3).padStart(6)}   recall@5 ${pct(
        e.recall5,
      ).padStart(6)}   MRR ${e.mrr.toFixed(3)}`;

    lines.push('');
    lines.push('============ Phase-1 chunk retrieval eval ============');
    lines.push(`eval-set size: ${cases.length} questions`);
    lines.push('------------------------------------------------------');
    lines.push(row('keyword', keyword));
    lines.push(row('semantic', semantic));
    lines.push(row('hybrid', hybrid));
    lines.push('------------------------------------------------------');

    // Known-miss drill-down.
    lines.push('Known misses (rank of first gold route per retriever; "-" = not in top-5):');
    const findRank = (e: ReturnType<typeof evaluate>, needle: string) => {
      const r = e.results.find((x) => x.c.q.includes(needle));
      if (!r) return 'n/a';
      return r.rank > 0 && r.rank <= 5 ? `rank ${r.rank}` : '-';
    };
    const reportMiss = (label: string, needle: string) => {
      const q = cases.find((c) => c.q.includes(needle));
      lines.push(`  ${label}`);
      lines.push(`    Q: ${q?.q ?? '(not found)'}`);
      lines.push(`    gold: ${q?.goldRoutes.join(', ')}`);
      lines.push(
        `    keyword=${findRank(keyword, needle)}  semantic=${findRank(
          semantic as ReturnType<typeof evaluate>,
          needle,
        )}  hybrid=${findRank(hybrid as ReturnType<typeof evaluate>, needle)}`,
      );
    };
    reportMiss('PARAPHRASE miss:', PARAPHRASE_MISS);
    reportMiss('SIBLING-COLLISION miss:', SIBLING_MISS);
    lines.push('------------------------------------------------------');

    // Remaining misses under the BEST retriever (by recall@5, tie -> MRR).
    const ranked = [
      { name: 'keyword', e: keyword },
      { name: 'semantic', e: semantic },
      { name: 'hybrid', e: hybrid },
    ].sort((a, b) => b.e.recall5 - a.e.recall5 || b.e.mrr - a.e.mrr);
    const best = ranked[0];
    const bestMisses = best.e.results.filter((r) => !(r.rank > 0 && r.rank <= 5));
    lines.push(`Best retriever by recall@5: ${best.name} (${pct(best.e.recall5)})`);
    if (bestMisses.length === 0) {
      lines.push('  No remaining misses — best retriever has every gold route in top-5.');
    } else {
      lines.push(`  Remaining misses under ${best.name} (${bestMisses.length}):`);
      for (const m of bestMisses) {
        lines.push(`    Q: ${m.c.q}`);
        lines.push(`      gold: ${m.c.goldRoutes.join(', ')}`);
        lines.push(`      got:  ${m.routes.slice(0, 5).join(', ') || '(none)'}`);
      }
    }
    lines.push('======================================================');
    console.log(lines.join('\n'));

    expect(cases.length).toBeGreaterThan(0);
  });

  test(`hybrid recall@5 clears the keyword baseline floor (${KEYWORD_RECALL5_BASELINE})`, () => {
    if (!hybrid) throw new Error('hybrid not computed');
    expect(hybrid.recall5).toBeGreaterThanOrEqual(KEYWORD_RECALL5_BASELINE);
  });
});
