import { describe, expect, test } from 'bun:test';
import type {
  ModelClient,
  ModelEvent,
  ModelRequest,
  ModelUsage,
  ToolSpec,
} from '../src/contract.js';

describe('model contract', () => {
  test('ModelEvent covers each kind with the unified field names', () => {
    const events: ModelEvent[] = [
      { kind: 'text', text: 'hi' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'tool_call', id: 'c1', name: 'search', args: { q: 'x' } },
      { kind: 'usage', usage: { promptTokens: 10, outputTokens: 5 } },
      { kind: 'error', message: 'nope' },
    ];
    expect(events.map((e) => e.kind)).toEqual(['text', 'thinking', 'tool_call', 'usage', 'error']);

    const text = events[0];
    if (text.kind === 'text') expect(text.text).toBe('hi'); // `text`, not `chunk`/`token`
    const tc = events[2];
    if (tc.kind === 'tool_call') expect(tc.id).toBe('c1'); // `id`, not `callId`
    const u = events[3];
    if (u.kind === 'usage') expect(u.usage.outputTokens).toBe(5); // nested usage; `outputTokens`
  });

  test('a minimal ModelClient is structurally valid; the turn ends by returning', async () => {
    const client: ModelClient = {
      id: 'fake:model',
      supportsTools: false,
      async *chat(_req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
        yield { kind: 'text', text: 'ok' };
        const usage: ModelUsage = { promptTokens: 1, outputTokens: 1 };
        yield { kind: 'usage', usage };
        // No turn_complete event — the turn ends because the iterable returns.
      },
    };
    expect(client.supportsTools).toBe(false);

    const req: ModelRequest = {
      messages: [{ role: 'user', text: 'hi' }],
      tools: [],
      toolUseEnabled: false,
    };
    const out: ModelEvent[] = [];
    for await (const ev of client.chat(req, new AbortController().signal)) out.push(ev);
    expect(out).toHaveLength(2);
    expect(out.at(-1)?.kind).toBe('usage');
  });

  test('ToolSpec is the OAI nested shape', () => {
    const t: ToolSpec = {
      type: 'function',
      function: { name: 'f', description: 'd', parameters: {} },
    };
    expect(t.function.name).toBe('f');
  });
});
