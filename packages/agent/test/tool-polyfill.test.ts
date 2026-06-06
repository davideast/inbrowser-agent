import { describe, expect, test } from 'bun:test';
import type { ChatEvent, ChatRequest, LlmClient, ToolDeclaration } from '../src/index.js';
import { encodeHistory } from '../src/tool-polyfill/encode-history.js';
import { parseToolCallStream } from '../src/tool-polyfill/parse-stream.js';
import { coerceArgs } from '../src/tool-polyfill/validate.js';
import { withToolUsePolyfill } from '../src/tool-polyfill/with-polyfill.js';

// ── helpers ──────────────────────────────────────────────────────────────────

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function stubLlm(script: ChatEvent[]): LlmClient {
  return {
    id: 'stub',
    supportsTools: false,
    async *chat(_req: ChatRequest, _signal: AbortSignal): AsyncIterable<ChatEvent> {
      for (const ev of script) yield ev;
    },
  };
}

const TURN_COMPLETE: Extract<ChatEvent, { kind: 'turn_complete' }> = {
  kind: 'turn_complete',
  usage: { promptTokens: 10, completionTokens: 5 },
  details: { requestedModel: 'stub' },
};

const ADD_TOOL: ToolDeclaration = {
  name: 'add',
  description: 'Add two numbers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
};

