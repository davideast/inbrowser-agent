/**
 * In-branch evidence for the predicted wall-clock effect of
 * `parallelDispatch: true`.
 *
 * Two parallel-safe tools, each delayed `DELAY_MS`, emitted as a single
 * turn. Sequential mode dispatches them one at a time, so wall-clock
 * is roughly `2 * DELAY_MS`. Parallel mode runs them concurrently, so
 * wall-clock is roughly `DELAY_MS`.
 *
 * Assertion: parallel-mode wall-clock is < 60% of sequential-mode
 * wall-clock. 60% gives generous headroom for CI scheduler jitter; the
 * theoretical bound is 50%.
 */

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

const DELAY_MS = 50;

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

function delayedReader(name: string): ToolHandler {
  return {
    name,
    description: name,
    parameters: { type: 'object' },
    parallelSafe: true,
    async execute() {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      return { ok: true, summary: name };
    },
  };
}

async function collect(events: AsyncIterable<StrategyEvent>): Promise<StrategyEvent[]> {
  const out: StrategyEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function buildScript(): ChatEvent[][] {
  return [
    [
      { kind: 'tool_call', id: 'c1', name: 'readA', args: {} },
      { kind: 'tool_call', id: 'c2', name: 'readB', args: {} },
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
  ];
}

async function runOnce(parallelDispatch: boolean): Promise<number> {
  const tA = delayedReader('readA');
  const tB = delayedReader('readB');
  const registry = createToolRegistry();
  registry.register(tA);
  registry.register(tB);

  const start = Date.now();
  await collect(
    createReactLoopStrategy({ parallelDispatch }).run(
      {
        prompt: 'go',
        history: [],
        workspace: EMPTY_WORKSPACE,
        runtime: EMPTY_RUNTIME,
        llm: fakeLlm(buildScript()),
        tools: createDispatch(registry),
        toolList: [tA, tB],
        toolContext: fakeCtx,
        systemPrompt: 's',
      },
      new AbortController().signal,
    ),
  );
  return Date.now() - start;
}

describe('createReactLoopStrategy (parallel-dispatch wall-clock effect)', () => {
  test(`parallel mode is materially faster than sequential when two ${DELAY_MS}ms parallel-safe tools share a turn`, async () => {
    // Warm-up to absorb first-call JIT / setTimeout calibration.
    await runOnce(false);

    const sequentialMs = await runOnce(false);
    const parallelMs = await runOnce(true);

    // Print for the status file write-up. The assertion below is the
    // gate; this is for humans reading the test log.
    // eslint-disable-next-line no-console
    console.log(
      `[parallel-effect] sequential=${sequentialMs}ms parallel=${parallelMs}ms ratio=${(
        parallelMs / sequentialMs
      ).toFixed(2)}`,
    );

    // Sanity: sequential mode should be at least ~1.5 * DELAY_MS.
    // Two 50ms sleeps back-to-back can drift on busy machines, so we
    // pick a loose lower bound rather than the theoretical 100ms.
    expect(sequentialMs).toBeGreaterThanOrEqual(DELAY_MS * 1.5);

    // The headline assertion: parallel is meaningfully smaller. 60%
    // leaves room for CI jitter; the theoretical bound is 50%.
    expect(parallelMs).toBeLessThan(sequentialMs * 0.6);
  });
});
