/**
 * Cross-chunk accumulation of Gemini streamed function calls.
 *
 * Gemini's `streamGenerateContent` re-sends the accumulating
 * `candidates[0].content.parts[]` on every SSE chunk, so a single
 * logical function call surfaces many times: first name-only with empty
 * args, then with its complete args, with `thoughtSignature` sometimes
 * landing on a still-later chunk. The parser must merge those re-sends
 * into exactly one `tool_call` per logical call — with complete args and
 * the signature — rather than emitting one event per chunk with a fresh
 * random id and partial/empty args.
 *
 * These tests pin that contract (see docs request from piebox:
 * "N calls -> N events; full args; signatures present").
 */
import { describe, expect, it } from 'bun:test';
import {
  buildGeminiRequest,
  geminiEventsFromResponse,
  geminiProvider,
} from '../src/providers/gemini';
import type { InferenceEvent, NormalizedRequest } from '../src/types';

function makeSseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** A single Gemini stream chunk wrapping one candidate's parts. */
function chunk(parts: unknown[], finishReason?: string): unknown {
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
  };
}

const USAGE = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };

async function collect(it: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function toolCalls(events: InferenceEvent[]) {
  return events.filter((e) => e.kind === 'tool_call') as Extract<
    InferenceEvent,
    { kind: 'tool_call' }
  >[];
}

describe('geminiEventsFromResponse — function-call accumulation', () => {
  it('collapses a call re-sent across chunks into one event with complete args', async () => {
    // One logical `bash` call: empty-arg partial, then the complete args
    // re-sent identically several times (the ~10x duplication piebox saw).
    const fc = (args: Record<string, unknown>) => ({ functionCall: { name: 'bash', args } });
    const events = await collect(
      geminiEventsFromResponse(
        makeSseResponse([
          chunk([fc({})]),
          chunk([fc({ command: 'npm create vite' })]),
          chunk([fc({ command: 'npm create vite' })]),
          chunk([fc({ command: 'npm create vite' })], 'STOP'),
          USAGE,
        ]),
      ),
    );

    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('bash');
    expect(calls[0].args).toEqual({ command: 'npm create vite' });
    // Stable, deterministic id — not a per-chunk random value.
    expect(calls[0].callId).toBe('gem_0');
  });

  it('never emits an empty-arg partial for a required-arg call', async () => {
    const events = await collect(
      geminiEventsFromResponse(
        makeSseResponse([
          chunk([{ functionCall: { name: 'write', args: {} } }]),
          chunk(
            [{ functionCall: { name: 'write', args: { path: 'a.ts', contents: 'x' } } }],
            'STOP',
          ),
          USAGE,
        ]),
      ),
    );
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ path: 'a.ts', contents: 'x' });
    // No event ever carried `{}` to the consumer.
    expect(calls.some((c) => Object.keys(c.args as object).length === 0)).toBe(false);
  });

  it('captures a thoughtSignature that arrives on a later chunk than the args', async () => {
    const events = await collect(
      geminiEventsFromResponse(
        makeSseResponse([
          // args first, no signature yet
          chunk([{ functionCall: { name: 'bash', args: { command: 'ls' } } }]),
          // signature lands on a later re-send
          chunk(
            [
              {
                functionCall: { name: 'bash', args: { command: 'ls' } },
                thoughtSignature: 'SIG_ABC',
              },
            ],
            'STOP',
          ),
          USAGE,
        ]),
      ),
    );
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].signature).toBe('SIG_ABC');
    expect(calls[0].args).toEqual({ command: 'ls' });
  });

  it('attributes each part’s signature to its own slot when several are signed', async () => {
    // Generic per-slot attribution: whatever signature lands on a part is
    // captured for that part's call. (Real Gemini usually signs only the
    // first parallel call — covered by the next test — but the merge must
    // not cross-wire signatures regardless of how many parts carry one.)
    const parts = [
      { text: 'Running two commands.' },
      { functionCall: { name: 'bash', args: { command: 'mkdir src' } }, thoughtSignature: 'SIG_A' },
      { functionCall: { name: 'bash', args: { command: 'npm i' } }, thoughtSignature: 'SIG_B' },
    ];
    const events = await collect(
      geminiEventsFromResponse(
        makeSseResponse([
          chunk(parts),
          // re-send with the leading text part dropped — the call's raw
          // array index shifts, its ordinal does not.
          chunk(
            [
              {
                functionCall: { name: 'bash', args: { command: 'mkdir src' } },
                thoughtSignature: 'SIG_A',
              },
              {
                functionCall: { name: 'bash', args: { command: 'npm i' } },
                thoughtSignature: 'SIG_B',
              },
            ],
            'STOP',
          ),
          USAGE,
        ]),
      ),
    );
    const calls = toolCalls(events);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      callId: 'gem_0',
      args: { command: 'mkdir src' },
      signature: 'SIG_A',
    });
    expect(calls[1]).toMatchObject({
      callId: 'gem_1',
      args: { command: 'npm i' },
      signature: 'SIG_B',
    });
  });

  it('handles the real Gemini-3 shape: only the first parallel call is signed', async () => {
    // Documented Gemini-3 behavior for parallel calls: the thoughtSignature
    // rides only the FIRST functionCall part; the rest are unsigned. The
    // unsigned second call must NOT inherit the first's signature.
    const events = await collect(
      geminiEventsFromResponse(
        makeSseResponse([
          chunk(
            [
              {
                functionCall: { name: 'bash', args: { command: 'a' } },
                thoughtSignature: 'SIG_FIRST',
              },
              { functionCall: { name: 'bash', args: { command: 'b' } } },
            ],
            'STOP',
          ),
          USAGE,
        ]),
      ),
    );
    const calls = toolCalls(events);
    expect(calls).toHaveLength(2);
    expect(calls[0].signature).toBe('SIG_FIRST');
    expect(calls[1].signature).toBeUndefined();
  });

  it('does not collapse two parallel calls that share name AND args', async () => {
    // Distinct logical calls can be byte-identical; correlation is by
    // ordinal position, not content, so both survive.
    const dup = { functionCall: { name: 'bash', args: { command: 'ls' } } };
    const events = await collect(
      geminiEventsFromResponse(
        makeSseResponse([chunk([dup, dup]), chunk([dup, dup], 'STOP'), USAGE]),
      ),
    );
    const calls = toolCalls(events);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.callId)).toEqual(['gem_0', 'gem_1']);
  });

  it('emits a no-arg call exactly once with empty args', async () => {
    const events = await collect(
      geminiEventsFromResponse(
        makeSseResponse([
          chunk([{ functionCall: { name: 'list_files', args: {} } }]),
          chunk([{ functionCall: { name: 'list_files', args: {} } }], 'STOP'),
          USAGE,
        ]),
      ),
    );
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'list_files', args: {} });
  });

  it('still handles a single complete chunk (no re-send)', async () => {
    const events = await collect(
      geminiEventsFromResponse(
        makeSseResponse([
          chunk([{ functionCall: { name: 'bash', args: { command: 'pwd' } } }], 'STOP'),
          USAGE,
        ]),
      ),
    );
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ command: 'pwd' });
  });

  it('passes text deltas through once and flushes calls after the text', async () => {
    const events = await collect(
      geminiEventsFromResponse(
        makeSseResponse([
          chunk([{ text: 'Scaffolding ' }]),
          chunk([{ text: 'the app.' }]),
          chunk([{ functionCall: { name: 'bash', args: {} } }]),
          chunk([{ functionCall: { name: 'bash', args: { command: 'npm create vite' } } }], 'STOP'),
          USAGE,
        ]),
      ),
    );
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { chunk: string }).chunk);
    expect(text).toEqual(['Scaffolding ', 'the app.']); // not duplicated
    const calls = toolCalls(events);
    expect(calls).toHaveLength(1);
    // All tool_calls come after all text (matches the OAI/Anthropic providers).
    const lastText = events.findLastIndex((e) => e.kind === 'text');
    const firstCall = events.findIndex((e) => e.kind === 'tool_call');
    expect(firstCall).toBeGreaterThan(lastText);
  });

  it('yields exactly N events for an N-call turn flowing through geminiProvider', async () => {
    // End-to-end through the retry wrapper to confirm the flush survives
    // the provider layer that piebox actually consumes.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      makeSseResponse([
        chunk([{ text: 'go' }]),
        chunk([
          { functionCall: { name: 'write', args: { path: 'a.ts' } } },
          { functionCall: { name: 'bash', args: { command: 'tsc' } } },
        ]),
        chunk(
          [
            { functionCall: { name: 'write', args: { path: 'a.ts' } } },
            { functionCall: { name: 'bash', args: { command: 'tsc' } } },
          ],
          'STOP',
        ),
        USAGE,
      ])) as typeof fetch;
    try {
      const req: NormalizedRequest = {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        messages: [{ role: 'user', text: 'build it' }],
        tools: [],
        apiKey: 'sk-test',
      };
      const calls = toolCalls(await collect(geminiProvider(req)));
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ name: 'write', args: { path: 'a.ts' } });
      expect(calls[1]).toMatchObject({ name: 'bash', args: { command: 'tsc' } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Gemini signature replay round-trip (the request’s "confirm" item)', () => {
  it('replays a two-parallel-call turn with signatures as functionCall siblings, in order', async () => {
    // Capture two parallel calls — first signed, per the real Gemini-3 shape.
    const captured = toolCalls(
      await collect(
        geminiEventsFromResponse(
          makeSseResponse([
            chunk(
              [
                {
                  functionCall: { name: 'write', args: { path: 'a.ts', contents: 'x' } },
                  thoughtSignature: 'SIG_A',
                },
                { functionCall: { name: 'bash', args: { command: 'tsc' } } },
              ],
              'STOP',
            ),
            USAGE,
          ]),
        ),
      ),
    );
    expect(captured).toHaveLength(2);

    // Feed them back as an assistant turn and rebuild the upstream request.
    const req: NormalizedRequest = {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      messages: [
        { role: 'user', text: 'scaffold it' },
        {
          role: 'assistant',
          toolCalls: captured.map((c) => ({
            callId: c.callId,
            name: c.name,
            args: c.args,
            ...(c.signature ? { signature: c.signature } : {}),
          })),
        },
      ],
      tools: [],
      apiKey: 'sk-test',
    };
    const body = JSON.parse(await buildGeminiRequest(req).text()) as {
      contents: { role: string; parts: Record<string, unknown>[] }[];
    };

    const modelTurn = body.contents.find((c) => c.role === 'model');
    expect(modelTurn).toBeDefined();
    expect(modelTurn?.parts).toHaveLength(2);
    // thoughtSignature is a SIBLING of functionCall (nesting it under
    // functionCall is the INVALID_ARGUMENT 400 the source warns about),
    // full args are present, and order is preserved. toEqual is exhaustive,
    // so it would fail if the signature were nested or a call reordered.
    expect(modelTurn?.parts[0]).toEqual({
      functionCall: { name: 'write', args: { path: 'a.ts', contents: 'x' } },
      thoughtSignature: 'SIG_A',
    });
    // The unsigned second call replays unsigned, still in position 1.
    expect(modelTurn?.parts[1]).toEqual({
      functionCall: { name: 'bash', args: { command: 'tsc' } },
    });
  });
});
