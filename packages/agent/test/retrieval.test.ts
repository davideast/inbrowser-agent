import { describe, expect, test } from 'bun:test';
import {
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type ModelClient,
  type ModelEvent,
  type ModelRequest,
  type StrategyEvent,
  type ToolContext,
  type ToolHandler,
  createDispatch,
  createRetrievalStrategy,
  createToolRegistry,
} from '../src/index.js';

/**
 * Scripted `ModelClient`: yields a fixed event list for the single
 * chat call this strategy makes. Captures every request it receives so
 * a test can assert on the context-stuffed final user message and the
 * `tools: []` / `toolUseEnabled: false` wire shape.
 */
function scriptedLlm(events: ModelEvent[], captured: ModelRequest[]): ModelClient {
  return {
    id: 'fake-smol',
    supportsTools: false,
    chat(req): AsyncIterable<ModelEvent> {
      captured.push(req);
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
    lint: () => ({ warnings: [] }),
    signal: new AbortController().signal,
  };
}

async function collect(events: AsyncIterable<StrategyEvent>): Promise<StrategyEvent[]> {
  const out: StrategyEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

/** A `search_docs` tool that returns two hits (routes /a and /b),
 *  recording the args it was called with. */
function makeSearchTool(calls: { name: string; args: unknown }[]): ToolHandler {
  return {
    name: 'search_docs',
    description: 'search the docs',
    parameters: { type: 'object' },
    async execute(args) {
      calls.push({ name: 'search_docs', args });
      return {
        ok: true,
        summary: '2 hits',
        data: { hits: [{ route: '/a' }, { route: '/b' }] },
      };
    },
  };
}

/** A `get_doc` tool that echoes the requested route into a body,
 *  recording the args it was called with. */
function makeReadTool(calls: { name: string; args: unknown }[]): ToolHandler {
  return {
    name: 'get_doc',
    description: 'read one doc',
    parameters: { type: 'object' },
    async execute(args) {
      calls.push({ name: 'get_doc', args });
      const route = (args as { route?: string }).route ?? '';
      return {
        ok: true,
        summary: `doc ${route}`,
        data: { route, title: 'T', body: `BODY-${route}` },
      };
    },
  };
}

function baseInput(
  llm: ModelClient,
  registry: ReturnType<typeof createToolRegistry>,
  toolList: ToolHandler[],
) {
  return {
    prompt: 'how does it work?',
    history: [],
    workspace: EMPTY_WORKSPACE,
    runtime: EMPTY_RUNTIME,
    llm,
    tools: createDispatch(registry),
    toolList,
    toolContext: fakeCtx,
    systemPrompt: 'You are a docs assistant.',
  };
}

describe('createRetrievalStrategy', () => {
  test('retrieves (search then top-K get_doc), stuffs context, and streams a grounded answer', async () => {
    const toolCalls: { name: string; args: unknown }[] = [];
    const search = makeSearchTool(toolCalls);
    const read = makeReadTool(toolCalls);
    const registry = createToolRegistry();
    registry.register(search);
    registry.register(read);

    const captured: ModelRequest[] = [];
    const llm = scriptedLlm(
      [
        { kind: 'text', text: 'Grounded answer from /a and /b.' },
        { kind: 'usage', usage: { promptTokens: 42, outputTokens: 7 } },
      ],
      captured,
    );

    const events = await collect(
      createRetrievalStrategy({ topK: 2 }).run(
        baseInput(llm, registry, [search, read]),
        new AbortController().signal,
      ),
    );

    // (a) search executed once with { query: prompt }, then get_doc for
    //     each of the top-K routes with the right { route } args.
    expect(toolCalls).toEqual([
      { name: 'search_docs', args: { query: 'how does it work?' } },
      { name: 'get_doc', args: { route: '/a' } },
      { name: 'get_doc', args: { route: '/b' } },
    ]);

    // (b) a tool_call + tool_result emitted for each of search + 2 reads.
    const toolCallEvents = events.filter((e) => e.kind === 'tool_call');
    const toolResultEvents = events.filter((e) => e.kind === 'tool_result');
    expect(toolCallEvents.map((e) => (e.kind === 'tool_call' ? e.name : ''))).toEqual([
      'search_docs',
      'get_doc',
      'get_doc',
    ]);
    expect(toolResultEvents).toHaveLength(3);
    // tool_call/tool_result ids are paired.
    for (const call of toolCallEvents) {
      if (call.kind !== 'tool_call') continue;
      const paired = toolResultEvents.find((r) => r.kind === 'tool_result' && r.id === call.id);
      expect(paired).toBeDefined();
    }

    // (c) the model received exactly one request whose LAST user message
    //     contains the retrieved bodies (context stuffing), with no
    //     tools advertised and tool use disabled.
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.tools).toHaveLength(0);
    expect(req.toolUseEnabled).toBe(false);
    const lastMessage = req.messages[req.messages.length - 1]!;
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.text).toContain('BODY-/a');
    expect(lastMessage.text).toContain('BODY-/b');
    expect(lastMessage.text).toContain('how does it work?');
    // System prompt is still the first message.
    expect(req.messages[0]).toEqual({ role: 'system', text: 'You are a docs assistant.' });

    // (d) the model's text streamed through as a `text` StrategyEvent.
    const textEvents = events.filter((e) => e.kind === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toEqual({ kind: 'text', chunk: 'Grounded answer from /a and /b.' });

    // (e) ends with turn_complete carrying the model usage.
    const last = events[events.length - 1]!;
    expect(last.kind).toBe('turn_complete');
    if (last.kind === 'turn_complete') {
      expect(last.usage).toEqual({ promptTokens: 42, outputTokens: 7 });
      expect(last.details).toEqual({ requestedModel: 'fake-smol' });
    }
  });

  test('default topK reads at most 3 docs', async () => {
    const toolCalls: { name: string; args: unknown }[] = [];
    const search: ToolHandler = {
      name: 'search_docs',
      description: 'search',
      parameters: { type: 'object' },
      async execute(args) {
        toolCalls.push({ name: 'search_docs', args });
        return {
          ok: true,
          summary: '5 hits',
          data: {
            hits: [
              { route: '/a' },
              { route: '/b' },
              { route: '/c' },
              { route: '/d' },
              { route: '/e' },
            ],
          },
        };
      },
    };
    const read = makeReadTool(toolCalls);
    const registry = createToolRegistry();
    registry.register(search);
    registry.register(read);

    const captured: ModelRequest[] = [];
    const llm = scriptedLlm(
      [{ kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } }],
      captured,
    );

    await collect(
      createRetrievalStrategy().run(
        baseInput(llm, registry, [search, read]),
        new AbortController().signal,
      ),
    );

    const reads = toolCalls.filter((c) => c.name === 'get_doc');
    expect(reads.map((c) => (c.args as { route: string }).route)).toEqual(['/a', '/b', '/c']);
  });

  test('completes (no crash) when search returns zero hits', async () => {
    const search: ToolHandler = {
      name: 'search_docs',
      description: 'search',
      parameters: { type: 'object' },
      async execute() {
        return { ok: true, summary: 'no hits', data: { hits: [] } };
      },
    };
    const read = makeReadTool([]);
    const registry = createToolRegistry();
    registry.register(search);
    registry.register(read);

    const captured: ModelRequest[] = [];
    const llm = scriptedLlm(
      [
        { kind: 'text', text: 'I could not find that in the docs.' },
        { kind: 'usage', usage: { promptTokens: 5, outputTokens: 3 } },
      ],
      captured,
    );

    const events = await collect(
      createRetrievalStrategy().run(
        baseInput(llm, registry, [search, read]),
        new AbortController().signal,
      ),
    );

    // search emitted, no get_doc calls, still generated + completed.
    const toolCallNames = events
      .filter((e) => e.kind === 'tool_call')
      .map((e) => (e.kind === 'tool_call' ? e.name : ''));
    expect(toolCallNames).toEqual(['search_docs']);
    expect(captured).toHaveLength(1);
    expect(events.find((e) => e.kind === 'text')).toBeDefined();
    expect(events[events.length - 1]!.kind).toBe('turn_complete');
  });

  test('still completes when the search tool fails', async () => {
    const search: ToolHandler = {
      name: 'search_docs',
      description: 'search',
      parameters: { type: 'object' },
      async execute() {
        return { ok: false, summary: 'search backend down' };
      },
    };
    const read = makeReadTool([]);
    const registry = createToolRegistry();
    registry.register(search);
    registry.register(read);

    const captured: ModelRequest[] = [];
    const llm = scriptedLlm(
      [{ kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } }],
      captured,
    );

    const events = await collect(
      createRetrievalStrategy().run(
        baseInput(llm, registry, [search, read]),
        new AbortController().signal,
      ),
    );

    // No reads attempted on a failed search; still generated once.
    const toolCallNames = events
      .filter((e) => e.kind === 'tool_call')
      .map((e) => (e.kind === 'tool_call' ? e.name : ''));
    expect(toolCallNames).toEqual(['search_docs']);
    expect(captured).toHaveLength(1);
    expect(events[events.length - 1]!.kind).toBe('turn_complete');
  });

  test('aborts before search when the signal is already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const toolCalls: { name: string; args: unknown }[] = [];
    const search = makeSearchTool(toolCalls);
    const registry = createToolRegistry();
    registry.register(search);

    const captured: ModelRequest[] = [];
    const llm = scriptedLlm([], captured);

    const events = await collect(
      createRetrievalStrategy().run(baseInput(llm, registry, [search]), controller.signal),
    );

    expect(events[0]?.kind).toBe('error');
    if (events[0]?.kind === 'error') expect(events[0].message).toBe('aborted');
    // Nothing dispatched, model never called.
    expect(toolCalls).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  test('honors contextBudget by trimming retrieved bodies', async () => {
    const toolCalls: { name: string; args: unknown }[] = [];
    const search = makeSearchTool(toolCalls);
    // get_doc returns a long body so the budget actually bites.
    const read: ToolHandler = {
      name: 'get_doc',
      description: 'read',
      parameters: { type: 'object' },
      async execute(args) {
        toolCalls.push({ name: 'get_doc', args });
        const route = (args as { route: string }).route;
        return { ok: true, summary: route, data: { route, title: 'T', body: 'X'.repeat(50) } };
      },
    };
    const registry = createToolRegistry();
    registry.register(search);
    registry.register(read);

    const captured: ModelRequest[] = [];
    const llm = scriptedLlm(
      [{ kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } }],
      captured,
    );

    await collect(
      createRetrievalStrategy({ topK: 2, contextBudget: 30 }).run(
        baseInput(llm, registry, [search, read]),
        new AbortController().signal,
      ),
    );

    // First doc fills 30 chars; the budget is exhausted so the second
    // read is never attempted.
    const reads = toolCalls.filter((c) => c.name === 'get_doc');
    expect(reads).toHaveLength(1);
    const userText = captured[0]!.messages[captured[0]!.messages.length - 1]!.text ?? '';
    // The single body got trimmed to the 30-char budget.
    expect((userText.match(/X/g) ?? []).length).toBe(30);
  });
});
