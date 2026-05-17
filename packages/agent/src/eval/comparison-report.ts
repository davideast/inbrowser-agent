/**
 * `compareMetrics` — the eval harness's A/B comparison report.
 *
 * Consumes two named `MetricsTable[]`s (typically a "baseline" and a
 * "variant"), pairs them by `fixtureId`, and for each per-metric
 * column emits a row containing the inputs (mean +/- spread for both
 * sides), the delta (`variantMean - baselineMean`), the threshold
 * (`max(baselineSpread, variantSpread)`), and a label.
 *
 * The label uses the implementation plan's no-effect rule:
 *
 *   - If `Math.abs(delta) < threshold`, label `no-effect`. This is the
 *     central discipline: noisy trial-to-trial variance must not be
 *     reported as a winner.
 *   - Otherwise consult the metric's polarity (see `POLARITY` below):
 *       higher-is-better -> sign of `delta` picks the winner;
 *       lower-is-better  -> sign of `delta` picks the loser;
 *       neutral          -> emit `changed` (no winner, just a flag).
 *
 * Polarity is a static map declared in this module. Adding a new
 * metric to the collector forces an entry here because the map is
 * keyed by a string-literal union derived from `MetricsTable` fields.
 *
 * Two renderers ship with the comparator:
 *
 *   - `renderMarkdown(report)` — a human-readable markdown table for
 *     piping to stdout from a CLI consumer.
 *   - `renderJson(report)` — `JSON.stringify(report, null, 2)`. Plain
 *     data; round-trips through `JSON.parse(JSON.stringify(report))`
 *     without loss.
 *
 * No statistical sophistication beyond the no-effect rule. Confidence
 * intervals, cross-fixture aggregation, and multi-variant comparisons
 * are deliberately deferred to follow-up branches.
 *
 * Browser-safe — no Node imports.
 *
 * Note on naming: metric names match the collector exactly. Do not
 * rename. The CLI, the report, and any later UI all key on these
 * identifiers, and renaming in one layer without the others silently
 * breaks consumers.
 */

import type { AggregateStat, MetricsTable } from './metric-collector.js';

// ---------- polarity map ----------

/**
 * The set of metric names a comparison row can target. Each name is
 * the dotted path from `AggregatedMetrics` down to an `AggregateStat`.
 * `toolCallCount` is a nested object on the aggregate; the three
 * children each get their own polarity entry.
 *
 * Keep this in lockstep with `AggregatedMetrics` in
 * `./metric-collector.ts`. The compiler enforces exhaustiveness on
 * `POLARITY` below.
 */
export type ComparisonMetricName =
  | 'taskSuccessRate'
  | 'wallClockMs'
  | 'promptTokens'
  | 'completionTokens'
  | 'toolCallCount.total'
  | 'toolCallCount.reads'
  | 'toolCallCount.mutations'
  | 'turnCount'
  | 'peakContextWindowBytes'
  | 'truthfulnessViolationRate'
  | 'dispatchVsLlmRatio';

/** Direction in which "more" is better, worse, or neither. */
export type Polarity = 'higher-is-better' | 'lower-is-better' | 'neutral';

/**
 * Static polarity table. Choices are documented per row; the
 * neutral defaults are the metrics the implementation plan
 * explicitly says are context-dependent.
 *
 * Adding a new metric to the collector requires adding an entry
 * here. The `Record<ComparisonMetricName, Polarity>` shape keeps the
 * compiler honest if `ComparisonMetricName` is extended.
 */
export const POLARITY: Record<ComparisonMetricName, Polarity> = {
  // Higher success rate is strictly better.
  taskSuccessRate: 'higher-is-better',
  // Lower latency / token spend / context pressure is better.
  wallClockMs: 'lower-is-better',
  promptTokens: 'lower-is-better',
  completionTokens: 'lower-is-better',
  peakContextWindowBytes: 'lower-is-better',
  // Lower violation rate is strictly better (zero is the goal).
  truthfulnessViolationRate: 'lower-is-better',
  // Tool-call counts are context-dependent: more reads can mean
  // better grounding (good) or wasted effort (bad). Neutral by
  // default. Specific experiments can re-interpret these via the
  // `polarityOverrides` input.
  'toolCallCount.total': 'neutral',
  'toolCallCount.reads': 'neutral',
  'toolCallCount.mutations': 'neutral',
  // Turn count is context-dependent for the same reason.
  turnCount: 'neutral',
  // Dispatch-vs-LLM ratio is a diagnostic, not a quality metric.
  dispatchVsLlmRatio: 'neutral',
};

// ---------- report types ----------

/** Label assigned to a per-metric row after applying the no-effect rule. */
export type ComparisonLabel = 'no-effect' | 'winner-baseline' | 'winner-variant' | 'changed';

/**
 * A single per-fixture, per-metric row.
 *
 * `delta` is `variantMean - baselineMean`. Both means are passed
 * through verbatim from the input aggregates and may be `undefined`
 * (the collector returns `undefined` for metrics it could not
 * compute). When either mean is `undefined`, the row's `label` is
 * `no-effect` and `delta` / `threshold` are `undefined` — there is
 * nothing to compare.
 */
