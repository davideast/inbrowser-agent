/**
 * Unit coverage for the opt-in `reflexion` option on
 * `createReactLoopStrategy`. Five scenarios per the phase-four brief:
 *
 *   1. critique returns `{ok: true}` → strategy returns the candidate
 *      final-answer turn unchanged. One `custom`
 *      `'reflexion_critique'` event with `verdict: 'ok'`. No retry.
 *   2. critique returns `{ok: false}` with retry budget remaining →
 *      strategy emits `verdict: 'retry'`, injects feedback as a user
 *      message, loops, and the next turn's reply reaches the caller.
 *   3. critique returns `{ok: false}` with retry budget exhausted →
 *      strategy emits `verdict: 'exhausted'`, returns the (last)
 *      final-answer turn as-is.
 *   4. malformed critique text → strategy treats verdict as
 *      `{ok: true}` (fail-open) and returns immediately.
 *   5. `reflexion` absent / `enabled: false` → strategy emits ZERO
 *      `custom` events and never makes the second `chat()` call. The
 *      event sequence is byte-for-byte identical to the legacy
 *      single-turn path.
 *
 * All tests use a stub `LlmClient` that yields a hand-crafted script of
 * `ChatEvent`s per `chat()` call. Stub records every `ChatRequest`
 * received so tests can prove the critique call did or did not happen
 * and inspect the messages it saw.
 */

import { describe, expect, test } from 'bun:test';
import {
  type ChatEvent,
  type ChatRequest,
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type LlmClient,
  type StrategyEvent,
  type ToolContext,
  createDispatch,
  createReactLoopStrategy,
  createToolRegistry,
} from '../src/index.js';

interface ScriptedLlm {
  client: LlmClient;
  requests: ChatRequest[];
}

