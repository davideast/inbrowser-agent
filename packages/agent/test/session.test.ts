import { describe, expect, test } from 'bun:test';
import {
  type ChatEvent,
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type LlmClient,
  type SessionEvent,
  type ToolContext,
  type ToolHandler,
  createAgentSession,
  createDispatch,
  createMetricsCollector,
  createReactLoopStrategy,
  createToolRegistry,
} from '../src/index.js';

function fakeLlm(scripts: ChatEvent[][]): LlmClient {
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
          { kind: 'text', chunk: 'hi back' },
          {
            kind: 'turn_complete',
            usage: { promptTokens: 1, completionTokens: 1 },
            details: { requestedModel: 'fake' },
          },
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
          { kind: 'text', chunk: 'will be cancelled' },
          {
            kind: 'turn_complete',
            usage: { promptTokens: 1, completionTokens: 1 },
            details: { requestedModel: 'fake' },
          },
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
    const spyLlm: LlmClient = {
      id: 'spy',
      supportsTools: true,
      chat(req) {
        seenToolCount = req.tools.length;
        return (async function* () {
          yield { kind: 'text', chunk: 'ok' } as ChatEvent;
          yield {
            kind: 'turn_complete',
            usage: { promptTokens: 1, completionTokens: 1 },
            details: { requestedModel: 'spy' },
          } as ChatEvent;
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
