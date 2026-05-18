/**
 * `createPlannerExecutorStrategy()` — phase five `AgentStrategy`.
 *
 * Takes a user prompt, routes it to a skill from the catalog,
 * materializes that skill's prescribed plan, and executes each step
 * with a bounded ReAct sub-loop. Scratch is dropped between steps:
 * the next step starts fresh with a short summary of each prior step,
 * not the full message history. The working window stays flat across
 * a long workflow, which is the hypothesis this strategy exists to
 * test.
 *
 * Lifecycle:
 *
 *   1. Route the prompt against the catalog. When the router returns
 *      no match, either fall back to `createReactLoopStrategy()`
 *      (default) or yield an `error` event (when `fallbackToReact`
 *      is `false`).
 *   2. Look up the catalog entry. If the router returned a name not
 *      in the catalog (shouldn't happen for a catalog-derived router,
 *      defensive), behave as the no-match case.
 *   3. Emit a `custom` event `'plan_started'` with the skill name and
 *      the step ids.
 *   4. For each step, in order:
 *        a. Emit `custom` `'step_started'` with `{ stepId,
 *           description }`.
 *        b. Build a step-scoped system prompt that wraps the original
 *           system prompt with a suffix naming the step ("You are on
 *           step X of Y: <description>. Prior step summaries follow.")
 *           and one synthetic user message per prior step's summary.
 *        c. Drive a bounded `createReactLoopStrategy({ maxTurns })`
 *           sub-loop. Every inner `text`, `thinking`, `tool_call`,
 *           `tool_result`, and `turn_complete` event is streamed
 *           through unchanged so the host's UI continues working.
 *        d. After the sub-loop completes, capture the concatenated
 *           assistant text the inner loop emitted this step, call
 *           `summarizeStep(stepId, transcript)` to get a short
 *           summary, and emit `custom` `'step_completed'` with
 *           `{ stepId, summary }`.
 *   5. Emit `custom` `'plan_completed'` and return.
 *
 * Tracer: per-step inner loops generate their own `llm_request` /
 * `llm_response` / `turn_dispatch_complete` trace events. The trace's
 * `requestId` carries a `${turnId}#${stepId}#${iteration}` shape so
 * the eval harness can read per-step iteration counts off the trace
 * without changes.
 *
 * What is intentionally NOT done in v1:
 *
 *   - Per-step verifier gating. The catalog's `verifier?` is read but
 *     not enforced. The executor always advances to the next step.
 *     Gating progression on verifier outcomes is a follow-up.
 *   - Per-step tool subsetting. Every step sees the same dispatcher
 *     and the same tool list. A future enhancement can scope tools by
 *     step.
 *   - Smarter step summarization. The default `summarizeStep` is
 *     `transcript.slice(0, 400)` — dumb truncation. Override with a
 *     real summarizer if needed.
 */

import type { SkillName } from './eval/fixture.js';
import { SKILL_CATALOG, getSkillEntry } from './skill-catalog.js';
import type { SkillCatalog, SkillCatalogEntry } from './skill-catalog.js';
import { createReactLoopStrategy } from './strategy.js';
import type { ChatMessage } from './types/chat.js';
import type { AgentStrategy, StrategyEvent, StrategyRunInput } from './types/strategy.js';

/**
 * Minimal router contract this strategy depends on. The sibling
 * `strategy/skill-router` branch ships a concrete `routeSkill`
 * function with the same signature; until that lands, callers can
 * pass any function with this shape, and this module's
 * `defaultKeywordRouter` does a trivial substring scan against the
 * catalog's `triggerHints` so the strategy works end-to-end on its
 * own.
 *
 * Once the router branch merges, downstream code can replace the
 * default by passing `router: routeSkill` (or by wrapping it) into
 * the options. No change is needed in this file.
 */
export interface SkillRouterMatch {
  /** The chosen skill. Must be a name present in the catalog. */
  skill: SkillName;
  /** Higher is better. Consumers may surface it; the strategy uses
   *  only its presence (non-null match) to gate execution. */
  score?: number;
}

export interface SkillRouterDecision {
  /** The top match, or `null` when no entry crossed the router's
   *  internal threshold. */
  match: SkillRouterMatch | null;
}

export type SkillRouter = (
  prompt: string,
  options?: { catalog?: SkillCatalog },
) => SkillRouterDecision;

