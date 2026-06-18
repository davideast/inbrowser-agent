/**
 * `withRetry` decorator tests. The decorator retries a transient error
 * only while nothing has streamed this turn; once text/tool output has
 * been yielded an error passes straight through. It always emits a
 * terminal `usage` event before returning.
 */
import { describe, expect, it } from 'bun:test';
import type { ModelClient, ModelEvent, ModelRequest } from '../src/contract';
import { withRetry } from '../src/with-retry';

const REQ: ModelRequest = {
  messages: [{ role: 'user', text: 'hi' }],
  tools: [],
  toolUseEnabled: false,
};

/**
 * Build a fake inner `ModelClient` whose `chat` yields a different
 * scripted event list per attempt. Records the attempt count.
 */
function scriptedClient(attempts: ModelEvent[][]): {
  client: ModelClient;
  calls: () => number;
} {
  let n = 0;
  const client: ModelClient = {
    id: 'fake:m',
    supportsTools: true,
    async *chat(_req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
      const script = attempts[Math.min(n, attempts.length - 1)] ?? [];
      n++;
      for (const e of script) yield e;
    },
  };
  return { client, calls: () => n };
}

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('withRetry', () => {
  it('retries a transient error when nothing has been emitted, then succeeds', async () => {
    const { client, calls } = scriptedClient([
      [{ kind: 'error', message: 'upstream 503 unavailable' }],
      [
        { kind: 'text', text: 'hello' },
        { kind: 'usage', usage: { promptTokens: 3, outputTokens: 1 } },
      ],
    ]);
    const events = await collect(withRetry(client).chat(REQ, new AbortController().signal));
    expect(calls()).toBe(2);
    expect(events.filter((e) => e.kind === 'error')).toEqual([]);
    expect(events.find((e) => e.kind === 'text')).toEqual({ kind: 'text', text: 'hello' });
    // Exactly one terminal usage event.
    expect(events.filter((e) => e.kind === 'usage')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'usage')).toEqual({
      kind: 'usage',
      usage: { promptTokens: 3, outputTokens: 1 },
    });
  });

  it('does NOT retry once text has been emitted — the error passes through', async () => {
    const { client, calls } = scriptedClient([
      [
        { kind: 'text', text: 'partial' },
        { kind: 'error', message: 'upstream 503 unavailable' },
      ],
      [{ kind: 'text', text: 'SHOULD NOT APPEAR' }],
    ]);
    const events = await collect(withRetry(client).chat(REQ, new AbortController().signal));
    expect(calls()).toBe(1); // no retry — output had already streamed
    expect(events).toEqual([
      { kind: 'text', text: 'partial' },
      { kind: 'error', message: 'upstream 503 unavailable' },
    ]);
  });

  it('passes a non-transient error straight through without retrying', async () => {
    const { client, calls } = scriptedClient([
      [{ kind: 'error', message: 'invalid api key' }],
      [{ kind: 'text', text: 'SHOULD NOT APPEAR' }],
    ]);
    const events = await collect(withRetry(client).chat(REQ, new AbortController().signal));
    expect(calls()).toBe(1);
    expect(events).toEqual([{ kind: 'error', message: 'invalid api key' }]);
  });

  it('gives up after maxAttempts and surfaces the last transient error', async () => {
    const { client, calls } = scriptedClient([
      [{ kind: 'error', message: 'overloaded' }],
      [{ kind: 'error', message: 'overloaded' }],
    ]);
    const events = await collect(
      withRetry(client, { maxAttempts: 2 }).chat(REQ, new AbortController().signal),
    );
    expect(calls()).toBe(2);
    // After the final attempt the transient error surfaces (no further retry).
    expect(events).toEqual([{ kind: 'error', message: 'overloaded' }]);
  });

  it('honors a custom isTransient predicate', async () => {
    const { client, calls } = scriptedClient([
      [{ kind: 'error', message: 'CUSTOM_RETRY please' }],
      [
        { kind: 'text', text: 'ok' },
        { kind: 'usage', usage: { promptTokens: 1, outputTokens: 1 } },
      ],
    ]);
    const events = await collect(
      withRetry(client, { isTransient: (m) => m.includes('CUSTOM_RETRY') }).chat(
        REQ,
        new AbortController().signal,
      ),
    );
    expect(calls()).toBe(2);
    expect(events.find((e) => e.kind === 'text')).toEqual({ kind: 'text', text: 'ok' });
  });

  it('synthesizes a terminal usage event when the inner client emits none', async () => {
    const { client } = scriptedClient([[{ kind: 'text', text: 'done' }]]);
    const events = await collect(withRetry(client).chat(REQ, new AbortController().signal));
    expect(events).toEqual([
      { kind: 'text', text: 'done' },
      { kind: 'usage', usage: { promptTokens: 0, outputTokens: 0 } },
    ]);
  });

  it('forwards id and supportsTools from the wrapped client', () => {
    const { client } = scriptedClient([[]]);
    const wrapped = withRetry(client);
    expect(wrapped.id).toBe('fake:m');
    expect(wrapped.supportsTools).toBe(true);
  });
});
