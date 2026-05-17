import { describe, expect, test } from 'bun:test';
import { type TraceEvent, turnTimingTable } from '../../src/index.js';

function llmRequest(opts: {
  turnId: string;
  iteration: number;
  ts: number;
  requestId?: string;
}): TraceEvent {
  const requestId = opts.requestId ?? `${opts.turnId}#${opts.iteration}`;
  return {
    kind: 'llm_request',
    data: {
      requestId,
      turnId: opts.turnId,
      iteration: opts.iteration,
      ts: opts.ts,
      systemPrompt: '',
      messages: [],
      tools: [],
      llm: { id: 'fake', supportsTools: true },
    },
  };
}

function llmResponse(opts: { requestId: string; ts: number }): TraceEvent {
  return {
    kind: 'llm_response',
    data: {
      requestId: opts.requestId,
      ts: opts.ts,
      text: '',
      thinking: '',
      toolCalls: [],
    },
  };
}

function turnDispatchComplete(opts: {
  turnId: string;
  iteration: number;
  ts: number;
  toolCallCount?: number;
  requestId?: string;
}): TraceEvent {
  const requestId = opts.requestId ?? `${opts.turnId}#${opts.iteration}`;
  return {
    kind: 'turn_dispatch_complete',
    data: {
      requestId,
      turnId: opts.turnId,
      iteration: opts.iteration,
      ts: opts.ts,
      toolCallCount: opts.toolCallCount ?? 1,
    },
  };
}

describe('turnTimingTable', () => {
  test('empty trace yields an empty table', () => {
    expect(turnTimingTable([])).toEqual([]);
  });

  test('well-formed single iteration yields llmMs, dispatchMs, totalMs', () => {
    const events: TraceEvent[] = [
      llmRequest({ turnId: 't1', iteration: 0, ts: 1000 }),
      llmResponse({ requestId: 't1#0', ts: 1400 }),
      turnDispatchComplete({ turnId: 't1', iteration: 0, ts: 1700 }),
    ];
    const rows = turnTimingTable(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      turnId: 't1',
      iteration: 0,
      requestId: 't1#0',
      llmMs: 400,
      dispatchMs: 300,
      totalMs: 700,
    });
  });

  test('trace missing the dispatch event yields llmMs but undefined dispatchMs and totalMs', () => {
    // Models the final assistant turn: no tool calls, so the strategy
    // does not emit `turn_dispatch_complete`.
    const events: TraceEvent[] = [
      llmRequest({ turnId: 't1', iteration: 0, ts: 1000 }),
      llmResponse({ requestId: 't1#0', ts: 1500 }),
    ];
    const rows = turnTimingTable(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      turnId: 't1',
      iteration: 0,
      requestId: 't1#0',
      llmMs: 500,
      dispatchMs: undefined,
      totalMs: undefined,
    });
  });

  test('trace missing the response event yields undefined llmMs but undefined dispatchMs too', () => {
    // Models a mid-stream LLM error: the strategy returns before
    // emitting `llm_response`, and never reaches dispatch either.
    const events: TraceEvent[] = [llmRequest({ turnId: 't1', iteration: 0, ts: 1000 })];
    const rows = turnTimingTable(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      turnId: 't1',
      iteration: 0,
      requestId: 't1#0',
      llmMs: undefined,
      dispatchMs: undefined,
      totalMs: undefined,
    });
  });

  test('multi-iteration turn produces one row per iteration in order', () => {
    const events: TraceEvent[] = [
      llmRequest({ turnId: 't1', iteration: 0, ts: 1000 }),
      llmResponse({ requestId: 't1#0', ts: 1200 }),
      turnDispatchComplete({ turnId: 't1', iteration: 0, ts: 1300, toolCallCount: 2 }),
      llmRequest({ turnId: 't1', iteration: 1, ts: 1400 }),
      llmResponse({ requestId: 't1#1', ts: 1700 }),
      turnDispatchComplete({ turnId: 't1', iteration: 1, ts: 1900 }),
      llmRequest({ turnId: 't1', iteration: 2, ts: 2000 }),
      llmResponse({ requestId: 't1#2', ts: 2400 }),
      // No dispatch for the final iteration — final assistant turn.
    ];
    const rows = turnTimingTable(events);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.iteration)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.turnId)).toEqual(['t1', 't1', 't1']);
    expect(rows[0]).toEqual({
      turnId: 't1',
      iteration: 0,
      requestId: 't1#0',
      llmMs: 200,
      dispatchMs: 100,
      totalMs: 300,
    });
    expect(rows[1]).toEqual({
      turnId: 't1',
      iteration: 1,
      requestId: 't1#1',
      llmMs: 300,
      dispatchMs: 200,
      totalMs: 500,
    });
    expect(rows[2]).toEqual({
      turnId: 't1',
      iteration: 2,
      requestId: 't1#2',
      llmMs: 400,
      dispatchMs: undefined,
      totalMs: undefined,
    });
  });

  test('multi-turn trace keeps iteration indices per requestId', () => {
    const events: TraceEvent[] = [
      llmRequest({ turnId: 'tA', iteration: 0, ts: 1000 }),
      llmResponse({ requestId: 'tA#0', ts: 1100 }),
      turnDispatchComplete({ turnId: 'tA', iteration: 0, ts: 1200 }),
      llmRequest({ turnId: 'tB', iteration: 0, ts: 2000 }),
      llmResponse({ requestId: 'tB#0', ts: 2400 }),
    ];
    const rows = turnTimingTable(events);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.turnId).toBe('tA');
    expect(rows[1]?.turnId).toBe('tB');
    expect(rows[0]?.totalMs).toBe(200);
    expect(rows[1]?.totalMs).toBeUndefined();
    expect(rows[1]?.llmMs).toBe(400);
  });

  test('events arriving out of insertion order still pair by requestId', () => {
    // Trace consumers may store events in any order; the helper must
    // pair by requestId regardless.
    const events: TraceEvent[] = [
      turnDispatchComplete({ turnId: 't1', iteration: 0, ts: 1700 }),
      llmResponse({ requestId: 't1#0', ts: 1400 }),
      llmRequest({ turnId: 't1', iteration: 0, ts: 1000 }),
    ];
    const rows = turnTimingTable(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      turnId: 't1',
      iteration: 0,
      requestId: 't1#0',
      llmMs: 400,
      dispatchMs: 300,
      totalMs: 700,
    });
  });
});
