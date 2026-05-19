/**
 * Tests for `parseToolCalls`. Same buffering invariant as
 * `splitThinking` (partial tags resolve across token boundaries) plus
 * JSON body parsing on close.
 */

import { describe, expect, test } from 'bun:test';
import { parseToolCalls } from '../src/parse-tool-calls.js';
import type { EngineEvent } from '../src/types.js';

async function* fromTokens(chunks: string[]): AsyncIterable<EngineEvent> {
  for (const text of chunks) yield { kind: 'token', text };
}

async function collectMerged(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const raw: EngineEvent[] = [];
  for await (const e of it) raw.push(e);
  const merged: EngineEvent[] = [];
  for (const e of raw) {
    const last = merged[merged.length - 1];
    if (last && e.kind === 'token' && last.kind === 'token') {
      (last as { text: string }).text += e.text;
    } else {
      merged.push({ ...e });
    }
  }
  return merged;
}

const fixedId = () => 'tc_test_id';

describe('parseToolCalls', () => {
  test('passes through a stream with no tool-call envelope', async () => {
    const out = await collectMerged(
      parseToolCalls(fromTokens(['the weather in tokyo ', 'is sunny']), { generateId: fixedId }),
    );
    expect(out).toEqual([{ kind: 'token', text: 'the weather in tokyo is sunny' }]);
  });

  test('splits a complete tool_call envelope within one token', async () => {
    const out = await collectMerged(
      parseToolCalls(
        fromTokens([
          'Let me check. <tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call> Done.',
        ]),
        { generateId: fixedId },
      ),
    );
    expect(out).toEqual([
      { kind: 'token', text: 'Let me check. ' },
      { kind: 'tool_call', id: 'tc_test_id', name: 'get_weather', args: { city: 'Tokyo' } },
      { kind: 'token', text: ' Done.' },
    ]);
  });

  test('handles open tag split across token boundaries', async () => {
    const out = await collectMerged(
      parseToolCalls(
        fromTokens([
          'hello <tool_c',
          'all>{"name":"add","arguments":{"a":17,"b":28}}</tool_call> bye',
        ]),
        { generateId: fixedId },
      ),
    );
    expect(out).toEqual([
      { kind: 'token', text: 'hello ' },
      { kind: 'tool_call', id: 'tc_test_id', name: 'add', args: { a: 17, b: 28 } },
      { kind: 'token', text: ' bye' },
    ]);
  });

  test('handles close tag split across token boundaries', async () => {
    const out = await collectMerged(
      parseToolCalls(
        fromTokens(['<tool_call>{"name":"search","arguments":{"q":"webgpu"}}</tool_', 'call> ok']),
        { generateId: fixedId },
      ),
    );
    expect(out).toEqual([
      { kind: 'tool_call', id: 'tc_test_id', name: 'search', args: { q: 'webgpu' } },
      { kind: 'token', text: ' ok' },
    ]);
  });

  test('accepts `parameters` as an alias for `arguments` (charitable parse)', async () => {
    const out = await collectMerged(
      parseToolCalls(
        fromTokens(['<tool_call>{"name":"add","parameters":{"a":1,"b":2}}</tool_call>']),
        { generateId: fixedId },
      ),
    );
    expect(out).toEqual([
      { kind: 'tool_call', id: 'tc_test_id', name: 'add', args: { a: 1, b: 2 } },
    ]);
  });

  test('emits {_raw} when body is not valid JSON', async () => {
    const out = await collectMerged(
      parseToolCalls(fromTokens(['<tool_call>not even close to json</tool_call>']), {
        generateId: fixedId,
      }),
    );
    expect(out).toEqual([
      { kind: 'tool_call', id: 'tc_test_id', name: '', args: { _raw: 'not even close to json' } },
    ]);
  });

  test('handles two consecutive tool_call envelopes', async () => {
    const out = await collectMerged(
      parseToolCalls(
        fromTokens([
          '<tool_call>{"name":"a","arguments":{}}</tool_call>',
          ' middle ',
          '<tool_call>{"name":"b","arguments":{"x":1}}</tool_call>',
        ]),
        { generateId: fixedId },
      ),
    );
    expect(out).toEqual([
      { kind: 'tool_call', id: 'tc_test_id', name: 'a', args: {} },
      { kind: 'token', text: ' middle ' },
      { kind: 'tool_call', id: 'tc_test_id', name: 'b', args: { x: 1 } },
    ]);
  });

  test('flushes unclosed envelope as best-effort tool_call', async () => {
    // Model hit max_new_tokens mid-envelope. Parse what we have.
    const out = await collectMerged(
      parseToolCalls(fromTokens(['<tool_call>{"name":"get_weather","arguments":{"city":"To']), {
        generateId: fixedId,
      }),
    );
    expect(out).toEqual([
      {
        kind: 'tool_call',
        id: 'tc_test_id',
        name: '',
        args: { _raw: '{"name":"get_weather","arguments":{"city":"To' },
      },
    ]);
  });

  test('forwards thinking/usage/error events unchanged', async () => {
    async function* mixed(): AsyncIterable<EngineEvent> {
      yield { kind: 'thinking', text: 'reasoning' };
      yield { kind: 'token', text: '<tool_call>{"name":"a","arguments":{}}</tool_call>' };
      yield { kind: 'usage', promptTokens: 3, outputTokens: 5, decodeMs: 100 };
    }
    const out = await collectMerged(parseToolCalls(mixed(), { generateId: fixedId }));
    expect(out).toEqual([
      { kind: 'thinking', text: 'reasoning' },
      { kind: 'tool_call', id: 'tc_test_id', name: 'a', args: {} },
      { kind: 'usage', promptTokens: 3, outputTokens: 5, decodeMs: 100 },
    ]);
  });

  test('empty input yields nothing', async () => {
    const out = await collectMerged(parseToolCalls(fromTokens([])));
    expect(out).toEqual([]);
  });
});
