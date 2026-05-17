import { describe, expect, test } from 'bun:test';
import type { RunRecord } from '../../src/eval/run-record.js';
import {
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type SpecResult,
  type TaskFixture,
  type ToolHandler,
  type TraceEvent,
  aggregateTrials,
  collectMetrics,
  createToolRegistry,
  extractTrialMetrics,
} from '../../src/index.js';

// ---------- builders ----------

function makeFixture(id: string, overrides: Partial<TaskFixture> = {}): TaskFixture {
  return {
    id,
    skill: 'firestore-rules-audit',
    description: `fixture ${id}`,
    prompt: 'go',
    successSpec: { name: 'firestore-rules-audit/passes' },
    ...overrides,
  };
}

function makeRecord(overrides: Partial<RunRecord> & { fixtureId?: string }): RunRecord {
  const { fixtureId, ...rest } = overrides;
  return {
    fixture: makeFixture(fixtureId ?? 'firestore-rules-audit/case-a'),
    trial: 0,
    trace: [],
    finalWorkspace: EMPTY_WORKSPACE,
    finalRuntime: EMPTY_RUNTIME,
    assistantText: '',
    startedAt: 1_000,
    completedAt: 1_500,
    error: null,
    ...rest,
  };
}

function llmRequestEvent(
  requestId: string,
  turnId: string,
  iteration: number,
  ts: number,
  messages: unknown[] = [],
): TraceEvent {
  return {
    kind: 'llm_request',
    data: {
      requestId,
      turnId,
      iteration,
      ts,
      systemPrompt: '',
      messages: messages as never,
      tools: [],
      llm: { id: 'fake', supportsTools: true },
    },
  };
}

function llmResponseEvent(
  requestId: string,
  ts: number,
  options: {
    text?: string;
    toolCalls?: { id: string; name: string; args: unknown }[];
    usage?: { promptTokens: number; outputTokens: number };
  } = {},
): TraceEvent {
  return {
    kind: 'llm_response',
    data: {
      requestId,
      ts,
      text: options.text ?? '',
      thinking: '',
      toolCalls: options.toolCalls ?? [],
      ...(options.usage ? { usage: options.usage } : {}),
    },
  };
}

function turnDispatchCompleteEvent(
  requestId: string,
  turnId: string,
  iteration: number,
  ts: number,
  toolCallCount: number,
): TraceEvent {
  return {
    kind: 'turn_dispatch_complete',
    data: { requestId, turnId, iteration, ts, toolCallCount },
  };
}

function readTool(name: string): ToolHandler {
  return {
    name,
    description: name,
    parameters: { type: 'object' },
    parallelSafe: true,
    async execute() {
      return { ok: true, summary: '' };
    },
  };
}

function mutateTool(name: string): ToolHandler {
  return {
    name,
    description: name,
    parameters: { type: 'object' },
    async execute() {
      return { ok: true, summary: '' };
    },
  };
}

function makeRegistryWith(handlers: ToolHandler[]) {
  const registry = createToolRegistry();
  for (const h of handlers) registry.register(h);
  return registry;
}

// ---------- per-trial metric extractor tests ----------

