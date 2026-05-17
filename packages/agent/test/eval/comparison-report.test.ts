import { describe, expect, test } from 'bun:test';
import {
  type AggregateStat,
  type AggregatedMetrics,
  type ComparisonReport,
  type ComparisonRow,
  type MetricsTable,
  POLARITY,
  compareMetrics,
  renderJson,
  renderMarkdown,
} from '../../src/index.js';

// ---------- builders ----------

/**
 * Build an `AggregateStat`. Default `count` is 3 (the harness's
 * default trials-per-cell). Pass `count: 1` to model a single-trial
 * aggregate where `stdDev` is `0`.
 */
function stat(mean: number | undefined, stdDev: number | undefined, count = 3): AggregateStat {
  return { mean, stdDev, count };
}

const UNDEFINED_STAT: AggregateStat = { mean: undefined, stdDev: undefined, count: 0 };

/**
 * Build a `MetricsTable` from a partial aggregate. Missing fields
 * default to `UNDEFINED_STAT`. The `trials` array is left empty
 * because the comparator does not consume it.
 */
function table(
  fixtureId: string,
  partial: Partial<Omit<AggregatedMetrics, 'fixtureId' | 'trials' | 'toolCallCount'>> & {
    toolCallCount?: Partial<AggregatedMetrics['toolCallCount']>;
    trials?: number;
  } = {},
): MetricsTable {
  const trials = partial.trials ?? 3;
  const tcc = partial.toolCallCount ?? {};
  const aggregate: AggregatedMetrics = {
    fixtureId,
    trials,
    taskSuccessRate: partial.taskSuccessRate ?? UNDEFINED_STAT,
    wallClockMs: partial.wallClockMs ?? UNDEFINED_STAT,
    promptTokens: partial.promptTokens ?? UNDEFINED_STAT,
    completionTokens: partial.completionTokens ?? UNDEFINED_STAT,
    toolCallCount: {
      total: tcc.total ?? UNDEFINED_STAT,
      reads: tcc.reads ?? UNDEFINED_STAT,
      mutations: tcc.mutations ?? UNDEFINED_STAT,
    },
    turnCount: partial.turnCount ?? UNDEFINED_STAT,
    peakContextWindowBytes: partial.peakContextWindowBytes ?? UNDEFINED_STAT,
    truthfulnessViolationRate: partial.truthfulnessViolationRate ?? UNDEFINED_STAT,
    dispatchVsLlmRatio: partial.dispatchVsLlmRatio ?? UNDEFINED_STAT,
  };
  return { fixtureId, trials: [], aggregate };
}

function rowFor(
  report: ComparisonReport,
  fixtureId: string,
  metric: ComparisonRow['metric'],
): ComparisonRow {
  const fix = report.fixtures.find((f) => f.fixtureId === fixtureId);
  if (!fix) throw new Error(`fixture ${fixtureId} not in report`);
  const row = fix.rows.find((r) => r.metric === metric);
  if (!row) throw new Error(`row ${metric} not in fixture ${fixtureId}`);
  return row;
}

// ---------- polarity map ----------

describe('POLARITY map', () => {
  test('declares the metrics the brief calls out by name', () => {
    expect(POLARITY.taskSuccessRate).toBe('higher-is-better');
    expect(POLARITY.wallClockMs).toBe('lower-is-better');
    expect(POLARITY.promptTokens).toBe('lower-is-better');
    expect(POLARITY.completionTokens).toBe('lower-is-better');
    expect(POLARITY.truthfulnessViolationRate).toBe('lower-is-better');
    expect(POLARITY.peakContextWindowBytes).toBe('lower-is-better');
  });

  test('marks context-dependent metrics neutral', () => {
    expect(POLARITY['toolCallCount.total']).toBe('neutral');
    expect(POLARITY['toolCallCount.reads']).toBe('neutral');
    expect(POLARITY['toolCallCount.mutations']).toBe('neutral');
    expect(POLARITY.turnCount).toBe('neutral');
    expect(POLARITY.dispatchVsLlmRatio).toBe('neutral');
  });
});

// ---------- no-effect rule ----------