const WEATHER_TOOL: ToolDeclaration = {
  name: 'get_weather',
  description: 'Get current weather',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

// ── coerceArgs ────────────────────────────────────────────────────────────────

describe('coerceArgs', () => {
  test('valid JSON object → used as-is', () => {
    const r = coerceArgs('{"a":1,"b":2}', ADD_TOOL);
    expect(r).toEqual({ ok: true, args: { a: 1, b: 2 } });
  });

  test('key=value lines → flat object with type coercion', () => {
    const r = coerceArgs('a=1\nb=2', ADD_TOOL);
    expect(r).toEqual({ ok: true, args: { a: 1, b: 2 } });
  });

  test('key: value lines → flat object', () => {
    const r = coerceArgs('city: Tokyo', WEATHER_TOOL);
    expect(r).toEqual({ ok: true, args: { city: 'Tokyo' } });
  });

  test('single bare value for single-param tool → wrapped', () => {
    const r = coerceArgs('Tokyo', WEATHER_TOOL);
    expect(r).toEqual({ ok: true, args: { city: 'Tokyo' } });
  });

  test('unparseable → ok: false', () => {
    const r = coerceArgs('{not json at all', ADD_TOOL);
    expect(r.ok).toBe(false);
  });
});

// ── encodeHistory ─────────────────────────────────────────────────────────────

describe('encodeHistory', () => {
  test('pass-through for system/user/plain-assistant messages', () => {
    const msgs = [
      { role: 'system' as const, text: 'You are a helper.' },
      { role: 'user' as const, text: 'Hello' },
      { role: 'assistant' as const, text: 'Hi!' },
    ];
    expect(encodeHistory(msgs)).toEqual(msgs);
  });

  test('assistant with toolCalls → text envelope', () => {
    const result = encodeHistory([
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ callId: 'c1', name: 'add', args: { a: 3, b: 4 } }],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('assistant');
    expect(result[0]!.text).toContain('<tool_call name="add">');
    expect(result[0]!.text).toContain('"a":3');
  });

  test('tool role → user text envelope', () => {
    const result = encodeHistory([
      { role: 'tool', text: '', callId: 'c1', name: 'add', resultJson: '7' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(result[0]!.text).toContain('<tool_result name="add">7</tool_result>');
  });

  test('assistant text preserved alongside tool envelopes', () => {
    const result = encodeHistory([
      {
        role: 'assistant',
        text: 'Let me calculate that.',
        toolCalls: [{ callId: 'c1', name: 'add', args: { a: 1, b: 2 } }],
      },
    ]);
    expect(result[0]!.text).toMatch(/Let me calculate that\.\n<tool_call/);
  });
});

// ── parseToolCallStream ───────────────────────────────────────────────────────

async function parseText(text: string, tools: ToolDeclaration[]): Promise<ChatEvent[]> {
  async function* src(): AsyncIterable<ChatEvent> {
    yield { kind: 'text', chunk: text };
    yield TURN_COMPLETE;
  }
  return collect(parseToolCallStream(src(), tools));
}

describe('parseToolCallStream', () => {
  test('XML tool_call parsed → tool_call event emitted', async () => {
    const events = await parseText(
      '<tool_call name="add">{"a":1,"b":2}</tool_call>',
      [ADD_TOOL],
    );
    const tc = events.find((e) => e.kind === 'tool_call');
    expect(tc).toBeDefined();
    expect((tc as Extract<ChatEvent, { kind: 'tool_call' }>).name).toBe('add');
    expect((tc as Extract<ChatEvent, { kind: 'tool_call' }>).args).toEqual({ a: 1, b: 2 });
  });

  test('fenced JSON parsed → tool_call event', async () => {
    const events = await parseText(
      '```json\n{"tool":"add","args":{"a":17,"b":28}}\n```',
      [ADD_TOOL],
    );
    const tc = events.find((e) => e.kind === 'tool_call');
    expect(tc).toBeDefined();
    expect((tc as Extract<ChatEvent, { kind: 'tool_call' }>).name).toBe('add');
  });

  test('text before and after envelope is forwarded', async () => {
    const events = await parseText(
      'Let me call it.\n<tool_call name="add">{"a":1,"b":2}</tool_call>\nDone.',
      [ADD_TOOL],
    );
    const texts = events.filter((e) => e.kind === 'text').map((e) => (e as { kind: 'text'; chunk: string }).chunk);
    const combined = texts.join('');
    expect(combined).toContain('Let me call it.');
    expect(combined).toContain('Done.');
    expect(events.some((e) => e.kind === 'tool_call')).toBe(true);
  });

  test('unknown tool name → error event', async () => {
    const events = await parseText('<tool_call name="missing">{"x":1}</tool_call>', [ADD_TOOL]);
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });

  test('malformed args best-effort → error event then continues', async () => {
    const events = await parseText('<tool_call name="add">{bad json</tool_call>', [ADD_TOOL]);
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });

  test('malformed args reject → stop after error', async () => {
    async function* src(): AsyncIterable<ChatEvent> {
      yield { kind: 'text', chunk: '<tool_call name="add">{bad</tool_call> more text' };
      yield TURN_COMPLETE;
    }
    const events = await collect(parseToolCallStream(src(), [ADD_TOOL], { malformedArgsStrategy: 'reject' }));
    // Should have an error and NOT have 'more text' as a text event
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    const textAfter = events
      .filter((e) => e.kind === 'text')
      .map((e) => (e as { kind: 'text'; chunk: string }).chunk)
      .join('');
    expect(textAfter).not.toContain('more text');
  });

  test('turn_complete passes through', async () => {
    const events = await parseText('plain text', [ADD_TOOL]);
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(true);
  });

  test('thinking events pass through immediately', async () => {
    async function* src(): AsyncIterable<ChatEvent> {
      yield { kind: 'thinking', chunk: 'I should use add...' };
      yield { kind: 'text', chunk: '<tool_call name="add">{"a":1,"b":2}</tool_call>' };
      yield TURN_COMPLETE;
    }
    const events = await collect(parseToolCallStream(src(), [ADD_TOOL]));
    expect(events[0]).toMatchObject({ kind: 'thinking' });
    expect(events.some((e) => e.kind === 'tool_call')).toBe(true);
  });
});

// ── withToolUsePolyfill ───────────────────────────────────────────────────────

const BASE_REQ: ChatRequest = {
  messages: [
    { role: 'system', text: 'You are a math helper.' },
    { role: 'user', text: 'What is 17 + 28?' },
  ],
  tools: [ADD_TOOL],
  toolUseEnabled: true,
};

describe('withToolUsePolyfill', () => {
  test('supportsTools is true on the wrapper', () => {
    const wrapped = withToolUsePolyfill(stubLlm([]));
    expect(wrapped.supportsTools).toBe(true);
  });

  test('id is preserved from inner client', () => {
    const wrapped = withToolUsePolyfill(stubLlm([]));
    expect(wrapped.id).toBe('stub');
  });

  test('pass-through when toolUseEnabled: false', async () => {
    const inner = stubLlm([{ kind: 'text', chunk: 'hello' }, TURN_COMPLETE]);
    const wrapped = withToolUsePolyfill(inner);
    const req: ChatRequest = { ...BASE_REQ, toolUseEnabled: false };
    const events = await collect(wrapped.chat(req, new AbortController().signal));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'text', chunk: 'hello' });
  });

  test('pass-through when tools array is empty', async () => {
    const inner = stubLlm([{ kind: 'text', chunk: 'direct' }, TURN_COMPLETE]);
    const wrapped = withToolUsePolyfill(inner);
    const req: ChatRequest = { ...BASE_REQ, tools: [], toolUseEnabled: true };
    const events = await collect(wrapped.chat(req, new AbortController().signal));
    expect(events[0]).toMatchObject({ kind: 'text', chunk: 'direct' });
  });

  test('system prompt is injected with tool name', async () => {
    let capturedReq: ChatRequest | undefined;
    const spyLlm: LlmClient = {
      id: 'spy',
      supportsTools: false,
      async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
        capturedReq = req;
        yield { kind: 'text', chunk: 'ok' };
        yield TURN_COMPLETE;
      },
    };
    const wrapped = withToolUsePolyfill(spyLlm);
    await collect(wrapped.chat(BASE_REQ, new AbortController().signal));
    const sysMsg = capturedReq?.messages.find((m) => m.role === 'system');
    expect(sysMsg?.text).toContain('add');
  });

  test('inner client receives tools: [] and toolUseEnabled: false', async () => {
    let capturedReq: ChatRequest | undefined;
    const spyLlm: LlmClient = {
      id: 'spy',
      supportsTools: false,
      async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
        capturedReq = req;
        yield TURN_COMPLETE;
      },
    };
    const wrapped = withToolUsePolyfill(spyLlm);
    await collect(wrapped.chat(BASE_REQ, new AbortController().signal));
    expect(capturedReq?.tools).toHaveLength(0);
    expect(capturedReq?.toolUseEnabled).toBe(false);
  });

  test('XML tool_call in model output becomes tool_call event', async () => {
    const inner = stubLlm([
      { kind: 'text', chunk: '<tool_call name="add">{"a":17,"b":28}</tool_call>' },
      TURN_COMPLETE,
    ]);
    const wrapped = withToolUsePolyfill(inner);
    const events = await collect(wrapped.chat(BASE_REQ, new AbortController().signal));
    const tc = events.find((e) => e.kind === 'tool_call') as
      | Extract<ChatEvent, { kind: 'tool_call' }>
      | undefined;
    expect(tc).toBeDefined();
    expect(tc!.name).toBe('add');
    expect(tc!.args).toEqual({ a: 17, b: 28 });
  });

  test('noToolStrategy: retry → second call includes correction', async () => {
    let callCount = 0;
    const retryLlm: LlmClient = {
      id: 'retry',
      supportsTools: false,
      async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
        callCount++;
        if (callCount === 1) {
          yield { kind: 'text', chunk: 'The answer is 45.' };
        } else {
          yield { kind: 'text', chunk: '<tool_call name="add">{"a":17,"b":28}</tool_call>' };
        }
        yield TURN_COMPLETE;
      },
    };
    const wrapped = withToolUsePolyfill(retryLlm, { noToolStrategy: 'retry', maxRetries: 1 });
    const events = await collect(wrapped.chat(BASE_REQ, new AbortController().signal));
    expect(callCount).toBe(2);
    expect(events.some((e) => e.kind === 'tool_call')).toBe(true);
  });

  test('noToolStrategy: allow → model text returned as-is without retry', async () => {
    let callCount = 0;
    const inner = stubLlm([{ kind: 'text', chunk: 'The answer is 45.' }, TURN_COMPLETE]);
    // We need to count calls, so use a spy
    const countingLlm: LlmClient = {
      id: 'counting',
      supportsTools: false,
      async *chat(_req: ChatRequest): AsyncIterable<ChatEvent> {
        callCount++;
        for await (const ev of inner.chat(_req, new AbortController().signal)) yield ev;
      },
    };
    const wrapped = withToolUsePolyfill(countingLlm, { noToolStrategy: 'allow' });
    const events = await collect(wrapped.chat(BASE_REQ, new AbortController().signal));
    expect(callCount).toBe(1);
    expect(events.some((e) => e.kind === 'text')).toBe(true);
  });
});
