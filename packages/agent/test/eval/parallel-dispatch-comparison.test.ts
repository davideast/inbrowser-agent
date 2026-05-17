/**
 * Phase two exit check.
 *
 * Runs the harness across every golden task fixture twice — once with
 * `parallelDispatch: false` (baseline) and once with
 * `parallelDispatch: true` (variant). Asserts the implementation
 * plan's phase two exit criterion:
 *
 *   - wallClockMs shows winner-variant on at least some fixtures and
 *     never winner-baseline (the predicted improvement is real and
 *     never reversed).
 *   - taskSuccessRate and truthfulnessViolationRate show no
 *     winner-baseline anywhere (no regression in success or honesty).
 *
 * A tool-using stub LLM emits three parallel-safe tool calls per first
 * turn so the strategy actually has tools to dispatch; otherwise the
 * comparison would be the same as the phase one smoke (no tool work,
 * no wall-clock difference).
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord } from '../../src/eval/run-record.js';
import { registerAllSpecs } from '../../src/eval/spec-helpers.js';
import {
  type SpecResult,
  type TaskFixture,
  type ToolRegistry,
  collectMetrics,
  compareMetrics,
  createDispatch,
  createReactLoopStrategy,
  createSpecRegistry,
  createToolRegistry,
  evaluateSpec,
  renderMarkdown,
  runFixture,
} from '../../src/index.js';
import { loadFixtures } from '../../src/node.js';

import { registerDelayedTools } from './helpers/delayed-tools.js';
import { createToolUsingStubLlm } from './helpers/tool-using-stub-llm.js';

const TRIALS = 3;
const TOOL_COUNT = 3;
const TOOL_DELAY_MS = 25;
const FIXTURES_ROOT = join(import.meta.dir, '..', '..', 'fixtures');

function walkFixtureDirs(root: string): string[] {
  const out: string[] = [];
  for (const family of readdirSync(root)) {
    const familyDir = join(root, family);
    if (!statSync(familyDir).isDirectory()) continue;
    for (const skill of readdirSync(familyDir)) {
      const skillDir = join(familyDir, skill);
      if (!statSync(skillDir).isDirectory()) continue;
      out.push(skillDir);
    }
  }
  return out;
}

function loadAllFixtures(): TaskFixture[] {
  const dirs = walkFixtureDirs(FIXTURES_ROOT);
  const fixtures: TaskFixture[] = [];
  for (const dir of dirs) {
    fixtures.push(...loadFixtures(dir));
  }
  return fixtures;
}

interface SideResult {
  records: RunRecord[];
  evaluations: SpecResult[];
  toolRegistry: ToolRegistry;
}

async function runOneSide(
  fixtures: readonly TaskFixture[],
  parallelDispatch: boolean,
  sideId: string,
): Promise<SideResult> {
  const toolRegistry = createToolRegistry();
  const toolList = registerDelayedTools(toolRegistry, TOOL_COUNT, TOOL_DELAY_MS);
  const toolNames = toolList.map((h) => h.name);
  const tools = createDispatch(toolRegistry);

  const specRegistry = createSpecRegistry();
  registerAllSpecs(specRegistry);

  const records: RunRecord[] = [];
  const evaluations: SpecResult[] = [];

  for (const fixture of fixtures) {
    for (let trial = 0; trial < TRIALS; trial++) {
      const record = await runFixture({
        fixture,
        trial,
        llm: createToolUsingStubLlm({ toolNames, trial, id: sideId }),
        tools,
        toolList,
        strategy: createReactLoopStrategy({ parallelDispatch }),
        maxWallClockMs: 10_000,
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

  return { records, evaluations, toolRegistry };
}

describe('parallel-dispatch comparison (phase two exit check)', () => {
  test(
    'parallel-dispatch wins wall-clock without regressing success or truthfulness',
    async () => {
      const fixtures = loadAllFixtures();
      expect(fixtures.length).toBeGreaterThan(0);

      const baseline = await runOneSide(fixtures, false, 'baseline-sequential');
      const variant = await runOneSide(fixtures, true, 'variant-parallel');

      const baselineTables = collectMetrics({
        records: baseline.records,
        evaluations: baseline.evaluations,
        toolRegistry: baseline.toolRegistry,
      });
      const variantTables = collectMetrics({
        records: variant.records,
        evaluations: variant.evaluations,
        toolRegistry: variant.toolRegistry,
      });

      const report = compareMetrics({
        baseline: baselineTables,
        variant: variantTables,
        baselineName: 'sequential',
        variantName: 'parallel',
      });

      // Surface a sample of the rendered report so the assertion's
      // context is visible in test output.
      const rendered = renderMarkdown(report);
      const head = rendered.split('\n').slice(0, 60).join('\n');
      console.log('\n=== parallel-dispatch comparison (first 60 lines) ===\n');
      console.log(head);

      // ---- assertion 1: wall-clock has winners, never losers ----
      const wallClockRows: { fixtureId: string; label: string }[] = [];
      for (const fixture of report.fixtures) {
        const row = fixture.rows.find((r) => r.metric === 'wallClockMs');
        if (row) wallClockRows.push({ fixtureId: fixture.fixtureId, label: row.label });
      }
      const winners = wallClockRows.filter((r) => r.label === 'winner-variant').length;
      const losers = wallClockRows.filter((r) => r.label === 'winner-baseline').length;

      expect(losers).toBe(0);
      expect(winners).toBeGreaterThan(0);

      // ---- assertion 2: no regression on success or truthfulness ----
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
