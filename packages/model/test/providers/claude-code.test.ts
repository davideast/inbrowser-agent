import { describe, expect, it } from 'bun:test';
/**
 * claude-code provider tests. The SDK is never actually loaded —
 * every test passes a fake `query` via `ClaudeCodeConfig.loadSdk`.
 * The fixture stream shapes match the real
 * `@anthropic-ai/claude-agent-sdk` SDKMessage union (v0.3.x).
 *
 * The provider is a FACTORY: construction settings (model / loadSdk /
 * oauthToken / env) go in the config; per-call settings (messages /
 * tools / reasoningEffort) ride the `ModelRequest`, and the signal is
 * the second `.chat()` arg.
 */
import type { ModelEvent, ModelRequest } from '../../src/contract';
import { type ClaudeCodeConfig, claudeCodeModelClient } from '../../src/providers/claude-code';

interface FakeMessage {
  type: string;
  subtype?: string;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: { content?: Array<{ type?: string; text?: string }>; usage?: Record<string, number> };
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  result?: string;
  is_error?: boolean;
}

const DEFAULT_MODEL = 'claude-opus-4-8';

function makeReq(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    messages: [{ role: 'user', text: 'say hi' }],
    tools: [],
    toolUseEnabled: false,
    ...over,
  };
}

/** Build the client + drive `.chat()` in one call. */
function run(
  config: Partial<ClaudeCodeConfig> & Pick<ClaudeCodeConfig, 'loadSdk'>,
  req: ModelRequest = makeReq(),
  signal: AbortSignal = new AbortController().signal,
): AsyncIterable<ModelEvent> {
  return claudeCodeModelClient({ model: DEFAULT_MODEL, apiKey: '', ...config }).chat(req, signal);
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/**
 * Build a fake `query()` that yields a scripted message stream.
 * Captures the last call args + an abort signal so tests can assert
 * what the provider passed to the SDK.
 */
function fakeSdk(messages: FakeMessage[]) {
  const calls: Array<{
    prompt: string;
    options: Record<string, unknown>;
  }> = [];
  const sdk = {
    query(params: { prompt: string; options?: Record<string, unknown> }) {
      calls.push({ prompt: params.prompt, options: params.options ?? {} });
      return (async function* () {
        for (const m of messages) yield m;
      })();
    },
  };
  return {
    calls,
    loadSdk: async () => ({ query: sdk.query as never }),
  };
}

describe('claude-code provider', () => {
  it('streams partial text deltas and ends with usage from result', async () => {
    const { loadSdk } = fakeSdk([
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hi! ' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'How can I help?' },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Hi! How can I help?',
        usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0 },
      },
    ]);
    const events = await collect(run({ loadSdk }));

    const text = events.filter((e) => e.kind === 'text');
    expect(text.map((e) => e.text).join('')).toBe('Hi! How can I help?');

    const last = events[events.length - 1];
    expect(last).toEqual({
      kind: 'usage',
      usage: {
        promptTokens: 12,
        outputTokens: 7,
        cachedTokens: 0,
      },
    });
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });

  it('emits thinking deltas', async () => {
    const { loadSdk } = fakeSdk([
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'considering...' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'ok' },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    ]);
    const events = await collect(run({ loadSdk }));
    const thinking = events.filter((e) => e.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect((thinking[0] as { text: string }).text).toBe('considering...');
  });

  it('passes bare-model SDK options: tools=[], settingSources=[], strictMcpConfig=true, includePartialMessages=true, ANTHROPIC_API_KEY stripped from env', async () => {
    process.env.ANTHROPIC_API_KEY = 'should-be-stripped';
    const { calls, loadSdk } = fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    await collect(
      run(
        { loadSdk },
        makeReq({
          messages: [
            { role: 'system', text: 'Be terse.' },
            { role: 'user', text: 'say hi' },
          ],
        }),
      ),
    );
    delete process.env.ANTHROPIC_API_KEY;

    expect(calls).toHaveLength(1);
    const opts = calls[0]?.options as Record<string, unknown>;
    expect(opts.tools).toEqual([]);
    expect(opts.settingSources).toEqual([]);
    expect(opts.mcpServers).toEqual({});
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.includePartialMessages).toBe(true);
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.systemPrompt).toBe('Be terse.');
    expect(opts.model).toBe('claude-opus-4-8');
    expect(opts.abortController).toBeInstanceOf(AbortController);
    const env = opts.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('propagates oauthToken via CLAUDE_CODE_OAUTH_TOKEN env', async () => {
    const { calls, loadSdk } = fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    await collect(run({ loadSdk, oauthToken: 'sk-oauth-test' }));
    const env = (calls[0]?.options as { env: Record<string, string | undefined> }).env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-oauth-test');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('strips ANTHROPIC_API_KEY even when caller tries to set it via config.env', async () => {
    const { calls, loadSdk } = fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    await collect(run({ loadSdk, env: { ANTHROPIC_API_KEY: 'sneaky', SOME_OTHER: 'allowed' } }));
    const env = (calls[0]?.options as { env: Record<string, string | undefined> }).env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SOME_OTHER).toBe('allowed');
  });

  it('passes reasoningEffort through as SDK Options.effort', async () => {
    const { calls, loadSdk } = fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    await collect(run({ loadSdk }, makeReq({ reasoningEffort: 'high' })));
    expect((calls[0]?.options as { effort: string }).effort).toBe('high');
  });

  it("omits effort when reasoningEffort is 'off' (relay sentinel — SDK has no off level)", async () => {
    const { calls, loadSdk } = fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    await collect(run({ loadSdk }, makeReq({ reasoningEffort: 'off' })));
    expect('effort' in (calls[0]?.options as object)).toBe(false);
  });

  it('omits effort when reasoningEffort is undefined', async () => {
    const { calls, loadSdk } = fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    await collect(run({ loadSdk }));
    expect('effort' in (calls[0]?.options as object)).toBe(false);
  });

  it('omits model option when config.model is empty', async () => {
    const { calls, loadSdk } = fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    await collect(run({ loadSdk, model: '' }));
    expect('model' in (calls[0]?.options as object)).toBe(false);
  });

  it('rejects caller-defined tools instead of silently dropping them', async () => {
    const { loadSdk } = fakeSdk([]);
    const events = await collect(
      run(
        { loadSdk },
        makeReq({
          tools: [
            {
              type: 'function',
              function: { name: 'get_weather', description: 'weather', parameters: {} },
            },
          ],
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect((events[0] as { message: string }).message).toContain('caller-defined tools');
  });

  it('returns silently when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { loadSdk } = fakeSdk([]);
    const events = await collect(run({ loadSdk }, makeReq(), ctrl.signal));
    expect(events).toEqual([]);
  });

  it('aborts mid-stream when the request signal fires', async () => {
    const ctrl = new AbortController();
    const { calls, loadSdk } = fakeSdk([
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } },
      },
      // The provider should bail before consuming the remaining
      // messages once the signal fires.
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'second' } },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'first second',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);
    const iter = run({ loadSdk }, makeReq(), ctrl.signal)[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toEqual({ kind: 'text', text: 'first' });
    ctrl.abort();
    const second = await iter.next();
    expect(second.done).toBe(true);
    // Provider should also have wired up an AbortController on the SDK side.
    const sdkAc = (calls[0]?.options as { abortController: AbortController }).abortController;
    expect(sdkAc.signal.aborted).toBe(true);
  });

  it('maps is_error result to error event', async () => {
    const { loadSdk } = fakeSdk([
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'rate limit hit',
      },
    ]);
    const events = await collect(run({ loadSdk }));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'error',
      message: 'claude-code SDK reported error_during_execution: rate limit hit',
    });
  });

  it('errors when the stream ends without a result message', async () => {
    const { loadSdk } = fakeSdk([
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      },
    ]);
    const events = await collect(run({ loadSdk }));
    const last = events[events.length - 1];
    expect(last?.kind).toBe('error');
    expect((last as { message: string }).message).toContain('without a result');
  });

  it('falls back to assistant message text when no partial deltas streamed', async () => {
    const { loadSdk } = fakeSdk([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'whole reply' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'whole reply',
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    ]);
    const events = await collect(run({ loadSdk }));
    const text = events.filter((e) => e.kind === 'text');
    expect(text).toHaveLength(1);
    expect((text[0] as { text: string }).text).toBe('whole reply');
  });

  it('surfaces SDK load failure as an error event', async () => {
    const events = await collect(
      run({
        loadSdk: async () => {
          throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect((events[0] as { message: string }).message).toContain(
      'failed to load @anthropic-ai/claude-agent-sdk',
    );
  });

  it('surfaces thrown SDK errors as error events', async () => {
    const events = await collect(
      run({
        loadSdk: async () => ({
          query: (() => {
            return (async function* () {
              yield { type: 'system', subtype: 'init' };
              throw new Error('upstream 529 overloaded');
            })();
          }) as never,
        }),
      }),
    );
    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect((errs[0] as { message: string }).message).toContain('upstream 529 overloaded');
  });
});

describe('claudeCodeModelClient surface', () => {
  it('exposes a stable id and does not advertise tool support', () => {
    const client = claudeCodeModelClient({ model: DEFAULT_MODEL, apiKey: '' });
    expect(client.id).toBe('claude-code:claude-opus-4-8');
    expect(client.supportsTools).toBe(false);
  });
});