describe('extractTrialMetrics — eight metrics', () => {
  const emptyRegistry = createToolRegistry();

  test('taskSuccess: undefined when no evaluation supplied; true/false from SpecResult.ok', () => {
    const record = makeRecord({});
    expect(extractTrialMetrics(record, undefined, emptyRegistry).taskSuccess).toBeUndefined();
    expect(extractTrialMetrics(record, { ok: true } as SpecResult, emptyRegistry).taskSuccess).toBe(
      true,
    );
    expect(
      extractTrialMetrics(record, { ok: false } as SpecResult, emptyRegistry).taskSuccess,
    ).toBe(false);
  });

  test('wallClockMs: completedAt - startedAt', () => {
    const record = makeRecord({ startedAt: 1_000, completedAt: 1_750 });
    expect(extractTrialMetrics(record, undefined, emptyRegistry).wallClockMs).toBe(750);
  });

  test('promptTokens / completionTokens: sum across llm_response.usage events', () => {
    const trace: TraceEvent[] = [
      llmResponseEvent('r1', 100, { usage: { promptTokens: 10, outputTokens: 4 } }),
      llmResponseEvent('r2', 200, { usage: { promptTokens: 7, outputTokens: 3 } }),
      // A response without usage contributes nothing.
      llmResponseEvent('r3', 300, {}),
    ];
    const trial = extractTrialMetrics(makeRecord({ trace }), undefined, emptyRegistry);
    expect(trial.promptTokens).toBe(17);
    expect(trial.completionTokens).toBe(7);
  });

  test('promptTokens / completionTokens: undefined when no usage was emitted', () => {
    const trace: TraceEvent[] = [llmResponseEvent('r1', 100, {})];
    const trial = extractTrialMetrics(makeRecord({ trace }), undefined, emptyRegistry);
    expect(trial.promptTokens).toBeUndefined();
    expect(trial.completionTokens).toBeUndefined();
  });

  test('toolCallCount: classifies reads (parallelSafe) vs mutations; unknown name → mutation', () => {
    const trace: TraceEvent[] = [
      llmResponseEvent('r1', 100, {
        toolCalls: [
          { id: 'c1', name: 'readPath', args: {} },
          { id: 'c2', name: 'readIndex', args: {} },
          { id: 'c3', name: 'writeRules', args: {} },
        ],
      }),
      llmResponseEvent('r2', 200, {
        toolCalls: [
          { id: 'c4', name: 'readPath', args: {} },
          // unregistered tool — counts as mutation per the brief.
          { id: 'c5', name: 'mystery', args: {} },
        ],
      }),
    ];
    const registry = makeRegistryWith([
      readTool('readPath'),
      readTool('readIndex'),
      mutateTool('writeRules'),
    ]);
    const trial = extractTrialMetrics(makeRecord({ trace }), undefined, registry);
    expect(trial.toolCallCount.total).toBe(5);
    expect(trial.toolCallCount.reads).toBe(3);
    expect(trial.toolCallCount.mutations).toBe(2);
  });

  test('toolCallCount: zero when responses carry no tool calls; undefined when no responses at all', () => {
    const withZero: TraceEvent[] = [llmResponseEvent('r1', 100)];
    const t1 = extractTrialMetrics(makeRecord({ trace: withZero }), undefined, emptyRegistry);
    expect(t1.toolCallCount.total).toBe(0);
    expect(t1.toolCallCount.reads).toBe(0);
    expect(t1.toolCallCount.mutations).toBe(0);

    const t2 = extractTrialMetrics(makeRecord({ trace: [] }), undefined, emptyRegistry);
    expect(t2.toolCallCount.total).toBeUndefined();
    expect(t2.toolCallCount.reads).toBeUndefined();
    expect(t2.toolCallCount.mutations).toBeUndefined();
  });

  test('turnCount: distinct requestIds across all event kinds; undefined for an empty trace', () => {
    const trace: TraceEvent[] = [
      llmRequestEvent('turn-1#0', 'turn-1', 0, 10),
      llmResponseEvent('turn-1#0', 50),
      turnDispatchCompleteEvent('turn-1#0', 'turn-1', 0, 80, 1),
      llmRequestEvent('turn-1#1', 'turn-1', 1, 100),
      llmResponseEvent('turn-1#1', 140),
    ];
    expect(extractTrialMetrics(makeRecord({ trace }), undefined, emptyRegistry).turnCount).toBe(2);

    expect(
      extractTrialMetrics(makeRecord({ trace: [] }), undefined, emptyRegistry).turnCount,
    ).toBeUndefined();
  });

  test('peakContextWindowBytes: max of JSON.stringify(messages).length across llm_request events', () => {
    const small = [{ role: 'user', text: 'hi' }];
    const big = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello there partner' },
    ];
    const trace: TraceEvent[] = [
      llmRequestEvent('turn-1#0', 'turn-1', 0, 10, small),
      llmRequestEvent('turn-1#1', 'turn-1', 1, 100, big),
    ];
    const expected = Math.max(JSON.stringify(small).length, JSON.stringify(big).length);
    const trial = extractTrialMetrics(makeRecord({ trace }), undefined, emptyRegistry);
    expect(trial.peakContextWindowBytes).toBe(expected);
  });

  test('peakContextWindowBytes: undefined when no llm_request event exists', () => {
    const trace: TraceEvent[] = [llmResponseEvent('r1', 100)];
    expect(
      extractTrialMetrics(makeRecord({ trace }), undefined, emptyRegistry).peakContextWindowBytes,
    ).toBeUndefined();
  });

  test('truthfulnessViolationRate: comes from analyzeTruthfulness; undefined when no assistant turn', () => {
    // No assistant text in any response → totalAssistantTurns is 0 → undefined.
    const traceNoText: TraceEvent[] = [
      llmRequestEvent('r1', 't1', 0, 10),
      llmResponseEvent('r1', 50, { text: '' }),
    ];
    expect(
      extractTrialMetrics(makeRecord({ trace: traceNoText }), undefined, emptyRegistry)
        .truthfulnessViolationRate,
    ).toBeUndefined();

    // An assistant response that quotes a fabricated identifier produces
    // a positive violation rate. We don't pin the value — just sanity
    // check that the wiring is live.
    const traceFlagged: TraceEvent[] = [
      llmRequestEvent('r1', 't1', 0, 10),
      llmResponseEvent('r1', 50, { text: 'See `not-in-corpus-anywhere`.' }),
    ];
    const trial = extractTrialMetrics(
      makeRecord({ trace: traceFlagged }),
      undefined,
      emptyRegistry,
    );
    expect(typeof trial.truthfulnessViolationRate).toBe('number');
    expect(trial.truthfulnessViolationRate ?? 0).toBeGreaterThan(0);
  });

  test('dispatchVsLlmRatio: sum(dispatchMs) / sum(llmMs); undefined when either total is zero', () => {
    // Turn 0: llmMs = 50, dispatchMs = 30. Turn 1: llmMs = 100, dispatchMs = 50.
    // Ratio = (30 + 50) / (50 + 100) = 80 / 150.
    const trace: TraceEvent[] = [
      llmRequestEvent('r0', 't1', 0, 0),
      llmResponseEvent('r0', 50),
      turnDispatchCompleteEvent('r0', 't1', 0, 80, 1),
      llmRequestEvent('r1', 't1', 1, 80),
      llmResponseEvent('r1', 180),
      turnDispatchCompleteEvent('r1', 't1', 1, 230, 1),
    ];
    const trial = extractTrialMetrics(makeRecord({ trace }), undefined, emptyRegistry);
    expect(trial.dispatchVsLlmRatio).toBeCloseTo(80 / 150, 10);

    // No dispatch events → dispatchSum is 0 → undefined.
    const traceNoDispatch: TraceEvent[] = [
      llmRequestEvent('r0', 't1', 0, 0),
      llmResponseEvent('r0', 50),
    ];
    expect(
      extractTrialMetrics(makeRecord({ trace: traceNoDispatch }), undefined, emptyRegistry)
        .dispatchVsLlmRatio,
    ).toBeUndefined();

    // No llm timings → llmSum is 0 → undefined.
    expect(
      extractTrialMetrics(makeRecord({ trace: [] }), undefined, emptyRegistry).dispatchVsLlmRatio,
    ).toBeUndefined();
  });

  test('missing data never throws — empty trace + no evaluation produces a row of undefineds', () => {
    const record = makeRecord({ trace: [], startedAt: 1_000, completedAt: 1_100 });
    const trial = extractTrialMetrics(record, undefined, emptyRegistry);
    expect(trial.fixtureId).toBe('firestore-rules-audit/case-a');
    expect(trial.trial).toBe(0);
    expect(trial.taskSuccess).toBeUndefined();
    expect(trial.wallClockMs).toBe(100);
    expect(trial.promptTokens).toBeUndefined();
    expect(trial.completionTokens).toBeUndefined();
    expect(trial.toolCallCount.total).toBeUndefined();
    expect(trial.turnCount).toBeUndefined();
    expect(trial.peakContextWindowBytes).toBeUndefined();
    expect(trial.truthfulnessViolationRate).toBeUndefined();
    expect(trial.dispatchVsLlmRatio).toBeUndefined();
  });
});