describe('no-effect rule — single-trial inputs (zero spread)', () => {
  // With count=1, stdDev is 0 on both sides, so any non-zero delta
  // exceeds the threshold and produces a winner.
  test('non-zero delta always picks a winner', () => {
    const baseline = [table('fix', { wallClockMs: stat(1000, 0, 1) })];
    const variant = [table('fix', { wallClockMs: stat(800, 0, 1) })];
    const report = compareMetrics({ baseline, variant });
    const row = rowFor(report, 'fix', 'wallClockMs');
    expect(row.delta).toBe(-200);
    expect(row.threshold).toBe(0);
    // wallClockMs is lower-is-better and delta < 0 → variant wins.
    expect(row.label).toBe('winner-variant');
  });

  test('exact-zero delta is no-effect', () => {
    const baseline = [table('fix', { wallClockMs: stat(1000, 0, 1) })];
    const variant = [table('fix', { wallClockMs: stat(1000, 0, 1) })];
    const report = compareMetrics({ baseline, variant });
    const row = rowFor(report, 'fix', 'wallClockMs');
    expect(row.delta).toBe(0);
    expect(row.threshold).toBe(0);
    expect(row.label).toBe('no-effect');
  });
});

describe('no-effect rule — multi-trial inputs (large within-variant spread)', () => {
  test('delta visibly nonzero but smaller than larger spread → no-effect', () => {
    // Baseline mean 1000, spread 250. Variant mean 850, spread 300.
    // |delta| = 150, threshold = max(250, 300) = 300. 150 < 300 → no-effect.
    const baseline = [table('fix', { wallClockMs: stat(1000, 250, 3) })];
    const variant = [table('fix', { wallClockMs: stat(850, 300, 3) })];
    const report = compareMetrics({ baseline, variant });
    const row = rowFor(report, 'fix', 'wallClockMs');
    expect(row.delta).toBe(-150);
    expect(row.threshold).toBe(300);
    expect(row.label).toBe('no-effect');
  });

  test('threshold uses the *larger* of the two spreads', () => {
    // Baseline spread 10 (tight), variant spread 300 (noisy).
    // Delta -150. |delta| < threshold(300) → no-effect.
    const baseline = [table('fix', { wallClockMs: stat(1000, 10, 3) })];
    const variant = [table('fix', { wallClockMs: stat(850, 300, 3) })];
    const report = compareMetrics({ baseline, variant });
    const row = rowFor(report, 'fix', 'wallClockMs');
    expect(row.threshold).toBe(300);
    expect(row.label).toBe('no-effect');
  });

  test('delta clearly larger than both spreads → winner is chosen', () => {
    const baseline = [table('fix', { wallClockMs: stat(1000, 20, 3) })];
    const variant = [table('fix', { wallClockMs: stat(500, 30, 3) })];
    const report = compareMetrics({ baseline, variant });
    const row = rowFor(report, 'fix', 'wallClockMs');
    expect(row.delta).toBe(-500);
    expect(row.threshold).toBe(30);
    expect(row.label).toBe('winner-variant');
  });

  test('|delta| equal to threshold rises above the bar (strict `<` on no-effect)', () => {
    // The implementation plan defines the no-effect rule as `Math.abs(delta) < threshold`.
    // Strict `<` means an exact tie escapes no-effect and earns a winner label.
    // This matches the brief's literal text; see classify() in comparison-report.ts.
    const baseline = [table('fix', { wallClockMs: stat(1000, 100, 3) })];
    const variant = [table('fix', { wallClockMs: stat(900, 50, 3) })];
    const report = compareMetrics({ baseline, variant });
    const row = rowFor(report, 'fix', 'wallClockMs');
    expect(row.delta).toBe(-100);
    expect(row.threshold).toBe(100);
    expect(row.label).toBe('winner-variant');
  });
});

// ---------- polarity-direction tests ----------

