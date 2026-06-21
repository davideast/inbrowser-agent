import { describe, expect, test } from 'bun:test';
import {
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type ModelClient,
  type ModelEvent,
  type StrategyEvent,
  type ToolContext,
  type TraceEvent,
  createDispatch,
  createReactLoopStrategy,
  createToolRegistry,
} from '../src/index.js';

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

async function collect(events: AsyncIterable<StrategyEvent>): Promise<StrategyEvent[]> {
  const out: StrategyEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('createReactLoopStrategy trace usage', () => {
  test('llm_response usage preserves cached, reasoning, and cost fields', async () => {
    const traceEvents: TraceEvent[] = [];
    const llm: ModelClient = {
      id: 'fake',
      supportsTools: true,
      chat(): AsyncIterable<ModelEvent> {
        return (async function* () {
          yield { kind: 'text', text: 'hello' };
          yield {
            kind: 'usage',
            usage: {
              promptTokens: 100,
              outputTokens: 30,
              cachedTokens: 25,
              reasoningTokens: 8,
              costUsd: 0.004,
            },
          };
        })();
      },
    };

    await collect(
      createReactLoopStrategy().run(
        {
          prompt: 'hi',
          history: [],
          workspace: EMPTY_WORKSPACE,
          runtime: EMPTY_RUNTIME,
          llm,
          tools: createDispatch(createToolRegistry()),
          toolList: [],
          toolContext: fakeCtx,
          systemPrompt: 'sys',
          tracer: { emit: (event) => traceEvents.push(event) },
        },
        new AbortController().signal,
      ),
    );

    const response = traceEvents.find((event) => event.kind === 'llm_response');
    expect(response?.kind).toBe('llm_response');
    if (response?.kind === 'llm_response') {
      expect(response.data.usage).toEqual({
        promptTokens: 100,
        outputTokens: 30,
        cachedTokens: 25,
        reasoningTokens: 8,
        costUsd: 0.004,
      });
    }
  });
});