// ---------- aggregation tests ----------

describe('aggregateTrials', () => {
  test('single-trial spread is zero; mean is the trial value', () => {
    const trial = {
      fixtureId: 'fx/a',
      trial: 0,
      taskSuccess: true,
      wallClockMs: 500,
      promptTokens: 10,
      completionTokens: 4,
      toolCallCount: { total: 2, reads: 1, mutations: 1 },
      turnCount: 2,
      peakContextWindowBytes: 128,
      truthfulnessViolationRate: 0,
      dispatchVsLlmRatio: 0.5,
    };
    const agg = aggregateTrials('fx/a', [trial]);
    expect(agg.trials).toBe(1);
    expect(agg.wallClockMs).toEqual({ mean: 500, stdDev: 0, count: 1 });
    expect(agg.taskSuccessRate).toEqual({ mean: 1, stdDev: 0, count: 1 });
    expect(agg.promptTokens).toEqual({ mean: 10, stdDev: 0, count: 1 });
    expect(agg.toolCallCount.reads).toEqual({ mean: 1, stdDev: 0, count: 1 });
    expect(agg.dispatchVsLlmRatio).toEqual({ mean: 0.5, stdDev: 0, count: 1 });
  });

  test('three-trial mean + N-1 standard deviation when values differ', () => {
    const mk = (i: number, wallClockMs: number, success: boolean) => ({
      fixtureId: 'fx/a',
      trial: i,
      taskSuccess: success,
      wallClockMs,
      promptTokens: undefined,
      completionTokens: undefined,
      toolCallCount: { total: undefined, reads: undefined, mutations: undefined },
      turnCount: undefined,
      peakContextWindowBytes: undefined,
      truthfulnessViolationRate: undefined,
      dispatchVsLlmRatio: undefined,
    });
    const agg = aggregateTrials('fx/a', [mk(0, 100, true), mk(1, 200, false), mk(2, 300, true)]);
    // mean = 200; sample variance = ((100)^2 + 0 + (100)^2) / 2 = 10000;
    // stdDev = 100.
    expect(agg.wallClockMs.mean).toBe(200);
    expect(agg.wallClockMs.stdDev).toBeCloseTo(100, 10);
    expect(agg.wallClockMs.count).toBe(3);
    // taskSuccessRate: 2/3 successes; values are [1, 0, 1], mean = 2/3,
    // stdDev (N-1) = sqrt(((1/3)^2 + (2/3)^2 + (1/3)^2) / 2)
    //              = sqrt((1/9 + 4/9 + 1/9) / 2) = sqrt(6/18) = sqrt(1/3).
    expect(agg.taskSuccessRate.mean).toBeCloseTo(2 / 3, 10);
    expect(agg.taskSuccessRate.stdDev).toBeCloseTo(Math.sqrt(1 / 3), 10);
    expect(agg.taskSuccessRate.count).toBe(3);
    // Columns with no defined values stay undefined.
    expect(agg.promptTokens).toEqual({ mean: undefined, stdDev: undefined, count: 0 });
  });

  test('mixed defined / undefined samples are aggregated over the defined slice only', () => {
    const mk = (i: number, tokens: number | undefined) => ({
      fixtureId: 'fx/a',
      trial: i,
      taskSuccess: undefined,
      wallClockMs: 0,
      promptTokens: tokens,
      completionTokens: undefined,
      toolCallCount: { total: undefined, reads: undefined, mutations: undefined },
      turnCount: undefined,
      peakContextWindowBytes: undefined,
      truthfulnessViolationRate: undefined,
      dispatchVsLlmRatio: undefined,
    });
    const agg = aggregateTrials('fx/a', [mk(0, 10), mk(1, undefined), mk(2, 20)]);
    expect(agg.promptTokens.mean).toBe(15);
    expect(agg.promptTokens.count).toBe(2);
    // Two defined samples, N-1 stddev = sqrt(((10-15)^2 + (20-15)^2) / 1)
    //                                = sqrt((25 + 25) / 1) = sqrt(50).
    expect(agg.promptTokens.stdDev).toBeCloseTo(Math.sqrt(50), 10);
  });
});

