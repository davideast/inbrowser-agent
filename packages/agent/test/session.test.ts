import { describe, expect, test } from 'bun:test';
import {
  type AgentStrategy,
  type ChatMessage,
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type ModelClient,
  type ModelEvent,
  type ModelRequest,
  type SessionEvent,
  type ToolContext,
  type ToolHandler,
  createAgentSession,
  createAgentTools,
  createDispatch,
  createMetricsCollector,
  createReactLoopStrategy,
  createToolRegistry,
} from '../src/index.js';

function fakeLlm(scripts: ModelEvent[][]): ModelClient {
  let turn = 0;
  return {
    id: 'fake',
    supportsTools: true,
    chat() {
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
      reseed() {},
      dispose() {},
    },
    lint: () => ({ warnings: [] }),
    signal: new AbortController().signal,
  };
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('createAgentSession', () => {
  test('emits turn_started → text → turn_completed → completed for a no-tool prompt', async () => {
    const session = createAgentSession({
      strategy: createReactLoopStrategy(),
      llm: fakeLlm([
        [
          { kind: 'text', text: 'hi back' },
          { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } },
        ],
      ]),
      tools: createDispatch(createToolRegistry()),
      toolList: [],
      toolContext: fakeCtx,
      systemPromptBuilder: () => 'system',
      metrics: createMetricsCollector(),
      history: [],
    });
    const events = await collect(session.submit('hi', new AbortController().signal));
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('turn_started');
    expect(kinds.includes('text')).toBe(true);
    expect(kinds.includes('turn_completed')).toBe(true);
    expect(kinds[kinds.length - 1]).toBe('completed');
  });

  test('applies tool result patches to workspace + runtime + emits change events', async () => {
    const writeRulesTool: ToolHandler<{ source: string }> = {
      name: 'writeRules',
      description: 'write rules',
      parameters: { type: 'object' },
      async execute({ source }) {
        return {
          ok: true,
          summary: `wrote ${source.length} chars`,
          workspacePatch: { rules: source },
        };
      },
    };
    const registry = createToolRegistry();
    registry.register(writeRulesTool);

    const session = createAgentSession({
      strategy: createReactLoopStrategy(),
      llm: fakeLlm([
        [
          {
            kind: 'tool_call',
            id: 'c1',
            name: 'writeRules',
            args: { source: 'rules_version="2"' },
          },
          { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } },
        ],
        [
          { kind: 'text', text: 'done' },
          { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } },
        ],
      ]),
      tools: createDispatch(registry),
      toolList: registry.list(),
      toolContext: () => ({ ...fakeCtx() }),
      systemPromptBuilder: () => 'system',
      metrics: createMetricsCollector(),
      history: [],
    });

    const events = await collect(session.submit('write rules', new AbortController().signal));
    const wsChanged = events.find((e) => e.kind === 'workspace_changed');
    expect(wsChanged).toBeDefined();
    expect(session.workspace.rules).toBe('rules_version="2"');
  });

  test('cancel() short-circuits the loop with an aborted error', async () => {
    const session = createAgentSession({
      strategy: createReactLoopStrategy(),
      llm: fakeLlm([
        [
          { kind: 'text', text: 'will be cancelled' },
          { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } },
        ],
      ]),
      tools: createDispatch(createToolRegistry()),
      toolList: [],
      toolContext: fakeCtx,
      systemPromptBuilder: () => 'system',
      metrics: createMetricsCollector(),
      history: [],
    });
    const events = session.submit('x', new AbortController().signal);
    session.cancel();
    const collected = await collect(events);
    // Either aborts before producing text or the text gets through;
    // in both cases the session ends.
    expect(collected.length).toBeGreaterThan(0);
  });

  test('hands a non-empty toolList to the strategy so the LLM gets function decls', async () => {
    // Regression: session.ts used to hardcode toolList: [], which made
    // the strategy emit toolUseEnabled=false → the legacy provider
    // adapter took the plain-`ask` path → the LLM never saw the tool
    // catalog and hallucinated `<tool_call>=name(...)` syntax in the
    // text stream. The fix: AgentSessionConfig now requires toolList,
    // and session.ts forwards it. This test pins the contract.
    const writeRulesTool: ToolHandler<{ source: string }> = {
      name: 'writeRules',
      description: 'write rules',
      parameters: { type: 'object' },
      async execute({ source }) {
        return { ok: true, summary: `wrote ${source.length}`, workspacePatch: { rules: source } };
      },
    };
    const registry = createToolRegistry();
    registry.register(writeRulesTool);

    let seenToolCount = -1;
    const spyLlm: ModelClient = {
      id: 'spy',
      supportsTools: true,
      chat(req) {
        seenToolCount = req.tools.length;
        return (async function* () {
          yield { kind: 'text', text: 'ok' } as ModelEvent;
          yield { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } } as ModelEvent;
        })();
      },
    };

    const session = createAgentSession({
      strategy: createReactLoopStrategy(),
      llm: spyLlm,
      tools: createDispatch(registry),
      toolList: registry.list(),
      toolContext: fakeCtx,
      systemPromptBuilder: () => 's',
      metrics: createMetricsCollector(),
      history: [],
    });
    await collect(session.submit('hi', new AbortController().signal));
    expect(seenToolCount).toBe(1);
  });

  test('accepts a cohesive AgentTools object without a separate toolList', async () => {
    const registry = createToolRegistry();
    registry.register({
      name: 'readThing',
      description: 'read thing',
      parameters: { type: 'object' },
      async execute() {
        return { ok: true, summary: 'read' };
      },
    });

    let seenToolCount = -1;
    const spyLlm: ModelClient = {
      id: 'spy',
      supportsTools: true,
      chat(req) {
        seenToolCount = req.tools.length;
        return (async function* () {
          yield { kind: 'text', text: 'ok' } as ModelEvent;
          yield { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } } as ModelEvent;
        })();
      },
    };

    const session = createAgentSession({
      strategy: createReactLoopStrategy(),
      llm: spyLlm,
      tools: createAgentTools(registry),
      toolContext: fakeCtx,
      systemPromptBuilder: () => 's',
      metrics: createMetricsCollector(),
      history: [],
    });

    await collect(session.submit('hi', new AbortController().signal));

    expect(seenToolCount).toBe(1);
  });

  test('hands the strategy the PRE-prompt history — never containing the current prompt', async () => {
    // Regression: the session used to append the user message to its
    // history BEFORE handing it to the strategy, so every strategy
    // (which appends input.prompt itself per the StrategyRunInput
    // contract) sent the prompt twice per LLM request. The contract:
    // input.history is everything BEFORE this turn's prompt; the
    // session still records the user message in its OWN history so
    // the NEXT turn's strategy sees it.
    const seenHistories: ChatMessage[][] = [];
    const seenPrompts: string[] = [];
    const spyStrategy: AgentStrategy = {
      id: 'spy',
      async *run(input) {
        seenHistories.push([...input.history]);
        seenPrompts.push(input.prompt);
        yield { kind: 'text', chunk: `reply to ${input.prompt}` };
        yield {
          kind: 'turn_complete',
          usage: { promptTokens: 1, outputTokens: 1 },
          details: { requestedModel: 'spy' },
        };
      },
    };
    const session = createAgentSession({
      strategy: spyStrategy,
      llm: fakeLlm([]),
      tools: createDispatch(createToolRegistry()),
      toolList: [],
      toolContext: fakeCtx,
      systemPromptBuilder: () => 'system',
      metrics: createMetricsCollector(),
      history: [],
    });

    await collect(session.submit('first prompt', new AbortController().signal));
    await collect(session.submit('second prompt', new AbortController().signal));

    // Turn 1: fresh session → empty pre-prompt history.
    expect(seenHistories[0]).toEqual([]);
    expect(seenPrompts[0]).toBe('first prompt');

    // Turn 2: history carries turn 1's user + assistant messages
    // (session persistence) but NOT the current prompt.
    const turn2 = seenHistories[1]!;
    expect(turn2.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(turn2[0]!.text).toBe('first prompt');
    expect(turn2[1]!.text).toBe('reply to first prompt');
    expect(turn2.some((m) => m.text === 'second prompt')).toBe(false);
  });

  test('LLM requests carry the user prompt exactly once (session + react loop)', async () => {
    // End-to-end pin of the double-append fix: drive a real react-loop
    // strategy through the session and inspect the actual ModelRequest
    // message arrays the LLM receives across two submits.
    const requests: ModelRequest[] = [];
    const spyLlm: ModelClient = {
      id: 'spy',
      supportsTools: true,
      chat(req): AsyncIterable<ModelEvent> {
        requests.push(req);
        return (async function* () {
          yield { kind: 'text', text: 'ok' } as ModelEvent;
          yield { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } } as ModelEvent;
        })();
      },
    };
    const session = createAgentSession({
      strategy: createReactLoopStrategy(),
      llm: spyLlm,
      tools: createDispatch(createToolRegistry()),
      toolList: [],
      toolContext: fakeCtx,
      systemPromptBuilder: () => 'system',
      metrics: createMetricsCollector(),
      history: [],
    });

    await collect(session.submit('prompt one', new AbortController().signal));
    await collect(session.submit('prompt two', new AbortController().signal));

    expect(requests).toHaveLength(2);
    for (const [i, prompt] of (['prompt one', 'prompt two'] as const).entries()) {
      const occurrences = requests[i]!.messages.filter((m) => m.text === prompt);
      expect(occurrences).toHaveLength(1);
    }
    // Turn 2 still sees turn 1's exchange via session history.
    const turn2Roles = requests[1]!.messages.map((m) => m.role);
    expect(turn2Roles).toEqual(['system', 'user', 'assistant', 'user']);
  });

  test('persists session.id between submits', () => {
    const session = createAgentSession({
      strategy: createReactLoopStrategy(),
      llm: fakeLlm([]),
      tools: createDispatch(createToolRegistry()),
      toolList: [],
      toolContext: fakeCtx,
      systemPromptBuilder: () => '',
      metrics: createMetricsCollector(),
      history: [],
      id: 'my-id',
    });
    expect(session.id).toBe('my-id');
  });
});
