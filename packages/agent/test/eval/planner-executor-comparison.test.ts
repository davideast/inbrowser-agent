/**
 * Phase five exit check (planner-executor branch).
 *
 * Runs the eval harness across a small subset of fixtures twice — once
 * with `createReactLoopStrategy()` (baseline) and once with
 * `createPlannerExecutorStrategy()` (variant) — using a deterministic
 * stub LLM that simulates a multi-tool ReAct ping-pong on the baseline
 * and a one-shot answer per step on the variant. Asserts the phase
 * five exit criterion (context-discipline angle):
 *
 *   - `peakContextWindowBytes` shows winner-variant on at least some
 *     fixtures and never winner-baseline. The planner-executor's
 *     per-step sub-loop starts fresh between steps, so its largest
 *     prompt is bounded by `stepMaxTurns` × per-iteration scratch.
 *     The baseline ReAct loop accumulates scratch across turns until
 *     the LLM stops asking for tools, so its peak grows with the
 *     workflow length.
 *   - `taskSuccessRate` never shows winner-baseline (success rate
 *     does not regress).
 *   - `truthfulnessViolationRate` never shows winner-baseline (no
 *     truthfulness regression).
 *
 * Other cost metrics (wall-clock, tokens) are NOT asserted: the
 * planner-executor adds per-step framing tokens and can take more or
 * fewer turns depending on the stub. The brief's predicted win is the
 * flat context window, which is what we assert here.
 */

import { describe, expect, test } from 'bun:test';

import type { RunRecord } from '../../src/eval/run-record.js';
import { registerAllSpecs } from '../../src/eval/spec-helpers.js';
import {
  type ChatEvent,
  type ChatRequest,
  type LlmClient,
  type SpecResult,
  type TaskFixture,
  collectMetrics,
  compareMetrics,
  createDispatch,
  createPlannerExecutorStrategy,
  createReactLoopStrategy,
  createSpecRegistry,
  createToolRegistry,
  evaluateSpec,
  renderMarkdown,
  runFixture,
} from '../../src/index.js';

import { registerDelayedTools } from './helpers/delayed-tools.js';

const TRIALS = 3;

/**
 * Five synthetic fixtures spanning a mix of diagnostic and generative
 * skills. Each prompt embeds the skill's trigger hint so the default
 * keyword router (used by the planner-executor variant) classifies it
 * deterministically. Each fixture uses `report-mentions/at-least-one-of`
 * so the success spec reads `record.assistantText` — the surface both
 * strategies emit identical text into.
 *
 * The token `done` is in the spec — the stub emits it on the FINAL turn
 * of either strategy, so both sides pass the success check.
 */
const SUBSET_FIXTURES: readonly TaskFixture[] = [
  {
    id: 'planexec-cmp/firestore-rules-audit',
    skill: 'firestore-rules-audit',
    description: 'planner-executor comparison synthetic: audit firestore rules.',
    prompt: 'Audit my firestore security rules and report on the vulnerability findings.',
    successSpec: {
      name: 'report-mentions/at-least-one-of',
      args: { tokens: ['done'] },
    },
  },
  {
    id: 'planexec-cmp/rtdb-data-modeling',
    skill: 'rtdb-data-modeling',
    description: 'planner-executor comparison synthetic: rtdb data modeling.',
    prompt: 'Help me model my rtdb realtime data schema with the right structure.',
    successSpec: {
      name: 'report-mentions/at-least-one-of',
      args: { tokens: ['done'] },
    },
  },
  {
    id: 'planexec-cmp/firebase-client-sdk',
    skill: 'firebase-client-sdk',
    description: 'planner-executor comparison synthetic: firebase client sdk init.',
    prompt: 'Generate the firebase client sdk app init and a query listener.',
    successSpec: {
      name: 'report-mentions/at-least-one-of',
      args: { tokens: ['done'] },
    },
  },
  {
    id: 'planexec-cmp/pyric-agents',
    skill: 'pyric-agents',
    description: 'planner-executor comparison synthetic: pyric rules and seed.',
    prompt: 'Use the pyric mcp tools to author firestore rules and seed data, with lint clean.',
    successSpec: {
      name: 'report-mentions/at-least-one-of',
      args: { tokens: ['done'] },
    },
  },
  {
    id: 'planexec-cmp/rtdb-game-rules',
    skill: 'rtdb-game-rules',
    description: 'planner-executor comparison synthetic: rtdb turn-based game rules.',
    prompt: 'Write rtdb security rules for a turn-based multiplayer game.',
    successSpec: {
      name: 'report-mentions/at-least-one-of',
      args: { tokens: ['done'] },
    },
  },
];