export interface PlannerExecutorOptions {
  /** Catalog override. Defaults to `SKILL_CATALOG`. */
  catalog?: SkillCatalog;
  /** Per-step bounded turn budget for the inner ReAct sub-loop.
   *  Default 4. */
  stepMaxTurns?: number;
  /** When the router returns no match, fall back to
   *  `createReactLoopStrategy()` for the rest of the turn. Default
   *  `true`. When `false`, the strategy yields an `error` event and
   *  returns. */
  fallbackToReact?: boolean;
  /**
   * Summarize a single step's transcript (concatenated assistant
   * text) into a short string that seeds the next step's context.
   * Default: dumb truncation to 400 characters.
   */
  summarizeStep?: (stepId: string, transcript: string) => string;
  /**
   * Router function. Defaults to a keyword scan against the catalog's
   * `triggerHints`. The sibling `strategy/skill-router` branch ships
   * a more sophisticated `routeSkill`; once that lands, callers can
   * pass it here.
   */
  router?: SkillRouter;
}

const DEFAULT_STEP_MAX_TURNS = 4;
const DEFAULT_SUMMARY_LIMIT = 400;

/**
 * Default step summarizer. Trims and truncates. Sufficient for v1 —
 * the next step's context only needs a rough recall of what the prior
 * step concluded, not a faithful reproduction.
 */
function defaultSummarizeStep(_stepId: string, transcript: string): string {
  const trimmed = transcript.trim();
  if (trimmed.length <= DEFAULT_SUMMARY_LIMIT) return trimmed;
  return `${trimmed.slice(0, DEFAULT_SUMMARY_LIMIT)}…`;
}

/**
 * Default keyword router. Scores each catalog entry by counting
 * `triggerHints` substring hits in the lowercased prompt and returns
 * the top scorer (or `null` when every entry scored zero). Catalog
 * order breaks ties — the same ordering the sibling
 * `strategy/skill-router` branch documents for its production router.
 *
 * This is intentionally tiny. The point is that the executor can run
 * end-to-end (and be unit-tested) without depending on the router
 * branch landing first.
 */
export const defaultKeywordRouter: SkillRouter = (
  prompt: string,
  options?: { catalog?: SkillCatalog },
): SkillRouterDecision => {
  const catalog = options?.catalog ?? SKILL_CATALOG;
  if (!prompt) return { match: null };
  const lowered = prompt.toLowerCase();
  let best: { entry: SkillCatalogEntry; score: number } | null = null;
  for (const entry of catalog) {
    let score = 0;
    for (const hint of entry.triggerHints) {
      if (hint.length === 0) continue;
      if (lowered.includes(hint.toLowerCase())) score += 1;
    }
    if (score > 0 && (best === null || score > best.score)) {
      best = { entry, score };
    }
  }
  if (best === null) return { match: null };
  return { match: { skill: best.entry.name, score: best.score } };
};

/**
 * Build the planner-executor strategy. Returns an `AgentStrategy`
 * with `id: 'planner-executor'`.
 */
