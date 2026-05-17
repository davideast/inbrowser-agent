/**
 * `collectMetrics` — the eval harness's metric extractor + aggregator.
 *
 * Bridges raw `RunRecord`s (the per-trial captures the runner produces)
 * and the comparison report. Given an array of records, an optional
 * parallel array of spec evaluations, and a tool registry to classify
 * tool calls, the collector returns one `MetricsTable` per fixture.
 * Each table carries:
 *
 *   - a row per trial (`TrialMetrics`) with the eight phase-one metrics,
 *   - one aggregated row (`AggregatedMetrics`) summarising mean and
 *     N-1 standard deviation across trials.
 *
 * The eight metrics are extracted exactly as the implementation plan
 * specifies:
 *
 *   1. `taskSuccess`        — pulled from the supplied `SpecResult.ok`.
 *   2. `wallClockMs`        — `completedAt - startedAt`.
 *   3. `promptTokens`       — sum of `usage.promptTokens` across all
 *                             `llm_response` events that carry usage.
 *   4. `completionTokens`   — sum of `usage.outputTokens` across the
 *                             same events.
 *   5. `toolCallCount`      — total tool calls across `llm_response`
 *                             events, split into `reads` vs
 *                             `mutations` by the `parallelSafe` tag.
 *                             Names not registered in the supplied
 *                             tool registry count as mutations.
 *   6. `turnCount`          — count of distinct `requestId`s in the
 *                             trace.
 *   7. `peakContextWindowBytes`     — max of `JSON.stringify(messages).length`
 *                                     across `llm_request` events.
 *   8. `truthfulnessViolationRate`  — `analyzeTruthfulness(trace).violationRate`.
 *   9. `dispatchVsLlmRatio` — sum of `dispatchMs` / sum of `llmMs`
 *                             across rows from `turnTimingTable(trace)`.
 *                             `undefined` when either total is zero.
 *
 * Numeric metrics with no data resolve to `undefined`, not `0`, so a
 * downstream consumer can distinguish "no data" from "really zero".
 *
 * Aggregation: mean is the arithmetic average across trials that have
 * a defined value for the metric; `undefined` when no trial has data.
 * Spread is the sample standard deviation (N-1 denominator). A single
 * defined value yields `stdDev: 0`. `taskSuccess` aggregates as a
 * success rate — booleans are cast to `0`/`1` before averaging.
 *
 * No comparison logic, no persistence. The comparison report is a
 * separate branch (`eval/comparison-report`).
 *
 * Browser-safe — no Node imports, no provider-specific code.
 *
 * Note on naming: there are two `RunRecord` types in this package.
 * This collector consumes the eval-harness one defined at
 * `./run-record.js`. The package root re-exports it as
 * `EvalRunRecord` so it does not collide with the unrelated
 * per-MCP-tool-call `RunRecord` at `../metrics/runs.js`.
 */

import { turnTimingTable } from '../diagnostics/timing.js';
import { analyzeTruthfulness } from '../diagnostics/truthfulness.js';
import { isParallelSafe } from '../tools.js';
import type { ToolHandler, ToolRegistry } from '../types/tools.js';
import type { TraceEvent } from '../types/trace.js';
import type { RunRecord } from './run-record.js';
import type { SpecResult } from './spec-framework.js';

/**
 * Per-trial metric row. One per `RunRecord` consumed. Numeric metrics
 * are `undefined` when the trial produced no data for them (e.g. no
 * `llm_response.usage` events → `promptTokens: undefined`). `taskSuccess`
 * is `undefined` when the caller passed no spec evaluation for the
 * trial.
 */
