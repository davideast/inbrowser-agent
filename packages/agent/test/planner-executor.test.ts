/**
 * Unit tests for `createPlannerExecutorStrategy`.
 *
 * Coverage matrix (per the brief):
 *
 *   - No-match path with `fallbackToReact: true` (default) falls back
 *     to a plain ReAct loop end-to-end.
 *   - No-match path with `fallbackToReact: false` yields a single
 *     `error` event and returns.
 *   - A one-step plan drives the inner ReAct sub-loop exactly once
 *     and emits the four `custom` events
 *     (plan_started, step_started, step_completed, plan_completed)
 *     in order.
 *   - A three-step plan runs three sub-loops in order, emitting the
 *     full `custom` event sequence and threading prior summaries
 *     into each subsequent step.
 *   - Scratch is dropped between steps: the message arrays the inner
 *     ReAct loop sends on each step's `llm_request` are NOT
 *     monotonically growing across steps — step 2 sends fewer
 *     messages than the cumulative scratch from step 1 would imply.
 */

import { describe, expect, test } from 'bun:test';
import {
  type ChatEvent,
  type ChatRequest,
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type LlmClient,
  type SkillCatalog,
  type StrategyEvent,
  type ToolContext,
  type TraceEvent,
  type Tracer,
  createDispatch,
  createPlannerExecutorStrategy,
  createToolRegistry,
} from '../src/index.js';

/**
 * A fake LLM that emits a scripted sequence of events per `chat()`
 * call. Each call dequeues the next script. When the script is
 * exhausted, the LLM emits a single text + turn_complete with empty
 * text (defensive — prevents tests hanging).
 */