describe('polarity directions', () => {
  test('higher-is-better: positive delta → variant wins; negative → baseline wins', () => {
    // taskSuccessRate is higher-is-better.
    const baseline = [table('fix', { taskSuccessRate: stat(0.5, 0.05, 3) })];
    const variant = [table('fix', { taskSuccessRate: stat(0.9, 0.05, 3) })];
    const report = compareMetrics({ baseline, variant });
    const row = rowFor(report, 'fix', 'taskSuccessRate');
    expect(row.delta).toBeCloseTo(0.4, 6);
    expect(row.label).toBe('winner-variant');

    const reverse = compareMetrics({
      baseline: [table('fix', { taskSuccessRate: stat(0.9, 0.05, 3) })],
      variant: [table('fix', { taskSuccessRate: stat(0.5, 0.05, 3) })],
    });
    expect(rowFor(reverse, 'fix', 'taskSuccessRate').label).toBe('winner-baseline');
  });

  test('lower-is-better: positive delta → baseline wins; negative → variant wins', () => {
    // wallClockMs is lower-is-better. The signs invert vs higher-is-better.
    const baseline = [table('fix', { wallClockMs: stat(1000, 20, 3) })];
    const variant = [table('fix', { wallClockMs: stat(500, 20, 3) })];
    const variantWins = compareMetrics({ baseline, variant });
    expect(rowFor(variantWins, 'fix', 'wallClockMs').label).toBe('winner-variant');

    const baselineWins = compareMetrics({
      baseline: [table('fix', { wallClockMs: stat(500, 20, 3) })],
      variant: [table('fix', { wallClockMs: stat(1000, 20, 3) })],
    });
    expect(rowFor(baselineWins, 'fix', 'wallClockMs').label).toBe('winner-baseline');
  });

  test('neutral: a meaningful movement is labeled `changed`, not winner/loser', () => {
    // toolCallCount.total is neutral by default.
    const baseline = [
      table('fix', {
        toolCallCount: { total: stat(10, 0.5, 3) },
      }),
    ];
    const variant = [
      table('fix', {
        toolCallCount: { total: stat(30, 0.5, 3) },
      }),
    ];
    const report = compareMetrics({ baseline, variant });
    const row = rowFor(report, 'fix', 'toolCallCount.total');
    expect(row.delta).toBe(20);
    expect(row.label).toBe('changed');
  });

  test('polarityOverrides flips a neutral default to a directional read', () => {
    const baseline = [table('fix', { toolCallCount: { total: stat(10, 0.5, 3) } })];
    const variant = [table('fix', { toolCallCount: { total: stat(30, 0.5, 3) } })];
    const report = compareMetrics({
      baseline,
      variant,
      polarityOverrides: { 'toolCallCount.total': 'lower-is-better' },
    });
    const row = rowFor(report, 'fix', 'toolCallCount.total');
    expect(row.polarity).toBe('lower-is-better');
    // Positive delta on lower-is-better → baseline wins.
    expect(row.label).toBe('winner-baseline');
  });
});

// ---------- undefined / missing-data handling ----------

describe('undefined / missing-data handling', () => {
  test('undefined mean on either side → no-effect with undefined delta/threshold', () => {
    const baseline = [table('fix', { promptTokens: UNDEFINED_STAT })];
    const variant = [table('fix', { promptTokens: stat(100, 5, 3) })];
    const report = compareMetrics({ baseline, variant });
    const row = rowFor(report, 'fix', 'promptTokens');
    expect(row.delta).toBeUndefined();
    expect(row.threshold).toBeUndefined();
    expect(row.label).toBe('no-effect');
  });

  test('fixture present only in baseline → status baseline-only, no rows', () => {
    const baseline = [table('only-base', { wallClockMs: stat(1000, 10, 3) })];
    const variant: MetricsTable[] = [];
    const report = compareMetrics({ baseline, variant });
    expect(report.fixtures).toHaveLength(1);
    expect(report.fixtures[0]?.status).toBe('baseline-only');
    expect(report.fixtures[0]?.rows).toEqual([]);
  });

  test('fixture present only in variant → status variant-only, no rows', () => {
    const baseline: MetricsTable[] = [];
    const variant = [table('only-var', { wallClockMs: stat(1000, 10, 3) })];
    const report = compareMetrics({ baseline, variant });
    expect(report.fixtures).toHaveLength(1);
    expect(report.fixtures[0]?.status).toBe('variant-only');
    expect(report.fixtures[0]?.rows).toEqual([]);
  });

  test('union order: baseline order first, then variant-only fixtures', () => {
    const baseline = [
      table('a', { wallClockMs: stat(1, 0, 1) }),
      table('b', { wallClockMs: stat(2, 0, 1) }),
    ];
    const variant = [
      table('b', { wallClockMs: stat(2, 0, 1) }),
      table('c', { wallClockMs: stat(3, 0, 1) }),
    ];
    const report = compareMetrics({ baseline, variant });
    expect(report.fixtures.map((f) => f.fixtureId)).toEqual(['a', 'b', 'c']);
    expect(report.fixtures[0]?.status).toBe('baseline-only');
    expect(report.fixtures[1]?.status).toBe('both');
    expect(report.fixtures[2]?.status).toBe('variant-only');
  });
});

