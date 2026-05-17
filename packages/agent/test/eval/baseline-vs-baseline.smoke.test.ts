/**
 * Phase one exit check.
 *
 * Composes the entire harness end-to-end and asserts the implementation
 * plan's exit rule: comparing the baseline strategy against itself
 * produces a `no-effect` label on every metric of every fixture.
 *
 * If this test fails, the harness's measurement infrastructure is not
 * trustworthy yet. Phase two strategy experiments should not run on
 * top of a harness that cannot tell baseline from baseline.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord } from '../../src/eval/run-record.js';
import { registerAllSpecs } from '../../src/eval/spec-helpers.js';
import {
  type MetricsTable,
  type SpecResult,
  type TaskFixture,
  collectMetrics,
  compareMetrics,
  createDispatch,
  createSpecRegistry,
  createToolRegistry,
  evaluateSpec,
  runFixture,
} from '../../src/index.js';
import { loadFixtures } from '../../src/node.js';
import { createStubLlm } from './helpers/stub-llm.js';

const TRIALS_PER_FIXTURE = 3;
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

async function runOneSide(
  fixtures: readonly TaskFixture[],
  sideId: string,
): Promise<{ records: RunRecord[]; evaluations: SpecResult[] }> {
  const toolRegistry = createToolRegistry();
  const tools = createDispatch(toolRegistry);
  const specRegistry = createSpecRegistry();
  registerAllSpecs(specRegistry);

  const records: RunRecord[] = [];
  const evaluations: SpecResult[] = [];

  for (const fixture of fixtures) {
    for (let trial = 0; trial < TRIALS_PER_FIXTURE; trial++) {
      const record = await runFixture({
        fixture,
        trial,
        llm: createStubLlm({ trial, id: sideId }),
        tools,
        toolList: [],
        maxWallClockMs: 5000,
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

describe('baseline-vs-baseline harness smoke', () => {
  test('the full harness composes and runs against every golden fixture', async () => {
    const fixtures = loadAllFixtures();
    expect(fixtures.length).toBeGreaterThan(0);

    const toolRegistry = createToolRegistry();
    const left = await runOneSide(fixtures, 'baseline-a');
    const right = await runOneSide(fixtures, 'baseline-b');

    expect(left.records.length).toBe(fixtures.length * TRIALS_PER_FIXTURE);
    expect(right.records.length).toBe(left.records.length);

    const leftTables: MetricsTable[] = collectMetrics({
      records: left.records,
      evaluations: left.evaluations,
      toolRegistry,
    });
    const rightTables: MetricsTable[] = collectMetrics({
      records: right.records,
      evaluations: right.evaluations,
      toolRegistry,
    });

    expect(leftTables.length).toBe(fixtures.length);
    expect(rightTables.length).toBe(fixtures.length);

    const report = compareMetrics({
      baseline: leftTables,
      variant: rightTables,
      baselineName: 'baseline-a',
      variantName: 'baseline-b',
    });

    expect(report.fixtures.length).toBe(fixtures.length);
    for (const fixture of report.fixtures) {
      expect(fixture.status).toBe('both');
    }
  });

  test('every metric on every fixture is labeled no-effect', async () => {
    const fixtures = loadAllFixtures();
    const toolRegistry = createToolRegistry();
    const left = await runOneSide(fixtures, 'baseline-a');
    const right = await runOneSide(fixtures, 'baseline-b');

    const leftTables = collectMetrics({
      records: left.records,
      evaluations: left.evaluations,
      toolRegistry,
    });
    const rightTables = collectMetrics({
      records: right.records,
      evaluations: right.evaluations,
      toolRegistry,
    });

    const report = compareMetrics({
      baseline: leftTables,
      variant: rightTables,
      baselineName: 'baseline-a',
      variantName: 'baseline-b',
    });

    const offenders: string[] = [];
    for (const fixture of report.fixtures) {
      for (const row of fixture.rows) {
        if (row.label !== 'no-effect') {
          offenders.push(
            `${fixture.fixtureId} :: ${row.metric} = ${row.label} ` +
              `(delta=${row.delta}, threshold=${row.threshold}, polarity=${row.polarity})`,
          );
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `baseline-vs-baseline produced non-no-effect labels:\n${offenders.join('\n')}`,
      );
    }
  });
});