export interface TrialMetrics {
  /** Echoed from `record.fixture.id`. */
  fixtureId: string;
  /** Echoed from `record.trial`. */
  trial: number;
  /** Spec verdict for this trial. `undefined` when no evaluation was
   *  supplied or the supplied evaluation was `undefined`. */
  taskSuccess: boolean | undefined;
  /** `completedAt - startedAt` from the record. Always defined. */
  wallClockMs: number;
  /** Sum of `usage.promptTokens` across `llm_response` events that
   *  carry usage. `undefined` when no such event was emitted. */
  promptTokens: number | undefined;
  /** Sum of `usage.outputTokens` across `llm_response` events that
   *  carry usage. `undefined` when no such event was emitted. */
  completionTokens: number | undefined;
  /** Total tool calls + read/mutation split. `total` is `undefined`
   *  when no `llm_response` event carried any tool calls (a no-tool
   *  run is not the same as a run that emitted zero tool calls
   *  unintentionally — but at the extraction layer both look the
   *  same; downstream can decide). */
  toolCallCount: {
    total: number | undefined;
    reads: number | undefined;
    mutations: number | undefined;
  };
  /** Count of distinct `requestId` values across the trace.
   *  `undefined` when the trace contains no LLM events. */
  turnCount: number | undefined;
  /** Max of `JSON.stringify(messages).length` across the trace's
   *  `llm_request` events. `undefined` when no such event exists. */
  peakContextWindowBytes: number | undefined;
  /** `analyzeTruthfulness(trace).violationRate`. `undefined` when
   *  the trace contains no assistant turns (i.e. nothing to score). */
  truthfulnessViolationRate: number | undefined;
  /** Sum-of-dispatchMs divided by sum-of-llmMs across turn-timing
   *  rows. `undefined` when either sum is zero. */
  dispatchVsLlmRatio: number | undefined;
}

/**
 * Aggregate of one numeric column across the trials of a fixture.
 *
 * `mean` is the arithmetic average across trials that had a defined
 * value for the column. `stdDev` is the sample (N-1) standard
 * deviation across the same trials. Both fields are `undefined` when
 * no trial had data for the column. A single defined value yields
 * `mean` equal to that value and `stdDev: 0`.
 *
 * `count` reports how many trials contributed a defined value, which
 * a downstream report needs to weight or warn about thin samples.
 */
export interface AggregateStat {
  mean: number | undefined;
  stdDev: number | undefined;
  count: number;
}

/**
 * One row per fixture summarising mean + spread across its trials.
 * `taskSuccessRate` is the mean of booleans cast to `0`/`1`. The
 * remaining columns are sample-stat aggregates of the numeric trial
 * metrics. Read/mutation totals follow the same shape as their
 * per-trial counterpart.
 */
export interface AggregatedMetrics {
  /** Echoed from the fixture id. */
  fixtureId: string;
  /** Number of trials contributing to this row. */
  trials: number;
  taskSuccessRate: AggregateStat;
  wallClockMs: AggregateStat;
  promptTokens: AggregateStat;
  completionTokens: AggregateStat;
  toolCallCount: {
    total: AggregateStat;
    reads: AggregateStat;
    mutations: AggregateStat;
  };
  turnCount: AggregateStat;
  peakContextWindowBytes: AggregateStat;
  truthfulnessViolationRate: AggregateStat;
  dispatchVsLlmRatio: AggregateStat;
}

/**
 * One fixture's per-trial rows plus its aggregated row. The
 * comparison report consumes a pair of these (baseline vs variant)
 * and decides whether the variant moved the needle.
 */
export interface MetricsTable {
  fixtureId: string;
  trials: TrialMetrics[];
  aggregate: AggregatedMetrics;
}

/**
 * Input to `collectMetrics`. `evaluations` is positionally parallel
 * to `records` — index `i` of `evaluations` is the spec result for
 * `records[i]`. A missing entry (either the array is shorter or the
 * slot is `undefined`) leaves `taskSuccess` undefined for that trial.
 *
 * `toolRegistry` is consulted to classify each emitted tool call as a
 * read (parallel-safe) or a mutation (not parallel-safe). Tools whose
 * name is not registered count as mutations.
 */
export interface CollectMetricsInput {
  /** The per-trial captures from `runFixture` / `runFixtures`. Order
   *  is preserved in the returned tables. */
  records: readonly RunRecord[];
  /** Parallel to `records`. Optional. `undefined` slots and a shorter
   *  array both translate to `taskSuccess: undefined` on the row. */
  evaluations?: readonly (SpecResult | undefined)[];
  /** Source of truth for `parallelSafe` tags. The collector reads it
   *  via `registry.list()` once; the returned handlers are scanned by
   *  `name`. */
  toolRegistry: ToolRegistry;
}

/**
 * Compute one `MetricsTable` per fixture from a flat batch of
 * `RunRecord`s. Records are grouped by `fixture.id` in first-seen
 * order; within a group trials are kept in input order. The returned
 * array preserves fixture order from the input.
 *
 * `evaluations` (when supplied) is consumed positionally — index `i`
 * pairs with `records[i]`. A missing slot leaves the trial's
 * `taskSuccess` undefined.
 *
 * Never throws on missing data: every metric extractor degrades to
 * `undefined` rather than throwing. A malformed trace (e.g. an
 * `llm_response` with no `usage`) just contributes nothing to the
 * affected column.
 */
