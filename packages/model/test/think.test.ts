/**
 * Tests for `splitThinking`. The implementation buffers up to
 * `tag.length - 1` bytes between yields so partial tags split across
 * token boundaries resolve correctly — that means token text gets
 * re-chunked through the wrapper. Tests assert on the meaningful
 * invariants (content order + kind classification), not on chunk
 * boundaries — those are an implementation detail of the safety
 * buffer.
 */

import { describe, expect, test } from 'bun:test';
import { splitThinking } from '../src/think.js';
import type { EngineEvent } from '../src/types.js';

async function* fromTokens(chunks: string[]): AsyncIterable<EngineEvent> {
  for (const text of chunks) yield { kind: 'token', text };
}

/**
 * Merge consecutive same-kind events into one so tests assert on
 * "what came out" rather than "how it was chunked." Non-token/-thinking
 * events forward unchanged.
 */
async function collectMerged(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const raw: EngineEvent[] = [];
  for await (const e of it) raw.push(e);
  const merged: EngineEvent[] = [];
  for (const e of raw) {
    const last = merged[merged.length - 1];
    if (last && (e.kind === 'token' || e.kind === 'thinking') && last.kind === e.kind) {
      (last as { text: string }).text += e.text;
    } else {
      merged.push({ ...e });
    }
  }
  return merged;
}