function fakeLlm(scripts: ChatEvent[][]): LlmClient & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  const llm: LlmClient & { calls: ChatRequest[] } = {
    id: 'fake-planner-executor-llm',
    supportsTools: true,
    calls,
    chat(req: ChatRequest): AsyncIterable<ChatEvent> {
      calls.push(req);
      const events = scripts[i] ?? [
        { kind: 'text', chunk: '' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake-planner-executor-llm' },
        },
      ];
      i += 1;
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
  return llm;
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

/**
 * Minimal hand-rolled catalog so the tests don't depend on the
 * production catalog's exact step count or triggerHint set. Three
 * skills, each with a small plan; all three use a unique trigger
 * keyword the test prompts can hit deterministically.
 *
 * Names are taken from `SkillName` so the executor's
 * `getSkillEntry` call resolves them.
 */
const TEST_CATALOG: SkillCatalog = [
  {
    name: 'firestore-rules-audit',
    description: 'Test entry — one step.',
    triggerHints: ['one-step-keyword'],
    steps: [{ id: 'only', description: 'The only step.' }],
  },
  {
    name: 'rtdb-data-modeling',
    description: 'Test entry — three steps.',
    triggerHints: ['three-step-keyword'],
    steps: [
      { id: 'alpha', description: 'First.' },
      { id: 'beta', description: 'Second.' },
      { id: 'gamma', description: 'Third.' },
    ],
  },
  {
    name: 'firebase-client-sdk',
    description: 'Test entry — fallback target (unused in routed tests).',
    triggerHints: ['client-sdk-keyword'],
    steps: [
      { id: 'pre', description: 'Pre.' },
      { id: 'post', description: 'Post.' },
    ],
  },
];

describe('createPlannerExecutorStrategy — no-match path', () => {
  test('no router match + fallbackToReact: true → delegates to plain ReAct', async () => {
    // No trigger hint in the prompt, so the keyword router returns
    // null. With fallback enabled, the rest of the turn runs as a
    // plain ReAct loop. The LLM emits one text turn — that's the
    // full output.
    const llm = fakeLlm([
      [
        { kind: 'text', chunk: 'plain react fallback' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake-planner-executor-llm' },
        },
      ],
    ]);
    const strategy = createPlannerExecutorStrategy({ catalog: TEST_CATALOG });
    const events = await collect(
      strategy.run(
        {
          prompt: 'nothing-matches here',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'base prompt',
        },
        new AbortController().signal,
      ),
    );

    // No plan events at all — fell through to ReAct without any
    // planner-executor custom milestones.
    expect(events.some((e) => e.kind === 'custom')).toBe(false);
    // Saw the text + turn_complete from the inner ReAct loop.
    const text = events.find((e) => e.kind === 'text');
    expect(text?.kind).toBe('text');
    expect(events[events.length - 1]?.kind).toBe('turn_complete');
  });

  test('no router match + fallbackToReact: false → single error event', async () => {
    const llm = fakeLlm([]);
    const strategy = createPlannerExecutorStrategy({
      catalog: TEST_CATALOG,
      fallbackToReact: false,
    });
    const events = await collect(
      strategy.run(
        {
          prompt: 'nothing-matches here',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'base prompt',
        },
        new AbortController().signal,
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    // The LLM was never called — fail-fast on no match.
    expect(llm.calls).toHaveLength(0);
  });
});

describe('createPlannerExecutorStrategy — happy path', () => {
  test('one-step plan runs the sub-loop exactly once and emits the four custom milestones', async () => {
    // Single inner turn that emits text + turn_complete (no tool calls)
    // so the inner ReAct loop terminates after one chat() call.
    const llm = fakeLlm([
      [
        { kind: 'text', chunk: 'step output' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake-planner-executor-llm' },
        },
      ],
    ]);
    const strategy = createPlannerExecutorStrategy({ catalog: TEST_CATALOG });
    const events = await collect(
      strategy.run(
        {
          prompt: 'please run one-step-keyword now',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'base prompt',
        },
        new AbortController().signal,
      ),
    );

    // Inner ReAct loop made exactly one chat() call.
    expect(llm.calls).toHaveLength(1);

    // Custom event ordering: plan_started → step_started → … →
    // step_completed → plan_completed.
    const customs = events.filter((e) => e.kind === 'custom') as Extract<
      StrategyEvent,
      { kind: 'custom' }
    >[];
    expect(customs.map((c) => c.name)).toEqual([
      'plan_started',
      'step_started',
      'step_completed',
      'plan_completed',
    ]);

    // The plan_started payload includes the one step id.
    const planStarted = customs[0]!;
    expect((planStarted.data as { skill: string; plan: string[] }).plan).toEqual(['only']);

    // The inner text event flowed through unchanged.
    const text = events.find((e) => e.kind === 'text');
    expect(text?.kind).toBe('text');
    if (text?.kind === 'text') expect(text.chunk).toBe('step output');
  });

  test('three-step plan runs three sub-loops in order', async () => {
    // Three inner turns — one chat() call per step. Each emits text +
    // turn_complete with NO tool calls so the inner ReAct loop
    // terminates after one iteration per step.
    const llm = fakeLlm([
      [
        { kind: 'text', chunk: 'alpha out' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake-planner-executor-llm' },
        },
      ],
      [
        { kind: 'text', chunk: 'beta out' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake-planner-executor-llm' },
        },
      ],
      [
        { kind: 'text', chunk: 'gamma out' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake-planner-executor-llm' },
        },
      ],
    ]);
    const strategy = createPlannerExecutorStrategy({ catalog: TEST_CATALOG });
    const events = await collect(
      strategy.run(
        {
          prompt: 'please run three-step-keyword now',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'base prompt',
        },
        new AbortController().signal,
      ),
    );

    // Three chat() calls, one per step.
    expect(llm.calls).toHaveLength(3);

    // Custom event sequence:
    //   plan_started
    //     step_started(alpha) step_completed(alpha)
    //     step_started(beta)  step_completed(beta)
    //     step_started(gamma) step_completed(gamma)
    //   plan_completed
    const customs = events.filter((e) => e.kind === 'custom') as Extract<
      StrategyEvent,
      { kind: 'custom' }
    >[];
    expect(customs.map((c) => c.name)).toEqual([
      'plan_started',
      'step_started',
      'step_completed',
      'step_started',
      'step_completed',
      'step_started',
      'step_completed',
      'plan_completed',
    ]);
    // Step ids in order across the step_started events.
    const stepStartedIds = customs
      .filter((c) => c.name === 'step_started')
      .map((c) => (c.data as { stepId: string }).stepId);
    expect(stepStartedIds).toEqual(['alpha', 'beta', 'gamma']);

    // Inner text events from all three steps streamed through in
    // order.
    const texts = events
      .filter((e) => e.kind === 'text')
      .map((e) => (e.kind === 'text' ? e.chunk : ''));
    expect(texts).toEqual(['alpha out', 'beta out', 'gamma out']);
  });

  test('scratch is dropped between steps — message arrays do not grow monotonically', async () => {
    // We tap the tracer to capture every `llm_request` event and
    // inspect the messages array each inner ReAct iteration sent. If
    // scratch leaked across steps, step 3's messages would include
    // step 1's and step 2's assistant + tool turns. Instead each
    // step should reset: it sees the system prompt + N synthetic
    // user messages (one per prior step summary) + the original user
    // prompt — and nothing else from prior steps' tool dispatch.
    const llm = fakeLlm([
      [
        { kind: 'text', chunk: 'alpha output' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake-planner-executor-llm' },
        },
      ],
      [
        { kind: 'text', chunk: 'beta output' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake-planner-executor-llm' },
        },
      ],
      [
        { kind: 'text', chunk: 'gamma output' },
        {
          kind: 'turn_complete',
          usage: { promptTokens: 1, completionTokens: 1 },
          details: { requestedModel: 'fake-planner-executor-llm' },
        },
      ],
    ]);

    const trace: TraceEvent[] = [];
    const tracer: Tracer = {
      emit(event) {
        trace.push(event);
      },
    };

    const strategy = createPlannerExecutorStrategy({ catalog: TEST_CATALOG });
    await collect(
      strategy.run(
        {
          prompt: 'please run three-step-keyword now',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'base prompt',
          tracer,
          turnId: 'turn-1',
        },
        new AbortController().signal,
      ),
    );

    // One `llm_request` per step (each step's inner ReAct loop ran
    // exactly one iteration).
    const requests = trace.filter((ev) => ev.kind === 'llm_request');
    expect(requests).toHaveLength(3);

    // Each request's messages: [system, ...synthetic-user-summaries,
    // user(prompt)]. Step 0 has no priors; step 1 has 1; step 2 has 2.
    // The non-system message count grows by 1 per step (one new
    // synthetic summary), but the total is FAR smaller than what a
    // single growing ReAct loop would produce — in particular, no
    // assistant turns from prior steps appear, no tool messages from
    // prior steps appear. Concretely:
    //
    //   step 0: [system, user(prompt)]                       = 2 msgs
    //   step 1: [system, user(summary alpha), user(prompt)]  = 3 msgs
    //   step 2: [system, user(summary alpha),
    //                    user(summary beta),  user(prompt)]  = 4 msgs
    //
    // None of the step's messages should carry role 'assistant' or
    // role 'tool' — those would be leaked scratch.
    const counts = requests.map((r) => (r.kind === 'llm_request' ? r.data.messages.length : -1));
    expect(counts).toEqual([2, 3, 4]);
    // No assistant / tool messages anywhere in any per-step request.
    for (const req of requests) {
      if (req.kind !== 'llm_request') continue;
      for (const m of req.data.messages) {
        expect(m.role).not.toBe('assistant');
        expect(m.role).not.toBe('tool');
      }
    }

    // Sanity: the step 2 request's user messages contain BOTH prior
    // summary tokens, the step 1 request contains only alpha, the
    // step 0 request contains neither.
    const step0Text =
      requests[0]!.kind === 'llm_request'
        ? requests[0]!.data.messages.map((m) => m.text).join('|')
        : '';
    const step1Text =
      requests[1]!.kind === 'llm_request'
        ? requests[1]!.data.messages.map((m) => m.text).join('|')
        : '';
    const step2Text =
      requests[2]!.kind === 'llm_request'
        ? requests[2]!.data.messages.map((m) => m.text).join('|')
        : '';
    expect(step0Text).not.toContain('alpha output');
    expect(step0Text).not.toContain('beta output');
    expect(step1Text).toContain('alpha output');
    expect(step1Text).not.toContain('beta output');
    expect(step2Text).toContain('alpha output');
    expect(step2Text).toContain('beta output');
  });
});
