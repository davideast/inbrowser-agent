import { describe, expect, test } from 'bun:test';
import {
  type ChatEvent,
  type ChatRequest,
  type LegacyProvider,
  legacyProviderAsLlmClient,
} from '../src/index.js';

function fakeProvider(opts: {
  streamText?: string[];
  toolCall?: { callId: string; name: string; args: unknown };
  usage?: { promptTokens?: number; outputTokens?: number; costUsd?: number };
  details?: { servedModel?: string };
}): LegacyProvider {
  return {
    label: 'Fake',
    supportsTools: true,
    async chatWithTools(_messages, _tools, callbacks) {
      // Stream text chunks
      for (const chunk of opts.streamText ?? []) callbacks.onText(chunk);
      // Emit a tool call if scripted
      if (opts.toolCall) callbacks.onToolCall(opts.toolCall);
      return {
        text: (opts.streamText ?? []).join(''),
        usage: opts.usage,
        details: { requestedModel: 'fake-1', ...opts.details },
      };
    },
    async ask(prompt, onChunk) {
      for (const chunk of opts.streamText ?? [prompt]) onChunk(chunk);
      return { text: (opts.streamText ?? [prompt]).join('') };
    },
  };
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('legacyProviderAsLlmClient', () => {
  test('exposes id + supportsTools', () => {
    const client = legacyProviderAsLlmClient(fakeProvider({}), 'fake');
    expect(client.id).toBe('fake');
    expect(client.supportsTools).toBe(true);
  });

  test('streams text chunks as `text` events then a `turn_complete`', async () => {
    const client = legacyProviderAsLlmClient(
      fakeProvider({
        streamText: ['hello ', 'world'],
        usage: { promptTokens: 10, outputTokens: 2 },
      }),
      'fake',
    );
    const req: ChatRequest = {
      messages: [{ role: 'user', text: 'hi' }],
      tools: [],
      toolUseEnabled: true,
    };
    const events = await collect(client.chat(req, new AbortController().signal));
    const texts = events.filter((e) => e.kind === 'text');
    expect(texts).toHaveLength(2);
    const last = events[events.length - 1]!;
    expect(last.kind).toBe('turn_complete');
    if (last.kind !== 'turn_complete') throw new Error('unreachable');
    expect(last.usage.promptTokens).toBe(10);
    expect(last.usage.completionTokens).toBe(2);
  });

  test('relays tool calls as `tool_call` events', async () => {
    const client = legacyProviderAsLlmClient(
      fakeProvider({
        toolCall: { callId: 'c1', name: 'writeRules', args: { source: '...' } },
      }),
      'fake',
    );
    const events = await collect(
      client.chat(
        {
          messages: [],
          tools: [],
          toolUseEnabled: true,
        },
        new AbortController().signal,
      ),
    );
    const toolCall = events.find((e) => e.kind === 'tool_call');
    expect(toolCall).toBeDefined();
    if (toolCall?.kind !== 'tool_call') throw new Error('unreachable');
    expect(toolCall.name).toBe('writeRules');
    expect(toolCall.id).toBe('c1');
  });

  test('emits an `error` event when the legacy provider throws', async () => {
    const provider: LegacyProvider = {
      label: 'Broken',
      async chatWithTools() {
        throw new Error('boom');
      },
      async ask() {
        throw new Error('boom');
      },
    };
    const client = legacyProviderAsLlmClient(provider, 'broken');
    const events = await collect(
      client.chat(
        {
          messages: [],
          tools: [],
          toolUseEnabled: true,
        },
        new AbortController().signal,
      ),
    );
    const error = events.find((e) => e.kind === 'error');
    expect(error).toBeDefined();
    if (error?.kind === 'error') expect(error.message).toBe('boom');
  });
});