export function collectMetrics(input: CollectMetricsInput): MetricsTable[] {
  const { records, evaluations, toolRegistry } = input;
  const readNameSet = buildReadNameSet(toolRegistry);

  // First-seen fixture order. We keep an ordered list of ids alongside
  // a per-id bucket so the returned `MetricsTable[]` preserves the
  // caller's fixture ordering rather than relying on `Map` iteration
  // (which is insertion-ordered in v8 but explicit is clearer).
  const order: string[] = [];
  const buckets = new Map<string, TrialMetrics[]>();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const evaluation = evaluations?.[i];
    const trial = extractTrial(record, evaluation, readNameSet);
    const fixtureId = trial.fixtureId;
    let bucket = buckets.get(fixtureId);
    if (!bucket) {
      bucket = [];
      buckets.set(fixtureId, bucket);
      order.push(fixtureId);
    }
    bucket.push(trial);
  }

  const tables: MetricsTable[] = [];
  for (const fixtureId of order) {
    const trials = buckets.get(fixtureId);
    if (!trials || trials.length === 0) continue;
    tables.push({
      fixtureId,
      trials,
      aggregate: aggregateTrials(fixtureId, trials),
    });
  }
  return tables;
}

/**
 * Extract a single `TrialMetrics` row from a record + optional
 * evaluation. Exported for tests that want to exercise the eight
 * extractors against a hand-built record without going through the
 * fixture-grouping layer.
 */
export function extractTrialMetrics(
  record: RunRecord,
  evaluation: SpecResult | undefined,
  toolRegistry: ToolRegistry,
): TrialMetrics {
  return extractTrial(record, evaluation, buildReadNameSet(toolRegistry));
}

/**
 * Aggregate a list of `TrialMetrics` for a single fixture. Exported
 * for tests that want to exercise aggregation in isolation.
 */
export function aggregateTrials(
  fixtureId: string,
  trials: readonly TrialMetrics[],
): AggregatedMetrics {
  return {
    fixtureId,
    trials: trials.length,
    taskSuccessRate: aggregateSamples(
      trials.map((t) => (t.taskSuccess === undefined ? undefined : t.taskSuccess ? 1 : 0)),
    ),
    wallClockMs: aggregateSamples(trials.map((t) => t.wallClockMs)),
    promptTokens: aggregateSamples(trials.map((t) => t.promptTokens)),
    completionTokens: aggregateSamples(trials.map((t) => t.completionTokens)),
    toolCallCount: {
      total: aggregateSamples(trials.map((t) => t.toolCallCount.total)),
      reads: aggregateSamples(trials.map((t) => t.toolCallCount.reads)),
      mutations: aggregateSamples(trials.map((t) => t.toolCallCount.mutations)),
    },
    turnCount: aggregateSamples(trials.map((t) => t.turnCount)),
    peakContextWindowBytes: aggregateSamples(trials.map((t) => t.peakContextWindowBytes)),
    truthfulnessViolationRate: aggregateSamples(trials.map((t) => t.truthfulnessViolationRate)),
    dispatchVsLlmRatio: aggregateSamples(trials.map((t) => t.dispatchVsLlmRatio)),
  };
}

// ---------- internals ----------

function extractTrial(
  record: RunRecord,
  evaluation: SpecResult | undefined,
  readNameSet: ReadonlySet<string>,
): TrialMetrics {
  const trace = record.trace;
  const tokens = sumTokens(trace);
  const toolCalls = countToolCalls(trace, readNameSet);
  const turnCount = countDistinctRequestIds(trace);
  const peakContextWindowBytes = peakContextBytes(trace);
  const truthfulnessViolationRate = computeTruthfulness(trace);
  const dispatchVsLlmRatio = computeDispatchVsLlmRatio(trace);

  return {
    fixtureId: record.fixture.id,
    trial: record.trial,
    taskSuccess: evaluation === undefined ? undefined : evaluation.ok,
    wallClockMs: record.completedAt - record.startedAt,
    promptTokens: tokens.promptTokens,
    completionTokens: tokens.completionTokens,
    toolCallCount: toolCalls,
    turnCount,
    peakContextWindowBytes,
    truthfulnessViolationRate,
    dispatchVsLlmRatio,
  };
}

/** Build the set of registered tool names whose handler is
 *  `parallelSafe`. A name absent from this set is treated as a
 *  mutation (or unknown → mutation, per the brief). */