// ---------- naming + report shape ----------

describe('report shape', () => {
  test('default names are baseline / variant', () => {
    const report = compareMetrics({ baseline: [], variant: [] });
    expect(report.baselineName).toBe('baseline');
    expect(report.variantName).toBe('variant');
    expect(report.fixtures).toEqual([]);
  });

  test('custom names round-trip through the report', () => {
    const report = compareMetrics({
      baseline: [],
      variant: [],
      baselineName: 'react-loop',
      variantName: 'parallel-dispatch',
    });
    expect(report.baselineName).toBe('react-loop');
    expect(report.variantName).toBe('parallel-dispatch');
  });

  test('every metric in the polarity map appears as a row when both sides have the fixture', () => {
    const baseline = [table('fix', { wallClockMs: stat(1000, 10, 3) })];
    const variant = [table('fix', { wallClockMs: stat(900, 10, 3) })];
    const report = compareMetrics({ baseline, variant });
    const fixture = report.fixtures[0];
    expect(fixture?.status).toBe('both');
    const metrics = fixture?.rows.map((r) => r.metric);
    expect(metrics).toEqual([
      'taskSuccessRate',
      'wallClockMs',
      'promptTokens',
      'completionTokens',
      'toolCallCount.total',
      'toolCallCount.reads',
      'toolCallCount.mutations',
      'turnCount',
      'peakContextWindowBytes',
      'truthfulnessViolationRate',
      'dispatchVsLlmRatio',
    ]);
  });
});

// ---------- renderers ----------

describe('renderJson', () => {
  test('round-trips through JSON.parse(JSON.stringify(report)) without loss', () => {
    const baseline = [
      table('fix-a', {
        taskSuccessRate: stat(0.5, 0.1, 3),
        wallClockMs: stat(1000, 50, 3),
        toolCallCount: { total: stat(8, 0.5, 3) },
      }),
    ];
    const variant = [
      table('fix-a', {
        taskSuccessRate: stat(0.9, 0.1, 3),
        wallClockMs: stat(700, 50, 3),
        toolCallCount: { total: stat(8, 0.5, 3) },
      }),
    ];
    const report = compareMetrics({ baseline, variant });
    const json = renderJson(report);
    const parsed = JSON.parse(json) as ComparisonReport;
    // The report shape is plain data — no functions, no Maps, etc. So
    // structural equality after a round-trip is the right check.
    expect(parsed).toEqual(JSON.parse(JSON.stringify(report)));
    // The labels survive the round-trip.
    const fix = parsed.fixtures.find((f) => f.fixtureId === 'fix-a');
    expect(fix?.rows.find((r) => r.metric === 'taskSuccessRate')?.label).toBe('winner-variant');
    expect(fix?.rows.find((r) => r.metric === 'wallClockMs')?.label).toBe('winner-variant');
  });
});

