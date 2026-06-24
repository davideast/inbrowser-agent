import { afterEach, describe, expect, test } from 'bun:test';
import type { ModelEvent, ModelRequest } from '../../src/contract';
import { requestyModelClient } from '../../src/providers/requesty';

const originalFetch = globalThis.fetch;

const REQ: ModelRequest = {
  messages: [{ role: 'user', text: 'hi' }],
  tools: [],
  toolUseEnabled: false,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetch(chunks: unknown[], captured?: CapturedRequest[]): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (captured) {
      captured.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string),
      });
    }
    const sse =
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of it) events.push(event);
  return events;
}

function usageEvent(events: readonly ModelEvent[]): Extract<ModelEvent, { kind: 'usage' }> {
  const event = events.find((candidate) => candidate.kind === 'usage');
  if (!event || event.kind !== 'usage') throw new Error('missing usage event');
  return event;
}

describe('requesty provider', () => {
  test('posts to the Requesty endpoint with a Bearer key', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch([{ choices: [{ delta: { content: 'hello' } }] }], captured);

    const client = requestyModelClient({ apiKey: 'sk-test', model: 'openai/gpt-4o-mini' });
    await collect(client.chat(REQ, new AbortController().signal));

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://router.requesty.ai/v1/chat/completions');
    expect(captured[0].headers.Authorization).toBe('Bearer sk-test');
    expect(captured[0].headers['HTTP-Referer']).toBeUndefined();
    expect(captured[0].headers['X-Title']).toBeUndefined();
    expect(captured[0].body.model).toBe('openai/gpt-4o-mini');
    expect(captured[0].body.stream).toBe(true);
    // Cost telemetry is requested in the final usage chunk.
    expect(captured[0].body.usage).toEqual({ include: true });
  });

  test('sends optional app attribution headers', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch([{ choices: [{ delta: { content: 'hello' } }] }], captured);

    const client = requestyModelClient({
      apiKey: 'sk-test',
      model: 'openai/gpt-4o-mini',
      appAttribution: {
        referer: 'https://inbrowser.dev',
        title: 'inbrowser',
      },
    });
    await collect(client.chat(REQ, new AbortController().signal));

    expect(captured[0].headers['HTTP-Referer']).toBe('https://inbrowser.dev');
    expect(captured[0].headers['X-Title']).toBe('inbrowser');
  });

  test('streams text and emits a tool call', async () => {
    const reqWithTool: ModelRequest = {
      messages: [{ role: 'user', text: 'weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Current temperature for a city.',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
      toolUseEnabled: true,
    };
    stubFetch([
      { choices: [{ delta: { content: 'Let me check.' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'get_weather', arguments: '{"city":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }],
      },
    ]);

    const client = requestyModelClient({ apiKey: 'sk-test', model: 'openai/gpt-4o-mini' });
    const events = await collect(client.chat(reqWithTool, new AbortController().signal));

    const text = events.find((e) => e.kind === 'text');
    expect(text).toEqual({ kind: 'text', text: 'Let me check.' });

    const toolCall = events.find((e) => e.kind === 'tool_call');
    expect(toolCall).toEqual({
      kind: 'tool_call',
      id: 'call_1',
      name: 'get_weather',
      args: { city: 'Paris' },
    });
  });

  test('surfaces reasoning deltas as thinking events', async () => {
    stubFetch([
      { choices: [{ delta: { reasoning: 'thinking…' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
    ]);

    const client = requestyModelClient({ apiKey: 'sk-test', model: 'openai/gpt-4o-mini' });
    const events = await collect(client.chat(REQ, new AbortController().signal));

    expect(events.find((e) => e.kind === 'thinking')).toEqual({
      kind: 'thinking',
      text: 'thinking…',
    });
  });

  test('preserves cached, reasoning, and cost telemetry', async () => {
    stubFetch([
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 12 },
          cost: 0.0042,
        },
      },
    ]);

    const client = requestyModelClient({ apiKey: 'sk-test', model: 'openai/gpt-4o-mini' });
    const usage = usageEvent(await collect(client.chat(REQ, new AbortController().signal)));

    expect(usage.usage).toEqual({
      promptTokens: 100,
      outputTokens: 40,
      cachedTokens: 64,
      reasoningTokens: 12,
      costUsd: 0.0042,
    });
  });

  test('explicitly disables reasoning when effort is off', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch([{ choices: [{ delta: { content: 'ok' } }] }], captured);

    const client = requestyModelClient({ apiKey: 'sk-test', model: 'openai/gpt-4o-mini' });
    await collect(client.chat(REQ, new AbortController().signal));

    expect(captured[0].body.reasoning).toEqual({ enabled: false });
  });

  test('surfaces a non-OK response as an error event', async () => {
    globalThis.fetch = (async () =>
      new Response('bad key', { status: 401, statusText: 'Unauthorized' })) as typeof fetch;

    const client = requestyModelClient({ apiKey: 'bad', model: 'openai/gpt-4o-mini' });
    const events = await collect(client.chat(REQ, new AbortController().signal));

    const err = events.find((e) => e.kind === 'error');
    expect(err?.kind).toBe('error');
    expect((err as Extract<ModelEvent, { kind: 'error' }>).message).toContain('Requesty 401');
  });
});