export interface ComparisonRow {
  fixtureId: string;
  metric: ComparisonMetricName;
  polarity: Polarity;
  baseline: AggregateStat;
  variant: AggregateStat;
  /** `variantMean - baselineMean`. `undefined` when either mean is `undefined`. */
  delta: number | undefined;
  /** `max(baselineSpread, variantSpread)`. `undefined` when either spread is `undefined`. */
  threshold: number | undefined;
  label: ComparisonLabel;
}

/** Per-fixture grouping. Carries the comparison rows plus a coverage status. */
export interface ComparisonFixture {
  fixtureId: string;
  /**
   * `both` when the fixture appears in both inputs;
   * `baseline-only` / `variant-only` when one side is missing the
   * fixture. The missing-side cases carry no per-metric rows.
   */
  status: 'both' | 'baseline-only' | 'variant-only';
  rows: ComparisonRow[];
}

/** The full report. Suitable for both renderers. */
export interface ComparisonReport {
  /** Label for the left-hand side. Defaults to `'baseline'`. */
  baselineName: string;
  /** Label for the right-hand side. Defaults to `'variant'`. */
  variantName: string;
  /** One entry per fixture across both inputs, in baseline-first union order. */
  fixtures: ComparisonFixture[];
}

// ---------- comparator ----------

/** Input to `compareMetrics`. */
export interface CompareMetricsInput {
  baseline: readonly MetricsTable[];
  variant: readonly MetricsTable[];
  /** Optional label for the baseline column. Defaults to `'baseline'`. */
  baselineName?: string;
  /** Optional label for the variant column. Defaults to `'variant'`. */
  variantName?: string;
  /**
   * Override entries in the static `POLARITY` map for this report.
   * Useful when a specific experiment has a directional read on a
   * normally-neutral metric (e.g. parallel dispatch expects
   * `toolCallCount.reads` to stay flat — which is still neutral —
   * but a memoization experiment might prefer lower `wallClockMs`
   * exclusively without changing other directions; in practice the
   * defaults are correct and this is rarely needed).
   */
  polarityOverrides?: Partial<Record<ComparisonMetricName, Polarity>>;
}

/**
 * Build a `ComparisonReport` from two named metric tables.
 *
 * Fixtures present in both sides are paired; fixtures unique to one
 * side surface with an explicit `status` and no rows. Within each
 * paired fixture, every entry in `POLARITY` produces one row.
 *
 * Never throws on missing data — `undefined` means / spreads carry
 * through to `undefined` deltas / thresholds and a `no-effect` label.
 */
export function compareMetrics(input: CompareMetricsInput): ComparisonReport {
  const baselineName = input.baselineName ?? 'baseline';
  const variantName = input.variantName ?? 'variant';
  const overrides = input.polarityOverrides ?? {};
  const baselineMap = byFixtureId(input.baseline);
  const variantMap = byFixtureId(input.variant);

  // Union order: baseline fixtures in their input order, then variant
  // fixtures that did not appear in baseline (also in input order).
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const t of input.baseline) {
    if (seen.has(t.fixtureId)) continue;
    seen.add(t.fixtureId);
    ids.push(t.fixtureId);
  }
  for (const t of input.variant) {
    if (seen.has(t.fixtureId)) continue;
    seen.add(t.fixtureId);
    ids.push(t.fixtureId);
  }

  const fixtures: ComparisonFixture[] = [];
  for (const fixtureId of ids) {
    const b = baselineMap.get(fixtureId);
    const v = variantMap.get(fixtureId);
    if (b && !v) {
      fixtures.push({ fixtureId, status: 'baseline-only', rows: [] });
      continue;
    }
    if (!b && v) {
      fixtures.push({ fixtureId, status: 'variant-only', rows: [] });
      continue;
    }
    if (!b || !v) continue; // Defensive: should not happen given the union build.
    const rows: ComparisonRow[] = [];
    for (const metric of METRIC_NAMES) {
      const polarity = overrides[metric] ?? POLARITY[metric];
      const baselineStat = readStat(b, metric);
      const variantStat = readStat(v, metric);
      rows.push(buildRow(fixtureId, metric, polarity, baselineStat, variantStat));
    }
    fixtures.push({ fixtureId, status: 'both', rows });
  }

  return { baselineName, variantName, fixtures };
}

/** Iteration order for metric rows in a fixture. Stable and matches `POLARITY`. */
const METRIC_NAMES: readonly ComparisonMetricName[] = [
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
];

function buildRow(
  fixtureId: string,
  metric: ComparisonMetricName,
  polarity: Polarity,
  baseline: AggregateStat,
  variant: AggregateStat,
): ComparisonRow {
  if (
    baseline.mean === undefined ||
    variant.mean === undefined ||
    baseline.stdDev === undefined ||
    variant.stdDev === undefined
  ) {
    return {
      fixtureId,
      metric,
      polarity,
      baseline,
      variant,
      delta: undefined,
      threshold: undefined,
      label: 'no-effect',
    };
  }
  const delta = variant.mean - baseline.mean;
  const threshold = Math.max(baseline.stdDev, variant.stdDev);
  const label = classify(delta, threshold, polarity);
  return { fixtureId, metric, polarity, baseline, variant, delta, threshold, label };
}