describe('renderMarkdown', () => {
  test('header has both names; one section per fixture', () => {
    const baseline = [table('fix-a', { wallClockMs: stat(1000, 10, 3) })];
    const variant = [table('fix-a', { wallClockMs: stat(700, 10, 3) })];
    const md = renderMarkdown(
      compareMetrics({ baseline, variant, baselineName: 'A', variantName: 'B' }),
    );
    expect(md).toContain('# Comparison: A vs B');
    expect(md).toContain('## fix-a');
  });

  test('emits a column header per fixture and one row per metric', () => {
    const baseline = [table('fix-a', { wallClockMs: stat(1000, 10, 3) })];
    const variant = [table('fix-a', { wallClockMs: stat(700, 10, 3) })];
    const md = renderMarkdown(compareMetrics({ baseline, variant }));
    expect(md).toContain('| metric | baseline | variant | delta | threshold | polarity | label |');
    // Each metric in POLARITY has a corresponding row.
    expect(md).toContain('| wallClockMs |');
    expect(md).toContain('| taskSuccessRate |');
    expect(md).toContain('| dispatchVsLlmRatio |');
  });

  test('writes mean ± spread (n=count) and dashes for undefined', () => {
    const baseline = [table('fix-a', { wallClockMs: stat(1000, 25, 3) })];
    const variant = [table('fix-a', { wallClockMs: stat(700, 25, 3) })];
    const md = renderMarkdown(compareMetrics({ baseline, variant }));
    // The wallClockMs row carries both means + spreads. Numeric
    // formatting is best-effort readable; the assertions only pin the
    // shape (mean ± spread (n=N)) and the count.
    expect(md).toMatch(/1000.* ± .*25.* \(n=3\)/);
    expect(md).toMatch(/700.* ± .*25.* \(n=3\)/);
    // taskSuccessRate is undefined on both sides → dashes.
    expect(md).toMatch(/\| taskSuccessRate \| - \| - \|/);
  });

  test('annotates baseline-only and variant-only fixtures with a note instead of rows', () => {
    const baseline = [table('only-base', { wallClockMs: stat(1, 0, 1) })];
    const variant = [table('only-var', { wallClockMs: stat(2, 0, 1) })];
    const md = renderMarkdown(compareMetrics({ baseline, variant }));
    expect(md).toContain('## only-base');
    expect(md).toContain('Present in baseline only');
    expect(md).toContain('## only-var');
    expect(md).toContain('Present in variant only');
    // No metric tables for the missing-side fixtures.
    expect(md).not.toContain('| only-base | wallClockMs |');
  });

  test('empty report renders a "no fixtures" note', () => {
    const md = renderMarkdown(compareMetrics({ baseline: [], variant: [] }));
    expect(md).toContain('# Comparison: baseline vs variant');
    expect(md).toContain('No fixtures in either input.');
  });
});

// ---------- end-to-end: hand-constructed two-fixture report ----------

describe('end-to-end: two-fixture comparison', () => {
  test('mixes a winner, a no-effect, and a neutral changed across two fixtures', () => {
    const baseline: MetricsTable[] = [
      table('rules-audit/a', {
        taskSuccessRate: stat(0.5, 0.1, 3),
        wallClockMs: stat(1200, 40, 3),
        toolCallCount: { total: stat(8, 1, 3), reads: stat(5, 1, 3), mutations: stat(3, 0.5, 3) },
      }),
      table('rules-audit/b', {
        taskSuccessRate: stat(0.6, 0.15, 3),
        wallClockMs: stat(900, 200, 3),
      }),
    ];
    const variant: MetricsTable[] = [
      table('rules-audit/a', {
        taskSuccessRate: stat(0.9, 0.1, 3),
        wallClockMs: stat(800, 40, 3),
        toolCallCount: {
          total: stat(20, 1, 3),
          reads: stat(15, 1, 3),
          mutations: stat(3, 0.5, 3),
        },
      }),
      table('rules-audit/b', {
        taskSuccessRate: stat(0.65, 0.15, 3),
        wallClockMs: stat(950, 200, 3),
      }),
    ];

    const report = compareMetrics({ baseline, variant });

    // Fixture A: taskSuccess winner (variant) and wallClock winner (variant).
    expect(rowFor(report, 'rules-audit/a', 'taskSuccessRate').label).toBe('winner-variant');
    expect(rowFor(report, 'rules-audit/a', 'wallClockMs').label).toBe('winner-variant');
    // Fixture A: toolCallCount.total jumped from 8 to 20 → `changed` (neutral).
    expect(rowFor(report, 'rules-audit/a', 'toolCallCount.total').label).toBe('changed');
    // Fixture B: tiny taskSuccess movement inside the spread → no-effect.
    expect(rowFor(report, 'rules-audit/b', 'taskSuccessRate').label).toBe('no-effect');
    // Fixture B: wallClock movement of 50 ms vs spread 200 → no-effect.
    expect(rowFor(report, 'rules-audit/b', 'wallClockMs').label).toBe('no-effect');
  });
});
