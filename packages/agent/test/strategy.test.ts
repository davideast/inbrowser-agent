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