function buildReadNameSet(registry: ToolRegistry): ReadonlySet<string> {
  const reads = new Set<string>();
  const handlers: ToolHandler[] = registry.list();
  for (const h of handlers) {
    if (isParallelSafe(h)) reads.add(h.name);
  }
  return reads;
}

function sumTokens(trace: readonly TraceEvent[]): {
  promptTokens: number | undefined;
  completionTokens: number | undefined;
} {
  let prompt: number | undefined;
  let completion: number | undefined;
  for (const ev of trace) {
    if (ev.kind !== 'llm_response') continue;
    const usage = ev.data.usage;
    if (!usage) continue;
    prompt = (prompt ?? 0) + (usage.promptTokens ?? 0);
    completion = (completion ?? 0) + (usage.outputTokens ?? 0);
  }
  return { promptTokens: prompt, completionTokens: completion };
}

function countToolCalls(
  trace: readonly TraceEvent[],
  readNameSet: ReadonlySet<string>,
): TrialMetrics['toolCallCount'] {
  let total = 0;
  let reads = 0;
  let mutations = 0;
  let sawAny = false;
  for (const ev of trace) {
    if (ev.kind !== 'llm_response') continue;
    sawAny = true;
    for (const call of ev.data.toolCalls) {
      total += 1;
      if (readNameSet.has(call.name)) reads += 1;
      else mutations += 1;
    }
  }
  if (!sawAny) {
    // No `llm_response` events at all — undefined is the right signal
    // for "no data". Distinguishes a fully aborted trial from one
    // that simply emitted zero tool calls.
    return { total: undefined, reads: undefined, mutations: undefined };
  }
  return { total, reads, mutations };
}

function countDistinctRequestIds(trace: readonly TraceEvent[]): number | undefined {
  const ids = new Set<string>();
  for (const ev of trace) {
    if (
      ev.kind === 'llm_request' ||
      ev.kind === 'llm_response' ||
      ev.kind === 'turn_dispatch_complete'
    ) {
      ids.add(ev.data.requestId);
    }
  }
  return ids.size === 0 ? undefined : ids.size;
}

function peakContextBytes(trace: readonly TraceEvent[]): number | undefined {
  let peak: number | undefined;
  for (const ev of trace) {
    if (ev.kind !== 'llm_request') continue;
    const bytes = JSON.stringify(ev.data.messages).length;
    if (peak === undefined || bytes > peak) peak = bytes;
  }
  return peak;
}

function computeTruthfulness(trace: readonly TraceEvent[]): number | undefined {
  // `analyzeTruthfulness` returns `violationRate: 0` when there are
  // zero assistant turns to score. The brief says "no data → undefined,
  // not zero", so we surface undefined in that degenerate case.
  const report = analyzeTruthfulness(trace);
  if (report.totalAssistantTurns === 0) return undefined;
  return report.violationRate;
}

function computeDispatchVsLlmRatio(trace: readonly TraceEvent[]): number | undefined {
  const rows = turnTimingTable(trace);
  let llmSum = 0;
  let dispatchSum = 0;
  for (const row of rows) {
    if (typeof row.llmMs === 'number') llmSum += row.llmMs;
    if (typeof row.dispatchMs === 'number') dispatchSum += row.dispatchMs;
  }
  if (llmSum === 0 || dispatchSum === 0) return undefined;
  return dispatchSum / llmSum;
}

/**
 * Aggregate an array of optional samples. Returns `mean` and `stdDev`
 * across the defined entries. Sample standard deviation uses an N-1
 * denominator; a single defined sample yields `stdDev: 0`. When zero
 * samples are defined, both `mean` and `stdDev` are `undefined`.
 */
function aggregateSamples(samples: readonly (number | undefined)[]): AggregateStat {
  const defined: number[] = [];
  for (const s of samples) {
    if (typeof s === 'number' && Number.isFinite(s)) defined.push(s);
  }
  const count = defined.length;
  if (count === 0) return { mean: undefined, stdDev: undefined, count: 0 };
  let sum = 0;
  for (const v of defined) sum += v;
  const mean = sum / count;
  if (count === 1) return { mean, stdDev: 0, count };
  let sqSum = 0;
  for (const v of defined) {
    const d = v - mean;
    sqSum += d * d;
  }
  // N-1 denominator. Guaranteed `count >= 2` here.
  const stdDev = Math.sqrt(sqSum / (count - 1));
  return { mean, stdDev, count };
}
