/**
 * `createEngineModelClient` — verify the `EngineEvent` → `ModelEvent` mapping
 * by driving a FAKE `Engine` (no @huggingface/transformers, no real model)
 * through the wrapper and asserting the contract events it produces.
 */

import { describe, expect, test } from 'bun:test';
import type { ModelEvent, ModelRequest } from '../src/contract.js';
import { createEngineModelClient } from '../src/engine-client.js';
import type {
  Engine,
  EngineCapabilities,
  EngineEvent,
  EngineMessage,
  GenerateOpts,
  ModelRef,
} from '../src/types.js';

/** Capture of what the wrapper passed into `engine.generate`. */
interface GenerateSpy {
  messages: ReadonlyArray<EngineMessage>;
  opts: GenerateOpts;
}

/**
 * A minimal `Engine` whose `generate()` yields a scripted `EngineEvent`
 * sequence. Records the args of the last `generate()` call for assertions.
 */
function makeFakeEngine(opts: {
  script: EngineEvent[];
  supportsTools?: boolean;
  modelId?: string;
  spy?: GenerateSpy[];
}): Engine {
  const capabilities: EngineCapabilities = {
    supportsTools: opts.supportsTools ?? false,
    supportsVision: false,
    supportsAudio: false,
    contextWindow: 4096,
    supportsThinking: false,
  };
  const model: ModelRef = { modelId: opts.modelId ?? 'fake/model' };

  return {
    model,
    state: 'ready',
    capabilities,
    ensureReady: async () => {},
    on: () => () => {},
    async *generate(messages, genOpts = {}): AsyncIterable<EngineEvent> {
      opts.spy?.push({ messages, opts: genOpts });
      for (const ev of opts.script) yield ev;
    },
    dispose: async () => {},
  };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const baseReq: ModelRequest = {
  messages: [{ role: 'user', text: 'hi' }],
  tools: [],
  toolUseEnabled: false,
};

describe('createEngineModelClient', () => {
  test('maps token → text, thinking → thinking, tool_call passthrough, terminal usage', async () => {
    const engine = makeFakeEngine({
      supportsTools: true,
      script: [
        { kind: 'token', text: 'Hello' },
        { kind: 'token', text: ' world' },
        { kind: 'thinking', text: 'pondering' },
        { kind: 'tool_call', id: 'call-1', name: 'search', args: { q: 'webgpu' } },
        { kind: 'usage', promptTokens: 12, outputTokens: 7, decodeMs: 345 },
      ],
    });
    const client = createEngineModelClient(engine);

    const events = await collect(client.chat(baseReq, new AbortController().signal));

    expect(events).toEqual([
      { kind: 'text', text: 'Hello' },
      { kind: 'text', text: ' world' },
      { kind: 'thinking', text: 'pondering' },
      // tool_call passes through WITHOUT a `signature` field.
      { kind: 'tool_call', id: 'call-1', name: 'search', args: { q: 'webgpu' } },
      // usage is nested + `decodeMs` is dropped.
      { kind: 'usage', usage: { promptTokens: 12, outputTokens: 7 } },
    ]);

    // The tool_call event must not carry a `signature` key at all.
    const tc = events.find((e) => e.kind === 'tool_call');
    expect(tc && 'signature' in tc).toBe(false);

    // usage nesting + no `decodeMs` leak.
    const usage = events.at(-1);
    expect(usage?.kind).toBe('usage');
    if (usage?.kind === 'usage') {
      expect(usage.usage).toEqual({ promptTokens: 12, outputTokens: 7 });
      expect('decodeMs' in usage.usage).toBe(false);
    }
  });

  test('error maps to {kind:error, message} and drops `recoverable`', async () => {
    const engine = makeFakeEngine({
      script: [{ kind: 'error', message: 'OOM', recoverable: false }],
    });
    const client = createEngineModelClient(engine);

    const events = await collect(client.chat(baseReq, new AbortController().signal));

    expect(events).toEqual([{ kind: 'error', message: 'OOM' }]);
    const err = events[0];
    expect(err && 'recoverable' in err).toBe(false);
  });

  test('supportsTools reflects the engine capabilities', () => {
    expect(
      createEngineModelClient(makeFakeEngine({ script: [], supportsTools: true })).supportsTools,
    ).toBe(true);
    expect(
      createEngineModelClient(makeFakeEngine({ script: [], supportsTools: false })).supportsTools,
    ).toBe(false);
  });

  test('toolUseEnabled:false passes tools:undefined to engine.generate', async () => {
    const spy: GenerateSpy[] = [];
    const engine = makeFakeEngine({
      supportsTools: true,
      script: [{ kind: 'usage', promptTokens: 1, outputTokens: 0, decodeMs: 1 }],
      spy,
    });
    const client = createEngineModelClient(engine);

    const tools: ModelRequest['tools'] = [
      { type: 'function', function: { name: 'search', description: 'd', parameters: {} } },
    ];
    await collect(
      client.chat(
        { messages: [{ role: 'user', text: 'hi' }], tools, toolUseEnabled: false },
        new AbortController().signal,
      ),
    );

    expect(spy).toHaveLength(1);
    expect(spy[0]?.opts.tools).toBeUndefined();
  });

  test('toolUseEnabled:true forwards req.tools to engine.generate', async () => {
    const spy: GenerateSpy[] = [];
    const engine = makeFakeEngine({
      supportsTools: true,
      script: [{ kind: 'usage', promptTokens: 1, outputTokens: 0, decodeMs: 1 }],
      spy,
    });
    const client = createEngineModelClient(engine);

    const tools: ModelRequest['tools'] = [
      { type: 'function', function: { name: 'search', description: 'd', parameters: {} } },
    ];
    await collect(
      client.chat(
        { messages: [{ role: 'user', text: 'hi' }], tools, toolUseEnabled: true },
        new AbortController().signal,
      ),
    );

    expect(spy[0]?.opts.tools).toBe(tools);
  });

  test('forwards sampling opts + the abort signal to engine.generate', async () => {
    const spy: GenerateSpy[] = [];
    const engine = makeFakeEngine({
      script: [{ kind: 'usage', promptTokens: 1, outputTokens: 0, decodeMs: 1 }],
      spy,
    });
    const client = createEngineModelClient(engine);
    const controller = new AbortController();

    await collect(
      client.chat(
        {
          messages: [{ role: 'user', text: 'hi' }],
          tools: [],
          toolUseEnabled: false,
          temperature: 0.4,
          topP: 0.9,
          topK: 40,
        },
        controller.signal,
      ),
    );

    expect(spy[0]?.opts.temperature).toBe(0.4);
    expect(spy[0]?.opts.topP).toBe(0.9);
    expect(spy[0]?.opts.topK).toBe(40);
    expect(spy[0]?.opts.signal).toBe(controller.signal);
  });

  test('flattens tool-result + assistant-toolCall messages into engine-readable text', async () => {
    const spy: GenerateSpy[] = [];
    const engine = makeFakeEngine({
      script: [{ kind: 'usage', promptTokens: 1, outputTokens: 0, decodeMs: 1 }],
      spy,
    });
    const client = createEngineModelClient(engine);

    await collect(
      client.chat(
        {
          messages: [
            { role: 'system', text: 'You are helpful.' },
            { role: 'user', text: 'search webgpu' },
            {
              role: 'assistant',
              text: 'let me search',
              toolCalls: [{ id: 'c1', name: 'search', args: { q: 'webgpu' } }],
            },
            { role: 'tool', toolCallId: 'c1', name: 'search', resultJson: '{"hits":3}' },
          ],
          tools: [],
          toolUseEnabled: false,
        },
        new AbortController().signal,
      ),
    );

    const sent = spy[0]?.messages ?? [];
    // Every sent message must be in the engine's toolless role set.
    for (const m of sent) {
      expect(['system', 'user', 'assistant']).toContain(m.role);
      // No tool round-trip fields leak onto an EngineMessage.
      expect('toolCalls' in m).toBe(false);
      expect('toolCallId' in m).toBe(false);
      expect('resultJson' in m).toBe(false);
    }

    expect(sent[0]).toEqual({ role: 'system', text: 'You are helpful.' });
    expect(sent[1]).toEqual({ role: 'user', text: 'search webgpu' });
    // assistant toolCalls flattened: original text + a per-call line.
    expect(sent[2]?.role).toBe('assistant');
    expect(sent[2]?.text).toContain('let me search');
    expect(sent[2]?.text).toContain('search');
    expect(sent[2]?.text).toContain('webgpu');
    // tool result flattened into a user line carrying the result json.
    expect(sent[3]?.role).toBe('user');
    expect(sent[3]?.text).toContain('search');
    expect(sent[3]?.text).toContain('{"hits":3}');
  });

  test('default id is local:${modelId}; explicit id wins', () => {
    expect(createEngineModelClient(makeFakeEngine({ script: [], modelId: 'HF/smol' })).id).toBe(
      'local:HF/smol',
    );
    expect(
      createEngineModelClient(makeFakeEngine({ script: [], modelId: 'HF/smol' }), 'on-device').id,
    ).toBe('on-device');
  });
});