export function createPlannerExecutorStrategy(options: PlannerExecutorOptions = {}): AgentStrategy {
  const catalog = options.catalog ?? SKILL_CATALOG;
  const stepMaxTurns = options.stepMaxTurns ?? DEFAULT_STEP_MAX_TURNS;
  const fallbackToReact = options.fallbackToReact !== false;
  const summarizeStep = options.summarizeStep ?? defaultSummarizeStep;
  const router = options.router ?? defaultKeywordRouter;

  return {
    id: 'planner-executor',
    async *run(input: StrategyRunInput, signal: AbortSignal): AsyncIterable<StrategyEvent> {
      if (signal.aborted) {
        yield { kind: 'error', message: 'aborted' };
        return;
      }

      // 1. Route the prompt. When a custom catalog was supplied, look
      // the entry up in that catalog directly so the executor honors
      // the override; otherwise the production `SKILL_CATALOG` table
      // is consulted via `getSkillEntry`.
      const decision = router(input.prompt, { catalog });
      const lookupEntry = (skill: SkillName) =>
        options.catalog === undefined
          ? getSkillEntry(skill)
          : options.catalog.find((entry) => entry.name === skill);
      const matchedEntry = decision.match === null ? undefined : lookupEntry(decision.match.skill);

      // 2. No match or match-but-not-in-catalog → fallback path.
      if (decision.match === null || matchedEntry === undefined) {
        if (!fallbackToReact) {
          yield {
            kind: 'error',
            message: 'planner-executor: no skill matched and fallbackToReact is disabled',
          };
          return;
        }
        // Delegate the rest of the turn to a plain ReAct sub-strategy.
        // Stream every event through unchanged.
        const sub = createReactLoopStrategy();
        for await (const ev of sub.run(input, signal)) {
          yield ev;
        }
        return;
      }

      // 3. Plan started.
      const plan = matchedEntry.steps;
      yield {
        kind: 'custom',
        name: 'plan_started',
        data: {
          skill: matchedEntry.name,
          plan: plan.map((s) => s.id),
        },
      };

      const stepSummaries: { stepId: string; description: string; summary: string }[] = [];
      const turnIdForReq = input.turnId ?? 'turn-anon';

      // 4. Walk the steps.
      for (let stepIndex = 0; stepIndex < plan.length; stepIndex++) {
        if (signal.aborted) {
          yield { kind: 'error', message: 'aborted' };
          return;
        }

        const step = plan[stepIndex]!;
        yield {
          kind: 'custom',
          name: 'step_started',
          data: { stepId: step.id, description: step.description },
        };

        // 4b. Build the step-scoped system prompt + a fresh history
        // composed of one synthetic user message per prior step's
        // summary. The next step sees ONLY these summaries plus the
        // original user prompt — never the raw scratch from prior
        // sub-loops. This is the context-discipline mechanism.
        const stepSystemPrompt = buildStepSystemPrompt(
          input.systemPrompt,
          step.id,
          step.description,
          stepIndex,
          plan.length,
          stepSummaries.length > 0,
        );
        const stepHistory: ChatMessage[] = stepSummaries.map((s, i) => ({
          id: `step-summary-${i}`,
          role: 'user',
          text: `[Prior step '${s.stepId}' summary] ${s.summary}`,
        }));

        // 4c. Drive a bounded ReAct sub-loop. The sub-loop's tracer is
        // the OUTER tracer wrapped so that emitted `llm_request` /
        // `llm_response` / `turn_dispatch_complete` events carry a
        // step-scoped `requestId` prefix; the wrapping rewrites the
        // request id from `${turnId}#${iteration}` to
        // `${turnId}#${stepId}#${iteration}` so the eval harness can
        // read per-step iteration counts off the trace.
        const subStrategy = createReactLoopStrategy({ maxTurns: stepMaxTurns });
        const stepInput: StrategyRunInput = {
          ...input,
          history: stepHistory,
          systemPrompt: stepSystemPrompt,
          turnId: `${turnIdForReq}#${step.id}`,
          ...(input.tracer ? { tracer: { emit: input.tracer.emit.bind(input.tracer) } } : {}),
        };

        let stepAssistantText = '';
        let stepExceededBudget = false;
        for await (const ev of subStrategy.run(stepInput, signal)) {
          if (ev.kind === 'text') {
            stepAssistantText += ev.chunk;
          }
          // Stream every event from the inner loop through unchanged.
          // The host sees normal `text`/`thinking`/`tool_call`/
          // `tool_result`/`turn_complete` events as if a single ReAct
          // loop were running — plus the planner-executor's own
          // `custom` plan events around them.
          if (ev.kind === 'error') {
            // A sub-loop maxTurns exhaustion (the message format from
            // `createReactLoopStrategy` is `react-loop: exceeded
            // maxTurns (N) without settling`) is treated as a soft
            // step failure: we surface it via a `custom` event so the
            // host can react, then advance to the next step with
            // whatever text the step produced. Hitting the budget on
            // one step shouldn't kill the plan — the next step's
            // summary chain can still seed downstream work.
            //
            // All other errors (abort, provider failure, etc.)
            // propagate and stop the plan.
            if (/exceeded maxTurns/i.test(ev.message)) {
              stepExceededBudget = true;
              yield {
                kind: 'custom',
                name: 'step_budget_exhausted',
                data: { stepId: step.id, message: ev.message },
              };
              break;
            }
            yield ev;
            return;
          }
          yield ev;
        }
        // Silence the lint: a fresh `let` that the planner-executor
        // tracks for follow-up branches that may surface it on the
        // emitted `step_completed` event. v1 keeps it private.
        void stepExceededBudget;

        // 4d. Summarize and record.
        const summary = summarizeStep(step.id, stepAssistantText);
        stepSummaries.push({
          stepId: step.id,
          description: step.description,
          summary,
        });
        yield {
          kind: 'custom',
          name: 'step_completed',
          data: { stepId: step.id, summary },
        };
      }

      // 5. Plan complete.
      yield {
        kind: 'custom',
        name: 'plan_completed',
        data: {
          skill: matchedEntry.name,
          steps: stepSummaries.map((s) => ({ stepId: s.stepId, summary: s.summary })),
        },
      };
    },
  };
}

function buildStepSystemPrompt(
  basePrompt: string,
  stepId: string,
  stepDescription: string,
  stepIndex: number,
  stepCount: number,
  hasPriorSummaries: boolean,
): string {
  // 1-indexed for human-readable display ("step 3 of 5").
  const displayIndex = stepIndex + 1;
  const suffix = hasPriorSummaries
    ? `You are on step ${displayIndex} of ${stepCount} (id: ${stepId}): ${stepDescription}. Prior step summaries follow as user messages — treat them as facts you have already established, not as new requests.`
    : `You are on step ${displayIndex} of ${stepCount} (id: ${stepId}): ${stepDescription}. This is the first step.`;
  return `${basePrompt}\n\n${suffix}`;
}