describe('splitThinking', () => {
  test('passes through a stream with no thinking tags', async () => {
    const out = await collectMerged(splitThinking(fromTokens(['hello ', 'world'])));
    expect(out).toEqual([{ kind: 'token', text: 'hello world' }]);
  });

  test('splits a complete <think>…</think> block within one token', async () => {
    const out = await collectMerged(
      splitThinking(fromTokens(['before <think>reasoning</think> after'])),
    );
    expect(out).toEqual([
      { kind: 'token', text: 'before ' },
      { kind: 'thinking', text: 'reasoning' },
      { kind: 'token', text: ' after' },
    ]);
  });

  test('handles open tag split across token boundaries', async () => {
    const out = await collectMerged(
      splitThinking(fromTokens(['hello <th', 'ink>thoughts</think> bye'])),
    );
    expect(out).toEqual([
      { kind: 'token', text: 'hello ' },
      { kind: 'thinking', text: 'thoughts' },
      { kind: 'token', text: ' bye' },
    ]);
  });

  test('handles close tag split across token boundaries', async () => {
    const out = await collectMerged(
      splitThinking(fromTokens(['<think>some thinking</thi', 'nk> output'])),
    );
    expect(out).toEqual([
      { kind: 'thinking', text: 'some thinking' },
      { kind: 'token', text: ' output' },
    ]);
  });

  test('handles a thinking block split across many tiny chunks', async () => {
    const out = await collectMerged(
      splitThinking(
        fromTokens([
          '<',
          't',
          'h',
          'i',
          'n',
          'k',
          '>',
          'a',
          'b',
          '<',
          '/',
          't',
          'h',
          'i',
          'n',
          'k',
          '>',
        ]),
      ),
    );
    expect(out).toEqual([{ kind: 'thinking', text: 'ab' }]);
  });

  test('handles two consecutive thinking blocks', async () => {
    const out = await collectMerged(
      splitThinking(fromTokens(['<think>one</think> mid <think>two</think> end'])),
    );
    expect(out).toEqual([
      { kind: 'thinking', text: 'one' },
      { kind: 'token', text: ' mid ' },
      { kind: 'thinking', text: 'two' },
      { kind: 'token', text: ' end' },
    ]);
  });

  test('flushes unclosed thinking as terminal thinking event', async () => {
    // Model hit max_new_tokens mid-block. Dropping the residual would
    // hide what the model was doing — better to surface it as
    // thinking and let the consumer decide.
    const out = await collectMerged(splitThinking(fromTokens(['<think>unclosed reasoning'])));
    expect(out).toEqual([{ kind: 'thinking', text: 'unclosed reasoning' }]);
  });

  test('forwards usage events unchanged', async () => {
    async function* mixed(): AsyncIterable<EngineEvent> {
      yield { kind: 'token', text: '<think>a</think>b' };
      yield { kind: 'usage', promptTokens: 5, outputTokens: 7, decodeMs: 123 };
    }
    const out = await collectMerged(splitThinking(mixed()));
    // Note: `b` flushes at source end-of-stream, AFTER the usage event
    // forwarded mid-stream. Buffer can't drain on non-token-event
    // arrival because remaining bytes might still be a partial tag
    // prefix once more tokens land.
    expect(out).toEqual([
      { kind: 'thinking', text: 'a' },
      { kind: 'usage', promptTokens: 5, outputTokens: 7, decodeMs: 123 },
      { kind: 'token', text: 'b' },
    ]);
  });

  test('forwards error events unchanged', async () => {
    async function* erroring(): AsyncIterable<EngineEvent> {
      yield { kind: 'token', text: '<think>partial' };
      yield { kind: 'error', message: 'oops', recoverable: false };
    }
    const out = await collectMerged(splitThinking(erroring()));
    // Error forwarded immediately; residual `partial` (in `inside`
    // mode) flushes as thinking at source end-of-stream.
    expect(out).toEqual([
      { kind: 'error', message: 'oops', recoverable: false },
      { kind: 'thinking', text: 'partial' },
    ]);
  });

  test('respects custom open/close tags', async () => {
    const out = await collectMerged(
      splitThinking(fromTokens(['x[REASON]y[/REASON]z']), {
        openTag: '[REASON]',
        closeTag: '[/REASON]',
      }),
    );
    expect(out).toEqual([
      { kind: 'token', text: 'x' },
      { kind: 'thinking', text: 'y' },
      { kind: 'token', text: 'z' },
    ]);
  });

  test('rejects empty open tag when implicitOpen is false', () => {
    expect(() => {
      const gen = splitThinking(fromTokens([]), { openTag: '' })[Symbol.asyncIterator]();
      return gen.next();
    }).toThrow(/non-empty/);
  });

  test('rejects empty close tag', () => {
    expect(() => {
      const gen = splitThinking(fromTokens([]), {
        closeTag: '',
        implicitOpen: true,
      })[Symbol.asyncIterator]();
      return gen.next();
    }).toThrow(/closeTag/);
  });

  test('empty input yields nothing', async () => {
    const out = await collectMerged(splitThinking(fromTokens([])));
    expect(out).toEqual([]);
  });

  // ── implicitOpen (Gemma 4 channel format) ─────────────────────────

  test('implicitOpen treats initial output as thinking', async () => {
    const out = await collectMerged(
      splitThinking(fromTokens(['reasoning steps here<channel|>the answer']), {
        closeTag: '<channel|>',
        implicitOpen: true,
      }),
    );
    expect(out).toEqual([
      { kind: 'thinking', text: 'reasoning steps here' },
      { kind: 'token', text: 'the answer' },
    ]);
  });

  test('implicitOpen with no close tag flushes residual as thinking', async () => {
    // Model hit max_new_tokens before emitting the close marker.
    const out = await collectMerged(
      splitThinking(fromTokens(['just thinking, never closed']), {
        closeTag: '<channel|>',
        implicitOpen: true,
      }),
    );
    expect(out).toEqual([{ kind: 'thinking', text: 'just thinking, never closed' }]);
  });

  test('implicitOpen with close-tag-only stream is supported', async () => {
    // Edge case: model emits the close marker as its very first token.
    const out = await collectMerged(
      splitThinking(fromTokens(['<channel|>answer only']), {
        closeTag: '<channel|>',
        implicitOpen: true,
      }),
    );
    expect(out).toEqual([{ kind: 'token', text: 'answer only' }]);
  });

  // ── stripTokens (Gemma 4 <turn|> leak) ────────────────────────────

  test('stripTokens removes literal substrings from token events', async () => {
    const out = await collectMerged(
      splitThinking(fromTokens(['<channel|>the answer<turn|>']), {
        closeTag: '<channel|>',
        implicitOpen: true,
        stripTokens: ['<turn|>'],
      }),
    );
    expect(out).toEqual([{ kind: 'token', text: 'the answer' }]);
  });

  test('stripTokens does not affect thinking content', async () => {
    // The strip list is applied to `token` events only — content
    // inside thinking is preserved verbatim.
    const out = await collectMerged(
      splitThinking(
        fromTokens(['<turn|>inside still has it<channel|>but answer is clean<turn|>']),
        {
          closeTag: '<channel|>',
          implicitOpen: true,
          stripTokens: ['<turn|>'],
        },
      ),
    );
    expect(out).toEqual([
      { kind: 'thinking', text: '<turn|>inside still has it' },
      { kind: 'token', text: 'but answer is clean' },
    ]);
  });
});
