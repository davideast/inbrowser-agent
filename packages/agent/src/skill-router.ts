/**
 * Keyword-based skill router.
 *
 * Phase five of the implementation plan splits the planner-executor
 * work into three branches: the static `SkillCatalog`, this router
 * that classifies a user prompt against the catalog, and the
 * executor that walks a chosen skill's prescribed step sequence.
 *
 * The router is intentionally simple. It does not call a language
 * model. It lowercases the prompt and counts how many of each
 * catalog entry's `triggerHints` appear as substrings in the
 * prompt. The entry with the highest hit count wins. Ties break
 * in favor of entries whose literal `name` (e.g.
 * `rtdb-game-rules`) appears in the prompt — either in the
 * lowered text or in the prompt's kebab-case form (whitespace
 * collapsed to dashes). After that, ties break by catalog order.
 * When the score AND name-in-prompt signal both tie between the
 * top entry and the runner-up, the router returns `match: null`
 * rather than mis-route into a coin-flip pick.
 *
 * A v1 design point: confidence is the raw hit count. There is no
 * normalization, no probability. The planner-executor decides
 * whether a `RouterDecision.match` is good enough to act on. When
 * no entry scores at or above `threshold` (default 1), the router
 * returns `match: null` and the executor is expected to fall back
 * to plain ReAct.
 *
 * Future work: an LLM-based router could layer on top of this
 * keyword scoring (for example, only invoked when the keyword
 * router returns null or returns a low-margin tie). That layering
 * is explicitly deferred and is not in this branch.
 */

import type { SkillName } from './eval/fixture.js';
import { SKILL_CATALOG, type SkillCatalog } from './skill-catalog.js';

/**
 * A single scored entry in the router's ranking. `score` is the
 * raw number of `triggerHints` that appeared as substrings of
 * the lowercased prompt — no normalization or probability.
 */
export interface RouterMatch {
  /** The skill the catalog entry identifies. */
  skill: SkillName;
  /** Number of trigger hints matched. Higher is better. */
  score: number;
}

/**
 * The router's verdict for one prompt. `match` is the top-scoring
 * candidate when it cleared the threshold, otherwise `null`.
 * `ranking` always reflects the full sorted scoring, useful for
 * debugging accuracy and for callers that want to inspect runners-up.
 */
export interface RouterDecision {
  /** The top-scoring match, or null when no entry scored >= threshold. */
  match: RouterMatch | null;
  /** All scored entries, descending. Useful for debugging accuracy. */
  ranking: readonly RouterMatch[];
}

/**
 * Optional overrides for `routeSkill`. `threshold` is the minimum
 * `score` required to count as a real match (default 1, so a single
 * trigger hit clears the bar). `catalog` lets tests inject a
 * different catalog without touching the global.
 */
export interface RouterOptions {
  /** Minimum score required to call it a match. Default 1. */
  threshold?: number;
  /** Optional override of the catalog. Defaults to SKILL_CATALOG. */
  catalog?: SkillCatalog;
}

/**
 * Count how many of `hints` appear as substrings of `lowerPrompt`.
 * Each hint is counted at most once, regardless of how many times
 * it appears in the prompt — this matches the "number of hints
 * that matched" framing in the brief, not "total occurrences."
 */
function scoreHints(lowerPrompt: string, hints: readonly string[]): number {
  let score = 0;
  for (const hint of hints) {
    if (hint.length === 0) continue;
    if (lowerPrompt.includes(hint.toLowerCase())) {
      score += 1;
    }
  }
  return score;
}

/**
 * The brief's tie-break: prefer entries whose `name` appears in
 * the prompt as a substring of the lowercased prompt or its
 * kebab-case form. The kebab-case form of the prompt is the
 * lowercased text with all whitespace collapsed to single dashes,
 * so a user typing "rtdb game rules" still picks up the literal
 * `rtdb-game-rules` skill name.
 */
function nameInPrompt(lowerPrompt: string, kebabPrompt: string, name: SkillName): boolean {
  return lowerPrompt.includes(name) || kebabPrompt.includes(name);
}

function toKebabPrompt(lowerPrompt: string): string {
  return lowerPrompt.replace(/\s+/g, '-');
}

/**
 * Route a user prompt to a catalog entry using keyword scoring.
 *
 * Algorithm:
 *   1. Lowercase the prompt and compute its kebab-case form
 *      (whitespace collapsed to dashes) for name matching.
 *   2. For each entry, score = count of `triggerHints` whose
 *      lowercased form appears as a substring of the prompt.
 *   3. Build a ranking sorted by (score DESC, name-in-prompt DESC,
 *      catalog order ASC). `name-in-prompt` is true when the
 *      literal skill name (e.g. `rtdb-game-rules`) appears in
 *      either the lowered prompt or its kebab-case form.
 *   4. If the top entry's score is >= threshold (default 1),
 *      return it as `match`; otherwise `match: null`.
 *   5. Ambiguity guard: if the top entry ties on score with the
 *      runner-up and the tie-break (name-in-prompt) does not
 *      disambiguate, return `match: null` rather than committing
 *      to the catalog-order winner. The brief's hard requirement
 *      is that the router never returns a *wrong* skill — a
 *      coin-flip pick is exactly that failure mode.
 *
 * The `ranking` returned always covers every catalog entry so
 * callers can inspect runners-up regardless of the match decision.
 */
export function routeSkill(prompt: string, options?: RouterOptions): RouterDecision {
  const threshold = options?.threshold ?? 1;
  const catalog = options?.catalog ?? SKILL_CATALOG;
  const lowerPrompt = prompt.toLowerCase();
  const kebabPrompt = toKebabPrompt(lowerPrompt);

  // Snapshot each entry with its score, its catalog position, and
  // the tie-break signal. We sort a copy so the input catalog is
  // not mutated.
  const scored = catalog.map((entry, index) => ({
    skill: entry.name,
    score: scoreHints(lowerPrompt, entry.triggerHints),
    nameInPrompt: nameInPrompt(lowerPrompt, kebabPrompt, entry.name),
    catalogIndex: index,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.nameInPrompt !== b.nameInPrompt) return a.nameInPrompt ? -1 : 1;
    return a.catalogIndex - b.catalogIndex;
  });

  const ranking: RouterMatch[] = scored.map((s) => ({ skill: s.skill, score: s.score }));

  const top = scored[0];
  let match: RouterMatch | null =
    top !== undefined && top.score >= threshold ? { skill: top.skill, score: top.score } : null;

  // Ambiguity guard. When the top and runner-up share a positive
  // score and the name-in-prompt tie-break does not separate them,
  // the keyword router does not have enough signal to commit.
  // Returning null here hands the prompt off to the planner-executor's
  // fallback (plain ReAct) rather than mis-routing — the brief's
  // hard requirement is that the router never returns a *wrong*
  // skill. Only applies when the top score is at least 1: callers
  // who pass `threshold: 0` are explicitly asking for the
  // catalog-order winner regardless of signal.
  if (match !== null && top.score > 0 && scored.length > 1) {
    const runnerUp = scored[1];
    if (runnerUp.score === top.score && runnerUp.nameInPrompt === top.nameInPrompt) {
      match = null;
    }
  }

  return { match, ranking };
}