/**
 * Stub `LlmClient`. The stub emits a tool call until the current
 * ReAct loop has produced enough tool iterations, then emits the
 * final-text `done` token.
 *
 * The "enough" budget depends on which strategy is driving:
 *
 *   - When the system prompt does NOT contain the planner-executor's
 *     step marker (`step X of Y`), this is the baseline ReAct loop.
 *     The stub does `baselineTurns` tool iterations before emitting
 *     final text, simulating the workflow happening in one growing
 *     context.
 *   - When the system prompt contains the step marker, this is a
 *     planner-executor sub-loop. The stub does `stepTurns` tool
 *     iterations per step before emitting final text.
 *
 * The strategy difference is the count of assistant turns the stub
 * already sees in the inbound `req.messages` — that's the number of
 * tool iterations already executed THIS loop. The stub doesn't need
 * a counter of its own.
 *
 * Why this design: both sides exercise tools, but the planner-
 * executor's per-step sub-loop sees its own (fresh) message array, so
 * the peak request size is bounded by `stepTurns × per-iteration
 * scratch + summary chain`. The baseline ReAct loop iterates
 * `baselineTurns` times in ONE growing message array, so its peak
 * scales with `baselineTurns × per-iteration scratch`.
 */
function createBudgetedStub(
  toolNames: readonly string[],
  baselineTurns: number,
  stepTurns: number,
): LlmClient {
  return {
    id: 'planexec-cmp-stub',
    supportsTools: true,
    chat(req: ChatRequest): AsyncIterable<ChatEvent> {
      const sysText = req.messages.find((m) => m.role === 'system')?.text ?? '';
      const isPlannerSubLoop = /step \d+ of \d+/i.test(sysText);
      const budget = isPlannerSubLoop ? stepTurns : baselineTurns;

      // Count assistant messages in the current request's history —
      // that's how many tool iterations this LOOP has already
      // performed.
      let priorIterations = 0;
      for (const m of req.messages) {
        if (m.role === 'assistant') priorIterations += 1;
      }
      const events: ChatEvent[] = [];
      if (priorIterations < budget) {
        const toolName = toolNames[priorIterations % toolNames.length]!;
        events.push({
          kind: 'tool_call',
          id: `call-${priorIterations}`,
          name: toolName,
          args: { iteration: priorIterations },
        });
      } else {
        events.push({ kind: 'text', chunk: 'All steps done.' });
      }
      events.push({
        kind: 'turn_complete',
        usage: { promptTokens: 50, completionTokens: 10 },
        details: { requestedModel: 'planexec-cmp-stub' },
      });
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

async function runOneSide(
  fixtures: readonly TaskFixture[],
  strategyName: 'baseline' | 'variant',
): Promise<{ records: RunRecord[]; evaluations: SpecResult[] }> {
  const toolRegistry = createToolRegistry();
  // Three parallel-safe stub tools so the multi-turn stub LLM has
  // something to dispatch each iteration. `registerDelayedTools`
  // suffices — the comparison does not care about per-tool latency
  // for the peak-context metric.
  const toolList = registerDelayedTools(toolRegistry, 3, 0);
  const toolNames = toolList.map((h) => h.name);
  const tools = createDispatch(toolRegistry);

  const specRegistry = createSpecRegistry();
  registerAllSpecs(specRegistry);

  const records: RunRecord[] = [];
  const evaluations: SpecResult[] = [];

  for (const fixture of fixtures) {
    for (let trial = 0; trial < TRIALS; trial++) {
      // Stub budgets: baseline simulates the whole workflow in one
      // growing context (8 tool iterations); each planner-executor
      // step does 2 tool iterations + 1 final text in a fresh sub-
      // loop. With `stepMaxTurns: 4`, each step's sub-loop settles
      // cleanly within budget. The variant ends up doing MORE total
      // tool work (2 * step count vs baseline's flat 8), but its
      // largest single LLM request stays bounded by step scratch +
      // summary chain — strictly smaller than the baseline's
      // accumulated message array.
      const llm = createBudgetedStub(toolNames, 8, 2);
      const strategy =
        strategyName === 'baseline'
          ? createReactLoopStrategy()
          : createPlannerExecutorStrategy({ stepMaxTurns: 4 });
      const record = await runFixture({
        fixture,
        trial,
        llm,
        tools,
        toolList,
        strategy,
        maxWallClockMs: 30_000,
      });
      records.push(record);
      const evaluation = await evaluateSpec(specRegistry, fixture.successSpec, {
        finalWorkspace: record.finalWorkspace,
        finalRuntime: record.finalRuntime,
        assistantText: record.assistantText,
        trace: record.trace,
      });
      evaluations.push(evaluation);
    }
  }

  return { records, evaluations };
}

describe('planner-executor comparison (phase five exit check)', () => {
  test(
    'planner-executor flattens peak context window without regressing success or truthfulness',
    async () => {
      const baseline = await runOneSide(SUBSET_FIXTURES, 'baseline');
      const variant = await runOneSide(SUBSET_FIXTURES, 'variant');

      const baselineTables = collectMetrics({
        records: baseline.records,
        evaluations: baseline.evaluations,
        toolRegistry: createToolRegistry(),
      });
      const variantTables = collectMetrics({
        records: variant.records,
        evaluations: variant.evaluations,
        toolRegistry: createToolRegistry(),
      });

      const report = compareMetrics({
        baseline: baselineTables,
        variant: variantTables,
        baselineName: 'react-loop',
        variantName: 'planner-executor',
      });

      // Surface the head of the rendered report so the assertion's
      // context is visible in test output.
      const rendered = renderMarkdown(report);
      const head = rendered.split('\n').slice(0, 60).join('\n');
      // eslint-disable-next-line no-console
      console.log('\n=== planner-executor comparison (first 60 lines) ===\n');
      // eslint-disable-next-line no-console
      console.log(head);

      // ---- compute per-side mean peak context window for the report ----
      const baselinePeakMeans: number[] = [];
      const variantPeakMeans: number[] = [];
      for (const t of baselineTables) {
        if (typeof t.aggregate.peakContextWindowBytes.mean === 'number') {
          baselinePeakMeans.push(t.aggregate.peakContextWindowBytes.mean);
        }
      }
      for (const t of variantTables) {
        if (typeof t.aggregate.peakContextWindowBytes.mean === 'number') {
          variantPeakMeans.push(t.aggregate.peakContextWindowBytes.mean);
        }
      }
      const avg = (xs: readonly number[]): number =>
        xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
      // eslint-disable-next-line no-console
      console.log(
        `[planexec-cmp] baseline meanPeakContextWindowBytes=${avg(baselinePeakMeans).toFixed(
          1,
        )} variant meanPeakContextWindowBytes=${avg(variantPeakMeans).toFixed(1)}`,
      );

      // ---- assertion 1: peakContextWindowBytes wins on at least some fixtures, never loses ----
      const peakRows: { fixtureId: string; label: string }[] = [];
      for (const fixture of report.fixtures) {
        const row = fixture.rows.find((r) => r.metric === 'peakContextWindowBytes');
        if (row) peakRows.push({ fixtureId: fixture.fixtureId, label: row.label });
      }
      const peakWinners = peakRows.filter((r) => r.label === 'winner-variant').length;
      const peakLosers = peakRows.filter((r) => r.label === 'winner-baseline').length;
      // eslint-disable-next-line no-console
      console.log(
        `[planexec-cmp] peakContextWindowBytes winner-variant=${peakWinners} winner-baseline=${peakLosers} no-effect=${peakRows.length - peakWinners - peakLosers}`,
      );
      expect(peakLosers).toBe(0);
      expect(peakWinners).toBeGreaterThan(0);

      // ---- assertion 2: no regression on task success or truthfulness ----
      const regressions: string[] = [];
      for (const fixture of report.fixtures) {
        for (const row of fixture.rows) {
          if (row.metric !== 'taskSuccessRate' && row.metric !== 'truthfulnessViolationRate') {
            continue;
          }
          if (row.label === 'winner-baseline') {
            regressions.push(
              `${fixture.fixtureId} :: ${row.metric} regressed (delta=${row.delta}, threshold=${row.threshold})`,
            );
          }
        }
      }
      if (regressions.length > 0) {
        throw new Error(`regressions detected:\n${regressions.join('\n')}`);
      }
    },
    { timeout: 60_000 },
  );
});
