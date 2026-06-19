/**
 * llama.cpp `llama-server` provider.
 *
 * llama-server speaks the same OpenAI-compatible `/v1/chat/completions`
 * wire shape as Ollama, so the provider is a thin preset over the shared
 * core. These tests pin the bits that are llama-server-SPECIFIC and not
 * covered by the shared streaming path:
 *
 *   - endpoint resolution (default port 8080, baseUrl override),
 *   - the apiKey-vs-baseUrl heuristic the relay routing depends on
 *     (a URL in the apiKey slot is the base URL → no auth header; a
 *     non-URL apiKey is the `--api-key` Bearer token),
 *   - that the shared streaming core still produces text / tool_call /
 *     usage events through this preset.
 *
 * The transport is `globalThis.fetch`, stubbed per test to capture the
 * request and return a canned SSE body.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ModelEvent, ModelRequest } from '../../src/contract';
import { llamaServerModelClient } from '../../src/providers/llama-server';

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const originalFetch = globalThis.fetch;
let captured: CapturedRequest | undefined;

/** Stub fetch: record the request, reply with the given SSE chunks. */
function stubFetch(chunks: unknown[]): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    captured = {
      url: String(url),
      headers: Object.fromEntries(headers.entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

function textDelta(content: string): unknown {
  return { choices: [{ delta: { content } }] };
}

function toolDelta(
  index: number,
  fields: { id?: string; name?: string; arguments?: string },
): unknown {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              ...(fields.id ? { id: fields.id } : {}),
              function: {
                ...(fields.name ? { name: fields.name } : {}),
                ...(fields.arguments !== undefined ? { arguments: fields.arguments } : {}),
              },
            },
          ],
        },
      },
    ],
  };
}

const USAGE = { usage: { prompt_tokens: 12, completion_tokens: 7 } };

const REQ: ModelRequest = {
  messages: [{ role: 'user', text: 'hi' }],
  tools: [],
  toolUseEnabled: false,
};

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

async function run(
  config: Parameters<typeof llamaServerModelClient>[0],
  chunks: unknown[],
  req: ModelRequest = REQ,
): Promise<ModelEvent[]> {
  stubFetch(chunks);
  const client = llamaServerModelClient(config);
  return collect(client.chat(req, new AbortController().signal));
}

beforeEach(() => {
  captured = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('llamaServerModelClient — construction', () => {
  it('uses the stable llama: id prefix', () => {
    const client = llamaServerModelClient({ model: 'qwen2.5-coder' });
    expect(client.id).toBe('llama:qwen2.5-coder');
    expect(client.supportsTools).toBe(true);
  });
});

describe('llamaServerModelClient — endpoint + auth resolution', () => {
  it('defaults to localhost:8080 with no auth header', async () => {
    await run({ model: 'm' }, [USAGE]);
    expect(captured?.url).toBe('http://localhost:8080/v1/chat/completions');
    expect(captured?.headers.authorization).toBeUndefined();
  });

  it('honors an explicit baseUrl (trailing slash trimmed)', async () => {
    await run({ model: 'm', baseUrl: 'http://gpu.local:9000/' }, [USAGE]);
    expect(captured?.url).toBe('http://gpu.local:9000/v1/chat/completions');
  });

  it('treats a URL in the apiKey slot as the base URL (relay routing), no auth', async () => {
    await run({ model: 'm', apiKey: 'http://gpu.local:8080' }, [USAGE]);
    expect(captured?.url).toBe('http://gpu.local:8080/v1/chat/completions');
    expect(captured?.headers.authorization).toBeUndefined();
  });

  it('sends a non-URL apiKey as a Bearer token at the default base', async () => {
    await run({ model: 'm', apiKey: 'secret-key' }, [USAGE]);
    expect(captured?.url).toBe('http://localhost:8080/v1/chat/completions');
    expect(captured?.headers.authorization).toBe('Bearer secret-key');
  });

  it('accepts baseUrl + apiKey-key together (authenticated server)', async () => {
    await run({ model: 'm', baseUrl: 'http://gpu.local:8080', apiKey: 'secret-key' }, [USAGE]);
    expect(captured?.url).toBe('http://gpu.local:8080/v1/chat/completions');
    expect(captured?.headers.authorization).toBe('Bearer secret-key');
  });
});

describe('llamaServerModelClient — streaming through the shared core', () => {
  it('streams text deltas then a usage event', async () => {
    const events = await run({ model: 'm' }, [textDelta('Hel'), textDelta('lo'), USAGE]);
    const text = events
      .filter((e) => e.kind === 'text')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('Hello');
    const usage = events.find((e) => e.kind === 'usage') as
      | Extract<ModelEvent, { kind: 'usage' }>
      | undefined;
    expect(usage?.usage).toMatchObject({ promptTokens: 12, outputTokens: 7 });
  });

  it('accumulates a tool_call streamed across chunks into one event', async () => {
    const events = await run({ model: 'm' }, [
      toolDelta(0, { id: 'call_1', name: 'get_weather', arguments: '{"ci' }),
      toolDelta(0, { arguments: 'ty":"SF"}' }),
      USAGE,
    ]);
    const calls = events.filter((e) => e.kind === 'tool_call') as Extract<
      ModelEvent,
      { kind: 'tool_call' }
    >[];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: 'call_1',
      name: 'get_weather',
      args: { city: 'SF' },
    });
  });

  it('surfaces a non-2xx response as an error event', async () => {
    globalThis.fetch = (async () =>
      new Response('model not found', { status: 404 })) as typeof fetch;
    const client = llamaServerModelClient({ model: 'm' });
    const events = await collect(client.chat(REQ, new AbortController().signal));
    const err = events.find((e) => e.kind === 'error') as
      | Extract<ModelEvent, { kind: 'error' }>
      | undefined;
    expect(err?.message).toContain('llama-server 404');
    expect(events.some((e) => e.kind === 'usage')).toBe(false);
  });

  it('sends the tools array when the request carries tools', async () => {
    const reqWithTools: ModelRequest = {
      messages: [{ role: 'user', text: 'weather?' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Get weather', parameters: {} },
        },
      ],
      toolUseEnabled: true,
    };
    await run({ model: 'm' }, [USAGE], reqWithTools);
    const body = captured?.body as { tools?: unknown[]; tool_choice?: string };
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
  });
});