// ---------- collectMetrics integration tests ----------

describe('collectMetrics', () => {
  test('groups records by fixtureId in first-seen order; preserves trial order within a group', () => {
    const records: RunRecord[] = [
      makeRecord({ fixtureId: 'fx/a', trial: 0, startedAt: 0, completedAt: 100 }),
      makeRecord({ fixtureId: 'fx/b', trial: 0, startedAt: 0, completedAt: 50 }),
      makeRecord({ fixtureId: 'fx/a', trial: 1, startedAt: 0, completedAt: 200 }),
      makeRecord({ fixtureId: 'fx/a', trial: 2, startedAt: 0, completedAt: 300 }),
      makeRecord({ fixtureId: 'fx/b', trial: 1, startedAt: 0, completedAt: 75 }),
    ];
    const tables = collectMetrics({ records, toolRegistry: createToolRegistry() });
    expect(tables.map((t) => t.fixtureId)).toEqual(['fx/a', 'fx/b']);

    const a = tables[0]!;
    expect(a.trials.map((t) => t.trial)).toEqual([0, 1, 2]);
    expect(a.trials.map((t) => t.wallClockMs)).toEqual([100, 200, 300]);
    expect(a.aggregate.wallClockMs.mean).toBeCloseTo(200, 10);
    expect(a.aggregate.wallClockMs.stdDev).toBeCloseTo(100, 10);

    const b = tables[1]!;
    expect(b.trials.map((t) => t.trial)).toEqual([0, 1]);
    expect(b.aggregate.wallClockMs.mean).toBe(62.5);
    expect(b.aggregate.wallClockMs.stdDev).toBeCloseTo(
      Math.sqrt(((50 - 62.5) ** 2 + (75 - 62.5) ** 2) / 1),
      10,
    );
  });

  test('threads evaluations positionally; missing slots leave taskSuccess undefined', () => {
    const records: RunRecord[] = [
      makeRecord({ fixtureId: 'fx/a', trial: 0 }),
      makeRecord({ fixtureId: 'fx/a', trial: 1 }),
      makeRecord({ fixtureId: 'fx/a', trial: 2 }),
    ];
    const evaluations: (SpecResult | undefined)[] = [{ ok: true }, undefined, { ok: false }];
    const [table] = collectMetrics({
      records,
      evaluations,
      toolRegistry: createToolRegistry(),
    });
    expect(table!.trials.map((t) => t.taskSuccess)).toEqual([true, undefined, false]);
    // taskSuccessRate mean of [1, 0] is 0.5 over the two defined samples.
    expect(table!.aggregate.taskSuccessRate.mean).toBe(0.5);
    expect(table!.aggregate.taskSuccessRate.count).toBe(2);
  });

  test('end-to-end: every metric extractor flows through collectMetrics', () => {
    const trace: TraceEvent[] = [
      llmRequestEvent('r0', 't1', 0, 0, [{ role: 'user', text: 'hi' }]),
      llmResponseEvent('r0', 50, {
        text: 'looking up',
        toolCalls: [
          { id: 'c1', name: 'readPath', args: {} },
          { id: 'c2', name: 'writeRules', args: {} },
        ],
        usage: { promptTokens: 12, outputTokens: 5 },
      }),
      turnDispatchCompleteEvent('r0', 't1', 0, 90, 2),
      llmRequestEvent('r1', 't1', 1, 90, [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'a longer assistant message here' },
      ]),
      llmResponseEvent('r1', 200, {
        text: 'done',
        usage: { promptTokens: 20, outputTokens: 8 },
      }),
    ];
    const records: RunRecord[] = [
      makeRecord({
        fixtureId: 'fx/end-to-end',
        trial: 0,
        trace,
        startedAt: 1_000,
        completedAt: 1_250,
      }),
    ];
    const registry = makeRegistryWith([readTool('readPath'), mutateTool('writeRules')]);
    const [table] = collectMetrics({
      records,
      evaluations: [{ ok: true }],
      toolRegistry: registry,
    });
    const trial = table!.trials[0]!;
    expect(trial.taskSuccess).toBe(true);
    expect(trial.wallClockMs).toBe(250);
    expect(trial.promptTokens).toBe(32);
    expect(trial.completionTokens).toBe(13);
    expect(trial.toolCallCount).toEqual({ total: 2, reads: 1, mutations: 1 });
    expect(trial.turnCount).toBe(2);
    expect(trial.peakContextWindowBytes).toBeGreaterThan(0);
    expect(typeof trial.truthfulnessViolationRate).toBe('number');
    expect(trial.dispatchVsLlmRatio).toBeCloseTo((90 - 50) / (50 - 0 + (200 - 90)), 10);
  });

  test('an aborted, empty-trace trial degrades gracefully', () => {
    const records: RunRecord[] = [
      makeRecord({
        fixtureId: 'fx/aborted',
        trial: 0,
        trace: [],
        error: 'runFixture: aborted',
        startedAt: 1_000,
        completedAt: 1_005,
      }),
    ];
    const tables = collectMetrics({ records, toolRegistry: createToolRegistry() });
    expect(tables).toHaveLength(1);
    const t = tables[0]!.trials[0]!;
    expect(t.wallClockMs).toBe(5);
    expect(t.promptTokens).toBeUndefined();
    expect(t.toolCallCount.total).toBeUndefined();
    expect(t.turnCount).toBeUndefined();
    expect(t.peakContextWindowBytes).toBeUndefined();
    expect(t.truthfulnessViolationRate).toBeUndefined();
    expect(t.dispatchVsLlmRatio).toBeUndefined();
    // Aggregation of one trial → spread is 0 on the defined column.
    expect(tables[0]!.aggregate.wallClockMs).toEqual({ mean: 5, stdDev: 0, count: 1 });
    // Aggregation of zero defined samples → undefined / undefined / 0.
    expect(tables[0]!.aggregate.promptTokens).toEqual({
      mean: undefined,
      stdDev: undefined,
      count: 0,
    });
  });
});
