/**
 * Retry behavior for `geminiProvider`. Exercises the three retryable
 * failure modes against a stubbed `fetch`:
 *
 *   - MALFORMED_FUNCTION_CALL  — Gemini's own validation rejects its
 *     own function call.
 *   - finishReason=STOP, no output — model thought and said nothing.
 *   - finishReason=none — stream truncated before any finishReason.
 *
 * Deterministic failures (SAFETY / RECITATION / MAX_TOKENS) are NOT
 * retried; one of those is also asserted to fall straight through.
 *
 * The transport is `global.fetch`, which we patch per test and
 * restore in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { geminiProvider } from '../src/providers/gemini';
import type { InferenceEvent, NormalizedRequest } from '../src/types';

function makeSseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function baseReq(): NormalizedRequest {
  return {
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [],
    apiKey: 'sk-test',
  };
}

async function collect(it: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('geminiProvider retry', () => {
  let originalFetch: typeof fetch;
  let calls: number;
  let responses: Response[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = 0;
    responses = [];
    globalThis.fetch = (async (..._args: unknown[]) => {
      const res = responses[calls++];
      if (!res) throw new Error(`unexpected fetch call #${calls}`);
      return res;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('retries on thought-only finishReason=STOP and recovers', async () => {
    responses = [
      // 1st call: thinking + STOP, no visible output.
      makeSseResponse([
        {
          candidates: [
            {
              content: { parts: [{ text: 'pondering…', thought: true }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
      // 2nd call: real text + usage.
      makeSseResponse([
        {
          candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
        },
        { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
      ]),
    ];

    const events = await collect(geminiProvider(baseReq()));
    expect(calls).toBe(2);
    const errors = events.filter((e) => e.kind === 'error');
    expect(errors).toEqual([]); // first-attempt error was swallowed
    expect(events.find((e) => e.kind === 'text')).toEqual({
      kind: 'text',
      chunk: 'hello',
    });
  });

  it('retries on truncated stream (finishReason=none)', async () => {
    responses = [
      // 1st call: thinking only, NO finishReason — stream truncated.
      makeSseResponse([
        {
          candidates: [{ content: { parts: [{ text: 'starting', thought: true }] } }],
        },
      ]),
      makeSseResponse([
        {
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        },
        { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } },
      ]),
    ];

    const events = await collect(geminiProvider(baseReq()));
    expect(calls).toBe(2);
    expect(events.filter((e) => e.kind === 'error')).toEqual([]);
    expect(events.find((e) => e.kind === 'text')?.kind).toBe('text');
  });

  it('retries on MALFORMED_FUNCTION_CALL and recovers', async () => {
    responses = [
      // The current adapter surfaces MALFORMED_FUNCTION_CALL via the
      // "no output" path when the parsed finishReason carries that
      // value — match that surface so the retry trigger fires.
      makeSseResponse([
        {
          candidates: [
            {
              content: { parts: [{ text: 't', thought: true }] },
              finishReason: 'MALFORMED_FUNCTION_CALL',
            },
          ],
        },
      ]),
      makeSseResponse([
        {
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        },
        { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } },
      ]),
    ];

    const events = await collect(geminiProvider(baseReq()));
    expect(calls).toBe(2);
    expect(events.filter((e) => e.kind === 'error')).toEqual([]);
  });

  it('does NOT retry on finishReason=SAFETY — surfaces the error immediately', async () => {
    responses = [
      makeSseResponse([
        {
          candidates: [
            {
              content: { parts: [{ text: 'thinking', thought: true }] },
              finishReason: 'SAFETY',
            },
          ],
        },
      ]),
    ];

    const events = await collect(geminiProvider(baseReq()));
    expect(calls).toBe(1); // no retry
    const error = events.find((e) => e.kind === 'error');
    expect(error?.kind).toBe('error');
    if (error?.kind === 'error') {
      expect(error.message).toContain('finishReason=SAFETY');
    }
  });

  it('gives up after MAX_GEMINI_ATTEMPTS attempts on persistent retryable failure', async () => {
    // Three thought-only STOPs in a row.
    const failure = () =>
      makeSseResponse([
        {
          candidates: [
            {
              content: { parts: [{ text: 'still thinking', thought: true }] },
              finishReason: 'STOP',
            },
          ],
        },
      ]);
    responses = [failure(), failure(), failure()];

    const events = await collect(geminiProvider(baseReq()));
    expect(calls).toBe(3);
    const error = events.find((e) => e.kind === 'error');
    expect(error?.kind).toBe('error');
    if (error?.kind === 'error') {
      expect(error.message).toContain('finishReason=STOP');
    }
  });
});
