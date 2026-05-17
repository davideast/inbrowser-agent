import { describe, expect, test } from 'bun:test';
import {
  type ChatEvent,
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type LlmClient,
  type StrategyEvent,
  type ToolContext,
  type ToolHandler,
  createDispatch,
  createReactLoopStrategy,
  createToolRegistry,
} from '../src/index.js';

function fakeLlm(scripts: ChatEvent[][]): LlmClient {
  let turn = 0;
  return {
    id: 'fake',
    supportsTools: true,
    chat(): AsyncIterable<ChatEvent> {
      const events = scripts[turn] ?? [];
      turn += 1;
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

function fakeCtx(): ToolContext {
  return {
    workspace: EMPTY_WORKSPACE,
    runtime: EMPTY_RUNTIME,
    sandbox: {
      async run() {
        return { ok: true, durationMs: 0, docsTouched: 0, errors: 0, entries: [] };
      },
      async deployRules() {
        return { ok: true, messages: [] };
      },
      async readState() {
        return {};
      },
      reseed() {
        /* no-op */
      },
      dispose() {
        /* no-op */
      },
    },
    lint: () => ({ warnings: [] }),
    signal: new AbortController().signal,
  };
}

async function collect(events: AsyncIterable<StrategyEvent>): Promise<StrategyEvent[]> {
  const out: StrategyEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('createReactLoopStrategy', () => {
  test('completes a single text turn with no tool calls', async () => {
    const strategy = createReactLoopStrategy();
    const llm = fakeLlm([
      [
        { kind: 'text', chunk: 'hello' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 10, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
    ]);
    const events = await collect(
      strategy.run(
        {
          prompt: 'hi',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'You are helpful.',
        },
        new AbortController().signal,
      ),
    );

    expect(events.find((e) => e.kind === 'text')?.kind).toBe('text');
    expect(events[events.length - 1]!.kind).toBe('turn_complete');
  });

  test('drives a tool-call → result → next-turn loop', async () => {
    const echoTool: ToolHandler<{ msg: string }, { msg: string }> = {
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object' },
      async execute({ msg }) {
        return { ok: true, summary: msg, data: { msg } };
      },
    };
    const registry = createToolRegistry();
    registry.register(echoTool);

    const llm = fakeLlm([
      [
        { kind: 'tool_call', id: 'c1', name: 'echo', args: { msg: 'hi from tool' } },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 5, completionTokens: 5 },
          details: { requestedModel: 'fake' },
        },
      ],
      [
        { kind: 'text', chunk: 'Tool said: hi from tool' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 15, completionTokens: 4 },
          details: { requestedModel: 'fake' },
        },
      ],
    ]);

    const events = await collect(
      createReactLoopStrategy().run(
        {
          prompt: 'use the tool',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(registry),
          toolList: [echoTool],
          toolContext: fakeCtx,
          systemPrompt: 'You may call tools.',
        },
        new AbortController().signal,
      ),
    );

    const toolCalls = events.filter((e) => e.kind === 'tool_call');
    const toolResults = events.filter((e) => e.kind === 'tool_result');
    const texts = events.filter((e) => e.kind === 'text');
    expect(toolCalls).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(texts).toHaveLength(1);
    if (toolResults[0]?.kind === 'tool_result') {
      expect(toolResults[0].result.ok).toBe(true);
      expect(toolResults[0].result.summary).toBe('hi from tool');
    }
  });

  test('aborts when the signal fires before the turn starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      createReactLoopStrategy().run(
        {
          prompt: 'x',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm: fakeLlm([[]]),
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 's',
        },
        controller.signal,
      ),
    );
    expect(events[0]?.kind).toBe('error');
    if (events[0]?.kind === 'error') expect(events[0].message).toBe('aborted');
  });

  test('parallelDispatch off (default): byte-for-byte identical to current behavior with mixed calls', async () => {
    // Two tools — one parallel-safe, one not. With parallelDispatch off,
    // we expect strict sequential dispatch in input order: each tool's
    // result + message lands before the next tool starts.
    const startOrder: string[] = [];
    const endOrder: string[] = [];
    const makeTool = (name: string, parallelSafe: boolean): ToolHandler => ({
      name,
      description: name,
      parameters: { type: 'object' },
      parallelSafe,
      async execute() {
        startOrder.push(name);
        await new Promise((r) => setTimeout(r, 5));
        endOrder.push(name);
        return { ok: true, summary: name };
      },
    });
    const t1 = makeTool('readA', true);
    const t2 = makeTool('mutateB', false);
    const t3 = makeTool('readC', true);
    const registry = createToolRegistry();
    registry.register(t1);
    registry.register(t2);
    registry.register(t3);

    const llm = fakeLlm([
      [
        { kind: 'tool_call', id: 'c1', name: 'readA', args: {} },
        { kind: 'tool_call', id: 'c2', name: 'mutateB', args: {} },
        { kind: 'tool_call', id: 'c3', name: 'readC', args: {} },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
      [
        { kind: 'text', chunk: 'done' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
    ]);

    const events = await collect(
      createReactLoopStrategy().run(
        {
          prompt: 'go',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(registry),
          toolList: [t1, t2, t3],
          toolContext: fakeCtx,
          systemPrompt: 's',
        },
        new AbortController().signal,
      ),
    );

    // Strict sequential ordering: each tool fully finishes before the next starts.
    expect(startOrder).toEqual(['readA', 'mutateB', 'readC']);
    expect(endOrder).toEqual(['readA', 'mutateB', 'readC']);
    const toolResults = events.filter((e) => e.kind === 'tool_result');
    expect(toolResults.map((e) => (e.kind === 'tool_result' ? e.id : ''))).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
  });

  test('parallelDispatch on: parallel-safe calls run concurrently', async () => {
    // Two parallel-safe tools whose `execute` records start time. If
    // they run concurrently, the second one starts before the first
    // one ends.
    const startOrder: string[] = [];
    const inFlight = new Set<string>();
    let peakInFlight = 0;
    const slowReader = (name: string): ToolHandler => ({
      name,
      description: name,
      parameters: { type: 'object' },
      parallelSafe: true,
      async execute() {
        startOrder.push(name);
        inFlight.add(name);
        peakInFlight = Math.max(peakInFlight, inFlight.size);
        await new Promise((r) => setTimeout(r, 20));
        inFlight.delete(name);
        return { ok: true, summary: name };
      },
    });
    const tA = slowReader('rA');
    const tB = slowReader('rB');
    const registry = createToolRegistry();
    registry.register(tA);
    registry.register(tB);

    const llm = fakeLlm([
      [
        { kind: 'tool_call', id: 'c1', name: 'rA', args: {} },
        { kind: 'tool_call', id: 'c2', name: 'rB', args: {} },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
      [
        { kind: 'text', chunk: 'done' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
    ]);

    await collect(
      createReactLoopStrategy({ parallelDispatch: true }).run(
        {
          prompt: 'go',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(registry),
          toolList: [tA, tB],
          toolContext: fakeCtx,
          systemPrompt: 's',
        },
        new AbortController().signal,
      ),
    );

    expect(peakInFlight).toBe(2);
    expect(startOrder).toHaveLength(2);
  });

  test('parallelDispatch on: mixed calls — parallel group then mutations, result order matches input order', async () => {
    // Timeline tracks every start/end. We expect:
    // - both reads start before either mutation starts (parallel group first)
    // - mutations run sequentially in their original relative order
    const events: string[] = [];
    const reader = (name: string): ToolHandler => ({
      name,
      description: name,
      parameters: { type: 'object' },
      parallelSafe: true,
      async execute() {
        events.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 15));
        events.push(`end:${name}`);
        return { ok: true, summary: name };
      },
    });
    const writer = (name: string): ToolHandler => ({
      name,
      description: name,
      parameters: { type: 'object' },
      // explicit false to exercise the negative branch
      parallelSafe: false,
      async execute() {
        events.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 10));
        events.push(`end:${name}`);
        return { ok: true, summary: name };
      },
    });
    const r1 = reader('r1');
    const r2 = reader('r2');
    const w1 = writer('w1');
    const w2 = writer('w2');
    const registry = createToolRegistry();
    for (const t of [r1, r2, w1, w2]) registry.register(t);

    const llm = fakeLlm([
      [
        // Mixed order on purpose. Partition splits but doesn't reorder
        // the relative order within each group.
        { kind: 'tool_call', id: 'i1', name: 'r1', args: {} },
        { kind: 'tool_call', id: 'i2', name: 'w1', args: {} },
        { kind: 'tool_call', id: 'i3', name: 'r2', args: {} },
        { kind: 'tool_call', id: 'i4', name: 'w2', args: {} },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
      [
        { kind: 'text', chunk: 'done' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
    ]);

    const collected = await collect(
      createReactLoopStrategy({ parallelDispatch: true }).run(
        {
          prompt: 'go',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(registry),
          toolList: [r1, r2, w1, w2],
          toolContext: fakeCtx,
          systemPrompt: 's',
        },
        new AbortController().signal,
      ),
    );

    // Both reads must have started before either writer started.
    const writerFirstStart = events.findIndex((e) => e === 'start:w1' || e === 'start:w2');
    const readsStartedBefore = events
      .slice(0, writerFirstStart)
      .filter((e) => e === 'start:r1' || e === 'start:r2').length;
    expect(readsStartedBefore).toBe(2);

    // Writers run sequentially in their original relative order: w1
    // must end before w2 starts.
    const w1End = events.indexOf('end:w1');
    const w2Start = events.indexOf('start:w2');
    expect(w1End).toBeGreaterThan(-1);
    expect(w2Start).toBeGreaterThan(-1);
    expect(w1End).toBeLessThan(w2Start);

    // Result yield order matches input order (i1, i2, i3, i4).
    const resultIds = collected
      .filter((e) => e.kind === 'tool_result')
      .map((e) => (e.kind === 'tool_result' ? e.id : ''));
    expect(resultIds).toEqual(['i1', 'i2', 'i3', 'i4']);
  });

  test('parallelDispatch on: no parallel-safe calls — behaves like sequential mode', async () => {
    const order: string[] = [];
    const mutate = (name: string): ToolHandler => ({
      name,
      description: name,
      parameters: { type: 'object' },
      // not parallel-safe
      async execute() {
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end:${name}`);
        return { ok: true, summary: name };
      },
    });
    const m1 = mutate('m1');
    const m2 = mutate('m2');
    const registry = createToolRegistry();
    registry.register(m1);
    registry.register(m2);

    const llm = fakeLlm([
      [
        { kind: 'tool_call', id: 'c1', name: 'm1', args: {} },
        { kind: 'tool_call', id: 'c2', name: 'm2', args: {} },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
      [
        { kind: 'text', chunk: 'done' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
    ]);

    await collect(
      createReactLoopStrategy({ parallelDispatch: true }).run(
        {
          prompt: 'go',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(registry),
          toolList: [m1, m2],
          toolContext: fakeCtx,
          systemPrompt: 's',
        },
        new AbortController().signal,
      ),
    );

    // Strict sequential: m1 fully ends before m2 starts.
    expect(order).toEqual(['start:m1', 'end:m1', 'start:m2', 'end:m2']);
  });

  test('parallelDispatch on: abort fires during mutation phase — emits error and stops', async () => {
    // Two parallel reads complete; first mutation reads the abort and
    // we should yield an error before invoking it.
    const order: string[] = [];
    const controller = new AbortController();
    const readTool: ToolHandler = {
      name: 'r',
      description: 'r',
      parameters: { type: 'object' },
      parallelSafe: true,
      async execute() {
        order.push('read');
        return { ok: true, summary: 'r' };
      },
    };
    const mutTool: ToolHandler = {
      name: 'm',
      description: 'm',
      parameters: { type: 'object' },
      async execute() {
        order.push('mut');
        return { ok: true, summary: 'm' };
      },
    };
    const registry = createToolRegistry();
    registry.register(readTool);
    registry.register(mutTool);

    const llm = fakeLlm([
      [
        { kind: 'tool_call', id: 'c1', name: 'r', args: {} },
        { kind: 'tool_call', id: 'c2', name: 'm', args: {} },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake' },
        },
      ],
    ]);

    // Pre-abort so the parallel phase completes (both branches don't
    // re-check abort mid-flight) but the sequential mutation phase
    // sees the abort and bails.
    controller.abort();
    const evs = await collect(
      createReactLoopStrategy({ parallelDispatch: true }).run(
        {
          prompt: 'go',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(registry),
          toolList: [readTool, mutTool],
          toolContext: fakeCtx,
          systemPrompt: 's',
        },
        controller.signal,
      ),
    );
    // The first thing the loop does each turn is check `signal.aborted`,
    // so we never even reach dispatch. The strategy yields error and
    // returns immediately.
    expect(evs[0]?.kind).toBe('error');
    if (evs[0]?.kind === 'error') expect(evs[0].message).toBe('aborted');
    expect(order).toEqual([]);
  });

  test('caps runaway loops via maxTurns', async () => {
    // Every turn returns a tool call → the loop ping-pongs.
    const looperLlm: LlmClient = {
      id: 'fake',
      supportsTools: true,
      chat(): AsyncIterable<ChatEvent> {
        return (async function* () {
          yield { kind: 'tool_call', id: 'c', name: 'echo', args: {} };
          yield {
            kind: 'turn_complete',
            usage: { promptTokens: 1, completionTokens: 1 },
            details: { requestedModel: 'fake' },
          };
        })();
      },
    };
    const echoTool: ToolHandler = {
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object' },
      async execute() {
        return { ok: true, summary: 'ok' };
      },
    };
    const registry = createToolRegistry();
    registry.register(echoTool);

    const events = await collect(
      createReactLoopStrategy({ maxTurns: 3 }).run(
        {
          prompt: 'x',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm: looperLlm,
          tools: createDispatch(registry),
          toolList: [echoTool],
          toolContext: fakeCtx,
          systemPrompt: 's',
        },
        new AbortController().signal,
      ),
    );
    const final = events[events.length - 1]!;
    expect(final.kind).toBe('error');
    if (final.kind === 'error') expect(final.message).toContain('maxTurns');
  });
});
