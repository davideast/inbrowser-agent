/**
 * In-branch evidence for the reflexion effect.
 *
 * A stateful stub `LlmClient` emits three scripted turns:
 *
 *   1. First main-loop turn: the WRONG final-answer text.
 *   2. Critique call: a JSON verdict `{ok: false, feedback: "..."}`.
 *   3. Second main-loop turn (only reached when reflexion is enabled
 *      and triggers a retry): the RIGHT final-answer text.
 *
 * With reflexion disabled, the strategy returns after turn 1; the trace
 * contains the wrong answer. With reflexion enabled, the strategy
 * triggers the retry, the third scripted turn fires, and the trace
 * contains the right answer.
 *
 * Both runs are exercised through `createReactLoopStrategy` directly —
 * not through `runFixture` — so the assertion is grounded in the
 * strategy's own event stream rather than the harness's
 * post-processing.
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

const WRONG = 'The capital of France is Berlin.';
const RIGHT = 'The capital of France is Paris.';

interface WrongThenRightStub {
  client: LlmClient;
  /** How many chat() calls the strategy made. */
  callCount(): number;
}

/**
 * Stateful stub. State machine:
 *   call 0 (main-loop turn 0): yield WRONG text + turn_complete
 *   call 1 (critique):         yield {"ok": false, "feedback": ...}
 *                              + turn_complete
 *   call 2 (main-loop turn 1): yield RIGHT text + turn_complete
 *   call 3 (critique #2):      yield {"ok": true} + turn_complete
 *   call >=4:                  empty (defensive — should never reach)
 *
 * The stub records nothing about the request shape — the unit tests
 * already cover that. This file is about the END-TO-END trace effect.
 */
function wrongThenRightStub(): WrongThenRightStub {
  let i = 0;
  const client: LlmClient = {
    id: 'wrong-then-right-stub',
    supportsTools: true,
    chat(_req: ChatRequest): AsyncIterable<ChatEvent> {
      const current = i++;
      const completed: ChatEvent = {
        kind: 'turn_complete',
        usage: { promptTokens: 50, completionTokens: 10 },
        details: { requestedModel: 'wrong-then-right-stub' },
      };
      const events: ChatEvent[] = [];
      if (current === 0) {
        events.push({ kind: 'text', chunk: WRONG }, completed);
      } else if (current === 1) {
        events.push(
          {
            kind: 'text',
            chunk: '{"ok": false, "feedback": "Berlin is not the capital of France."}',
          },
          completed,
        );
      } else if (current === 2) {
        events.push({ kind: 'text', chunk: RIGHT }, completed);
      } else if (current === 3) {
        events.push({ kind: 'text', chunk: '{"ok": true}' }, completed);
      }
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
  return { client, callCount: () => i };
}

function fakeCtx(): ToolContext {
  return {
    workspace: EMPTY_WORKSPACE,
    runtime: EMPTY_RUNTIME,
    signal: new AbortController().signal,
  };
}

async function runOnce(
  reflexion: { enabled: boolean; maxRetries?: number } | undefined,
): Promise<{ events: StrategyEvent[]; calls: number; finalText: string }> {
  const { client, callCount } = wrongThenRightStub();
  const events: StrategyEvent[] = [];
  for await (const ev of createReactLoopStrategy(reflexion ? { reflexion } : {}).run(
    {
      prompt: 'What is the capital of France?',
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
  )) {
    events.push(ev);
  }
  const finalText = events
    .filter((e): e is Extract<StrategyEvent, { kind: 'text' }> => e.kind === 'text')
    .map((e) => e.chunk)
    .join('');
  return { events, calls: callCount(), finalText };
}

describe('createReactLoopStrategy (reflexion effect)', () => {
  test('with reflexion DISABLED, the wrong-then-right stub returns the wrong answer', async () => {
    const result = await runOnce(undefined);
    expect(result.calls).toBe(1);
    expect(result.finalText).toBe(WRONG);
    expect(result.finalText.includes(RIGHT)).toBe(false);
    // No custom critique events emitted in disabled mode.
    expect(result.events.some((e) => e.kind === 'custom')).toBe(false);
  });

  test('with reflexion ENABLED, the wrong-then-right stub returns the corrected answer', async () => {
    const result = await runOnce({ enabled: true, maxRetries: 1 });
    expect(result.calls).toBe(4); // turn0 + critique1 + turn1 + critique2
    expect(result.finalText).toContain(RIGHT);

    // The custom event surface tells the host: first critique flagged
    // a problem and the retry was approved.
    const customEvents = result.events.filter(
      (e): e is Extract<StrategyEvent, { kind: 'custom' }> => e.kind === 'custom',
    );
    expect(customEvents.length).toBe(2);
    expect(customEvents.map((e) => (e.data as { verdict: string }).verdict)).toEqual([
      'retry',
      'ok',
    ]);
  });
});
