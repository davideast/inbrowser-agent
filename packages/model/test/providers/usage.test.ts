import { afterEach, describe, expect, test } from 'bun:test';
import type { ModelEvent, ModelRequest } from '../../src/contract';
import { openaiCompatModelClient } from '../../src/providers/oai-compat';
import { openrouterModelClient } from '../../src/providers/openrouter';

const originalFetch = globalThis.fetch;

const REQ: ModelRequest = {
  messages: [{ role: 'user', text: 'hi' }],
  tools: [],
  toolUseEnabled: false,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(chunks: unknown[]): void {
  globalThis.fetch = (async () => {
    const sse = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      'data: [DONE]\n\n';
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

describe('provider usage normalization', () => {
  test('OpenRouter preserves cached, reasoning, and cost telemetry', async () => {
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

    const client = openrouterModelClient({ apiKey: 'sk-test', model: 'openai/gpt-test' });
    const usage = usageEvent(await collect(client.chat(REQ, new AbortController().signal)));

    expect(usage.usage).toEqual({
      promptTokens: 100,
      outputTokens: 40,
      cachedTokens: 64,
      reasoningTokens: 12,
      costUsd: 0.0042,
    });
  });

  test('OpenAI-compatible providers preserve detailed usage when surfaced', async () => {
    stubFetch([
      {
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 20 },
          completion_tokens_details: { reasoning_tokens: 9 },
        },
      },
    ]);

    const client = openaiCompatModelClient({
      apiKey: 'sk-test',
      model: 'gpt-compatible',
      endpoint: 'https://example.test/v1/chat/completions',
    });
    const usage = usageEvent(await collect(client.chat(REQ, new AbortController().signal)));

    expect(usage.usage).toEqual({
      promptTokens: 120,
      outputTokens: 30,
      cachedTokens: 20,
      reasoningTokens: 9,
    });
  });
});