function scriptedLlm(scripts: ChatEvent[][]): ScriptedLlm {
  const requests: ChatRequest[] = [];
  let turn = 0;
  const client: LlmClient = {
    id: 'fake',
    supportsTools: true,
    chat(req: ChatRequest): AsyncIterable<ChatEvent> {
      requests.push(req);
      const events = scripts[turn] ?? [];
      turn += 1;
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
  return { client, requests };
}

function fakeCtx(): ToolContext {
  return {
    workspace: EMPTY_WORKSPACE,
    runtime: EMPTY_RUNTIME,
    signal: new AbortController().signal,
  };
}

async function collect(events: AsyncIterable<StrategyEvent>): Promise<StrategyEvent[]> {
  const out: StrategyEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function turnComplete(usage = 1): ChatEvent {
  return {
    kind: 'turn_complete',
    usage: { promptTokens: usage, completionTokens: usage },
    details: { requestedModel: 'fake' },
  };
}

describe('createReactLoopStrategy (reflexion)', () => {
  test('critique returns ok → strategy returns final answer, retry not invoked', async () => {
    const { client, requests } = scriptedLlm([
      // turn 0: final-answer turn (no tool calls)
      [{ kind: 'text', chunk: 'The answer is 42.' }, turnComplete()],
      // critique call: verdict ok
      [{ kind: 'text', chunk: '{"ok": true}' }, turnComplete()],
    ]);

    const events = await collect(
      createReactLoopStrategy({ reflexion: { enabled: true } }).run(
        {
          prompt: 'q?',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm: client,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'sys',
        },
        new AbortController().signal,
      ),
    );

    expect(requests.length).toBe(2); // main + critique
    expect(requests[1]!.toolUseEnabled).toBe(false);
    expect(requests[1]!.tools).toEqual([]);

    const customEvents = events.filter(
      (e): e is Extract<StrategyEvent, { kind: 'custom' }> => e.kind === 'custom',
    );
    expect(customEvents.length).toBe(1);
    expect(customEvents[0]!.name).toBe('reflexion_critique');
    expect((customEvents[0]!.data as { verdict: string }).verdict).toBe('ok');

    // The candidate final-answer text reached the caller and the
    // turn_complete event was emitted for it.
    const textEvents = events.filter(
      (e): e is Extract<StrategyEvent, { kind: 'text' }> => e.kind === 'text',
    );
    expect(textEvents.map((e) => e.chunk).join('')).toBe('The answer is 42.');
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(true);
  });

  test('critique flags problems with retry budget → feedback injected, retry succeeds', async () => {
    const { client, requests } = scriptedLlm([
      // turn 0: WRONG final-answer turn
      [{ kind: 'text', chunk: 'The answer is 41.' }, turnComplete()],
      // critique #1: not ok, feedback present
      [
        {
          kind: 'text',
          chunk: '{"ok": false, "feedback": "Off-by-one — re-check the prior tool result."}',
        },
        turnComplete(),
      ],
      // turn 1: RIGHT final-answer turn (after feedback injection)
      [{ kind: 'text', chunk: 'Sorry, the answer is 42.' }, turnComplete()],
      // critique #2: ok
      [{ kind: 'text', chunk: '{"ok": true}' }, turnComplete()],
    ]);

    const events = await collect(
      createReactLoopStrategy({ reflexion: { enabled: true, maxRetries: 1 } }).run(
        {
          prompt: 'q?',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm: client,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'sys',
        },
        new AbortController().signal,
      ),
    );

    expect(requests.length).toBe(4); // turn0 + critique1 + turn1 + critique2

    const customEvents = events.filter(
      (e): e is Extract<StrategyEvent, { kind: 'custom' }> => e.kind === 'custom',
    );
    const verdicts = customEvents.map((e) => (e.data as { verdict: string }).verdict);
    expect(verdicts).toEqual(['retry', 'ok']);

    // Retry request must include the synthetic reviewer-feedback user
    // message AFTER the candidate assistant turn.
    const retryRequest = requests[2]!;
    const lastUserMsg = [...retryRequest.messages].reverse().find((m) => m.role === 'user');
    expect(lastUserMsg).toBeDefined();
    expect(lastUserMsg!.text).toContain('Reviewer feedback');
    expect(lastUserMsg!.text).toContain('Off-by-one');

    // The revised answer reached the caller.
    const textEvents = events.filter(
      (e): e is Extract<StrategyEvent, { kind: 'text' }> => e.kind === 'text',
    );
    expect(textEvents.map((e) => e.chunk).join('')).toContain('Sorry, the answer is 42.');
  });

  test('critique flags problems with retry budget exhausted → returns last answer as-is', async () => {
    const { client, requests } = scriptedLlm([
      // turn 0
      [{ kind: 'text', chunk: 'still wrong' }, turnComplete()],
      // critique #1: not ok → retry
      [{ kind: 'text', chunk: '{"ok": false, "feedback": "try again"}' }, turnComplete()],
      // turn 1 (the retry)
      [{ kind: 'text', chunk: 'still wrong again' }, turnComplete()],
      // critique #2: not ok, no budget left → exhausted
      [{ kind: 'text', chunk: '{"ok": false, "feedback": "still wrong"}' }, turnComplete()],
    ]);

    const events = await collect(
      createReactLoopStrategy({ reflexion: { enabled: true, maxRetries: 1 } }).run(
        {
          prompt: 'q?',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm: client,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'sys',
        },
        new AbortController().signal,
      ),
    );

    expect(requests.length).toBe(4);

    const customEvents = events.filter(
      (e): e is Extract<StrategyEvent, { kind: 'custom' }> => e.kind === 'custom',
    );
    const verdicts = customEvents.map((e) => (e.data as { verdict: string }).verdict);
    expect(verdicts).toEqual(['retry', 'exhausted']);

    // The most recent final-answer text reached the caller; the
    // exhausted branch does not block completion.
    const textEvents = events.filter(
      (e): e is Extract<StrategyEvent, { kind: 'text' }> => e.kind === 'text',
    );
    expect(textEvents.map((e) => e.chunk).join('')).toContain('still wrong again');
  });

  test('malformed critique JSON → treated as ok (fail-open)', async () => {
    const { client, requests } = scriptedLlm([
      [{ kind: 'text', chunk: 'answer' }, turnComplete()],
      // critique returns prose with no parseable JSON
      [{ kind: 'text', chunk: 'Looks fine to me, no JSON here.' }, turnComplete()],
    ]);

    const events = await collect(
      createReactLoopStrategy({ reflexion: { enabled: true } }).run(
        {
          prompt: 'q?',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm: client,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'sys',
        },
        new AbortController().signal,
      ),
    );

    expect(requests.length).toBe(2);
    const customEvents = events.filter(
      (e): e is Extract<StrategyEvent, { kind: 'custom' }> => e.kind === 'custom',
    );
    expect(customEvents.length).toBe(1);
    expect((customEvents[0]!.data as { verdict: string }).verdict).toBe('ok');
  });

  test('fenced ```json``` critique is parsed; bad ok-value falls open', async () => {
    // Two sub-cases as a single test to keep the file size tight.
    // Sub-case 1: fenced JSON object parses to ok:false → retry path.
    const { client: c1, requests: r1 } = scriptedLlm([
      [{ kind: 'text', chunk: 'first' }, turnComplete()],
      [
        {
          kind: 'text',
          chunk: '```json\n{"ok": false, "feedback": "fenced bad"}\n```',
        },
        turnComplete(),
      ],
      [{ kind: 'text', chunk: 'second' }, turnComplete()],
      [{ kind: 'text', chunk: '{"ok": true}' }, turnComplete()],
    ]);
    const fencedEvents = await collect(
      createReactLoopStrategy({ reflexion: { enabled: true, maxRetries: 1 } }).run(
        {
          prompt: 'q?',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm: c1,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'sys',
        },
        new AbortController().signal,
      ),
    );
    expect(r1.length).toBe(4);
    const fencedVerdicts = fencedEvents
      .filter((e): e is Extract<StrategyEvent, { kind: 'custom' }> => e.kind === 'custom')
      .map((e) => (e.data as { verdict: string }).verdict);
    expect(fencedVerdicts).toEqual(['retry', 'ok']);

    // Sub-case 2: JSON with non-boolean `ok` field falls open.
    const { client: c2, requests: r2 } = scriptedLlm([
      [{ kind: 'text', chunk: 'first' }, turnComplete()],
      [{ kind: 'text', chunk: '{"ok": "yes please"}' }, turnComplete()],
    ]);
    const events2 = await collect(
      createReactLoopStrategy({ reflexion: { enabled: true } }).run(
        {
          prompt: 'q?',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm: c2,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'sys',
        },
        new AbortController().signal,
      ),
    );
    expect(r2.length).toBe(2);
    const verdicts2 = events2
      .filter((e): e is Extract<StrategyEvent, { kind: 'custom' }> => e.kind === 'custom')
      .map((e) => (e.data as { verdict: string }).verdict);
    expect(verdicts2).toEqual(['ok']);
  });

  test('reflexion disabled / absent → byte-for-byte identical event stream and no second chat()', async () => {
    // Same script with and without reflexion absent — and with
    // reflexion `{ enabled: false }`. Both runs must produce IDENTICAL
    // event streams and exactly ONE chat() call.
    const buildScript = (): ChatEvent[][] => [
      [{ kind: 'text', chunk: 'plain answer' }, turnComplete()],
      // would-be critique never invoked
      [
        { kind: 'text', chunk: '{"ok": false, "feedback": "should not be reached"}' },
        turnComplete(),
      ],
    ];

    async function runOnce(
      reflexion: { enabled: boolean } | undefined,
    ): Promise<{ events: StrategyEvent[]; requestCount: number }> {
      const { client, requests } = scriptedLlm(buildScript());
      const events = await collect(
        createReactLoopStrategy(reflexion ? { reflexion } : {}).run(
          {
            prompt: 'q?',
            history: [],
            workspace: EMPTY_WORKSPACE,
            runtime: EMPTY_RUNTIME,
            llm: client,
            tools: createDispatch(createToolRegistry()),
            toolList: [],
            toolContext: fakeCtx,
            systemPrompt: 'sys',
          },
          new AbortController().signal,
        ),
      );
      return { events, requestCount: requests.length };
    }

    const absent = await runOnce(undefined);
    const explicitlyDisabled = await runOnce({ enabled: false });

    expect(absent.requestCount).toBe(1);
    expect(explicitlyDisabled.requestCount).toBe(1);
    expect(absent.events.length).toBe(explicitlyDisabled.events.length);
    // Deep equality on the event stream — disabled and absent must
    // produce IDENTICAL events.
    expect(JSON.stringify(explicitlyDisabled.events)).toBe(JSON.stringify(absent.events));
    // No custom events emitted in either run.
    expect(absent.events.some((e) => e.kind === 'custom')).toBe(false);
    expect(explicitlyDisabled.events.some((e) => e.kind === 'custom')).toBe(false);
  });
});
