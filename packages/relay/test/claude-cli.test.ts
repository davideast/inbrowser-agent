import { describe, expect, it } from 'bun:test';
/**
 * claude-cli provider tests. No real `claude` binary is ever invoked:
 * every test runs against `fixtures/fake-claude.sh`, an env-var-driven
 * stand-in, replaying `fixtures/claude-cli-stream-json.ndjson` — a
 * verbatim capture of one real `claude -p --output-format stream-json
 * --include-partial-messages` run (Claude Code v2.1.172).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCliProvider, renderPrompt } from '../src/providers/claude-cli';
import type { InferenceEvent, NormalizedRequest } from '../src/types';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = join(FIXTURES, 'fake-claude.sh');
const REAL_CAPTURE = join(FIXTURES, 'claude-cli-stream-json.ndjson');

function makeReq(over: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    provider: 'claude-cli',
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', text: 'say hi' }],
    tools: [],
    apiKey: '',
    ...over,
  };
}

async function collect(events: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-cli-test-'));
}

describe('claude-cli provider', () => {
  it('streams text + thinking and ends with usage (real captured output)', async () => {
    const provider = createClaudeCliProvider({
      claudePath: FAKE_CLAUDE,
      env: { FAKE_OUTPUT_FILE: REAL_CAPTURE },
    });
    const events = await collect(provider(makeReq()));

    const text = events.filter((e) => e.kind === 'text');
    expect(text.map((e) => e.chunk).join('')).toBe('Hi! 👋 How can I help you today?');

    const thinking = events.filter((e) => e.kind === 'thinking');
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking[0]?.chunk).toContain('The user is asking me to say');

    const last = events[events.length - 1];
    expect(last).toEqual({
      kind: 'usage',
      promptTokens: 157,
      outputTokens: 78,
      cachedTokens: 0,
      costUsd: 0.000547,
    });
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });

  it('spawns with the grounded flag set, model passthrough, and stdin prompt', async () => {
    const dir = scratchDir();
    const argsFile = join(dir, 'args');
    const stdinFile = join(dir, 'stdin');
    const provider = createClaudeCliProvider({
      claudePath: FAKE_CLAUDE,
      env: {
        FAKE_OUTPUT_FILE: REAL_CAPTURE,
        FAKE_ARGS_FILE: argsFile,
        FAKE_STDIN_FILE: stdinFile,
      },
    });
    await collect(
      provider(
        makeReq({
          messages: [
            { role: 'system', text: 'Be terse.' },
            { role: 'user', text: 'say hi' },
          ],
          reasoningEffort: 'high',
        }),
      ),
    );

    const args = readFileSync(argsFile, 'utf8').split('\n');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    // pure-model default: all built-in tools off
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('Be terse.');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');

    expect(readFileSync(stdinFile, 'utf8')).toBe('say hi');
  });

  it('omits --model when empty and resolves the executable via PATH', async () => {
    // Default claudePath is bare 'claude' — point PATH at a dir that has one.
    const dir = scratchDir();
    writeFileSync(join(dir, 'claude'), readFileSync(FAKE_CLAUDE));
    Bun.spawnSync(['chmod', '+x', join(dir, 'claude')]);
    const argsFile = join(dir, 'args');
    const provider = createClaudeCliProvider({
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        FAKE_OUTPUT_FILE: REAL_CAPTURE,
        FAKE_ARGS_FILE: argsFile,
      },
    });
    const events = await collect(provider(makeReq({ model: '' })));
    expect(events.some((e) => e.kind === 'usage')).toBe(true);
    expect(readFileSync(argsFile, 'utf8').split('\n')).not.toContain('--model');
  });

  it('flattens multi-turn histories into a transcript prompt', async () => {
    const dir = scratchDir();
    const stdinFile = join(dir, 'stdin');
    const provider = createClaudeCliProvider({
      claudePath: FAKE_CLAUDE,
      env: { FAKE_OUTPUT_FILE: REAL_CAPTURE, FAKE_STDIN_FILE: stdinFile },
    });
    await collect(
      provider(
        makeReq({
          messages: [
            { role: 'user', text: 'first' },
            { role: 'assistant', text: 'reply' },
            { role: 'user', text: 'second' },
          ],
        }),
      ),
    );
    const prompt = readFileSync(stdinFile, 'utf8');
    expect(prompt).toContain('conversation transcript');
    expect(prompt).toContain('User: first');
    expect(prompt).toContain('Assistant: reply');
    expect(prompt).toContain('User: second');
  });

  it('yields a clear error when the CLI is missing (ENOENT)', async () => {
    const provider = createClaudeCliProvider({ claudePath: '/nonexistent/claude-cli-bin' });
    const events = await collect(provider(makeReq()));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect((events[0] as { message: string }).message).toContain('claude CLI not found');
  });

  it('yields error with stderr on non-zero exit', async () => {
    const provider = createClaudeCliProvider({
      claudePath: FAKE_CLAUDE,
      env: { FAKE_EXIT_CODE: '2', FAKE_STDERR: 'Invalid API key' },
    });
    const events = await collect(provider(makeReq()));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    const msg = (events[0] as { message: string }).message;
    expect(msg).toContain('exited with code 2');
    expect(msg).toContain('Invalid API key');
  });

  it('skips malformed JSON lines and still consumes the result', async () => {
    const dir = scratchDir();
    const out = join(dir, 'out.ndjson');
    writeFileSync(
      out,
      [
        'this is not json',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}',
        '{broken',
        '{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":3,"output_tokens":1},"total_cost_usd":0.0001}',
      ].join('\n'),
    );
    const provider = createClaudeCliProvider({
      claudePath: FAKE_CLAUDE,
      env: { FAKE_OUTPUT_FILE: out },
    });
    const events = await collect(provider(makeReq()));
    expect(events).toEqual([
      { kind: 'text', chunk: 'ok' },
      { kind: 'usage', promptTokens: 3, outputTokens: 1, costUsd: 0.0001 },
    ]);
  });

  it('errors when the CLI exits cleanly without a result event', async () => {
    const dir = scratchDir();
    const out = join(dir, 'out.ndjson');
    writeFileSync(out, '{"type":"system","subtype":"init"}\n');
    const provider = createClaudeCliProvider({
      claudePath: FAKE_CLAUDE,
      env: { FAKE_OUTPUT_FILE: out },
    });
    const events = await collect(provider(makeReq()));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect((events[0] as { message: string }).message).toContain('without emitting a result');
  });

  it('maps an is_error result to an error event', async () => {
    const dir = scratchDir();
    const out = join(dir, 'out.ndjson');
    writeFileSync(
      out,
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"something broke"}\n',
    );
    const provider = createClaudeCliProvider({
      claudePath: FAKE_CLAUDE,
      env: { FAKE_OUTPUT_FILE: out },
    });
    const events = await collect(provider(makeReq()));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'error',
      message: 'claude -p reported error_during_execution: something broke',
    });
  });

  it('kills the child and yields error on timeout', async () => {
    const provider = createClaudeCliProvider({
      claudePath: FAKE_CLAUDE,
      timeoutMs: 150,
      env: { FAKE_SLEEP_SECS: '10' },
    });
    const started = Date.now();
    const events = await collect(provider(makeReq()));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect((events[0] as { message: string }).message).toContain('timed out after 150ms');
  });

  it('rejects caller-defined tools instead of silently dropping them', async () => {
    const provider = createClaudeCliProvider({ claudePath: FAKE_CLAUDE });
    const events = await collect(
      provider(
        makeReq({ tools: [{ name: 'get_weather', description: 'weather', parameters: {} }] }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect((events[0] as { message: string }).message).toContain('caller-defined tools');
  });

  it('returns silently when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const provider = createClaudeCliProvider({ claudePath: FAKE_CLAUDE });
    const events = await collect(provider(makeReq({ signal: ctrl.signal })));
    expect(events).toEqual([]);
  });
});

describe('renderPrompt', () => {
  it('passes a single user message through verbatim', () => {
    const { system, prompt } = renderPrompt([
      { role: 'system', text: 'sys' },
      { role: 'user', text: 'hello' },
    ]);
    expect(system).toBe('sys');
    expect(prompt).toBe('hello');
  });

  it('joins multiple system messages and renders tool turns', () => {
    const { system, prompt } = renderPrompt([
      { role: 'system', text: 'a' },
      { role: 'system', text: 'b' },
      { role: 'user', text: 'q' },
      {
        role: 'assistant',
        toolCalls: [{ callId: '1', name: 'lookup', args: { id: 7 } }],
      },
      { role: 'tool', callId: '1', name: 'lookup', resultJson: '{"v":42}' },
      { role: 'user', text: 'and now?' },
    ]);
    expect(system).toBe('a\n\nb');
    expect(prompt).toContain('[called tool lookup with {"id":7}]');
    expect(prompt).toContain('Tool result: lookup: {"v":42}');
  });
});