/**
 * Apply the no-effect rule, then the polarity rule.
 *
 * No-effect rule: `Math.abs(delta) < threshold`. Strict `<` per the
 * implementation plan — when `|delta|` exactly equals the spread, the
 * row still rises to a winner. We add one degenerate carve-out: a
 * delta of exactly zero is always no-effect regardless of threshold,
 * because there is no direction to pick a winner from. This matters
 * for single-trial inputs where both spreads are zero.
 *
 * Polarity rule:
 *   - higher-is-better: positive delta -> variant wins; negative -> baseline wins.
 *   - lower-is-better:  positive delta -> baseline wins; negative -> variant wins.
 *   - neutral:          movement gets `changed`; no winner is implied.
 */
function classify(delta: number, threshold: number, polarity: Polarity): ComparisonLabel {
  if (delta === 0) return 'no-effect';
  if (Math.abs(delta) < threshold) return 'no-effect';
  if (polarity === 'neutral') return 'changed';
  if (polarity === 'higher-is-better') {
    return delta > 0 ? 'winner-variant' : 'winner-baseline';
  }
  // lower-is-better
  return delta > 0 ? 'winner-baseline' : 'winner-variant';
}

function byFixtureId(tables: readonly MetricsTable[]): Map<string, MetricsTable> {
  const out = new Map<string, MetricsTable>();
  for (const t of tables) {
    // First-seen wins. Duplicate fixture ids in one input are unusual
    // but not the comparator's problem to surface.
    if (!out.has(t.fixtureId)) out.set(t.fixtureId, t);
  }
  return out;
}

function readStat(table: MetricsTable, metric: ComparisonMetricName): AggregateStat {
  switch (metric) {
    case 'taskSuccessRate':
      return table.aggregate.taskSuccessRate;
    case 'wallClockMs':
      return table.aggregate.wallClockMs;
    case 'promptTokens':
      return table.aggregate.promptTokens;
    case 'completionTokens':
      return table.aggregate.completionTokens;
    case 'toolCallCount.total':
      return table.aggregate.toolCallCount.total;
    case 'toolCallCount.reads':
      return table.aggregate.toolCallCount.reads;
    case 'toolCallCount.mutations':
      return table.aggregate.toolCallCount.mutations;
    case 'turnCount':
      return table.aggregate.turnCount;
    case 'peakContextWindowBytes':
      return table.aggregate.peakContextWindowBytes;
    case 'truthfulnessViolationRate':
      return table.aggregate.truthfulnessViolationRate;
    case 'dispatchVsLlmRatio':
      return table.aggregate.dispatchVsLlmRatio;
  }
}

// ---------- renderers ----------

/**
 * Render a `ComparisonReport` as plain JSON.
 *
 * Implementation is `JSON.stringify(report, null, 2)`. The report is
 * pure data: no functions, no `undefined` in places where the
 * renderer cares (numeric fields surface as `null` after a round-trip
 * but the consumer treats `null` and missing the same way).
 */
export function renderJson(report: ComparisonReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Render a `ComparisonReport` as a markdown document.
 *
 * One section per fixture. Each section has a header with the
 * fixture id and its coverage status, then a table with seven
 * columns: metric, baseline (mean +/- spread), variant (mean +/-
 * spread), delta, threshold, polarity, label.
 *
 * Numeric formatting:
 *   - mean / spread use up to four significant digits;
 *   - `undefined` renders as `-`;
 *   - delta and threshold use the same formatter as mean.
 */
export function renderMarkdown(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push(`# Comparison: ${report.baselineName} vs ${report.variantName}`);
  lines.push('');

  if (report.fixtures.length === 0) {
    lines.push('_No fixtures in either input._');
    return lines.join('\n');
  }

  for (const fixture of report.fixtures) {
    lines.push(`## ${fixture.fixtureId}`);
    if (fixture.status === 'baseline-only') {
      lines.push('');
      lines.push(`_Present in ${report.baselineName} only — no comparison rows._`);
      lines.push('');
      continue;
    }
    if (fixture.status === 'variant-only') {
      lines.push('');
      lines.push(`_Present in ${report.variantName} only — no comparison rows._`);
      lines.push('');
      continue;
    }
    lines.push('');
    lines.push(
      `| metric | ${report.baselineName} | ${report.variantName} | delta | threshold | polarity | label |`,
    );
    lines.push('|---|---|---|---|---|---|---|');
    for (const row of fixture.rows) {
      const cells = [
        row.metric,
        formatStat(row.baseline),
        formatStat(row.variant),
        formatNumber(row.delta),
        formatNumber(row.threshold),
        row.polarity,
        row.label,
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function formatStat(stat: AggregateStat): string {
  if (stat.mean === undefined || stat.stdDev === undefined) return '-';
  return `${formatNumber(stat.mean)} ± ${formatNumber(stat.stdDev)} (n=${stat.count})`;
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return '-';
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(2);
  // Small numbers: four significant digits keeps spreads readable.
  return value.toPrecision(4);
}
