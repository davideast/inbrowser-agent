/**
 * Worker transport — RPC plumbing + lifecycle round-trip.
 *
 * Real worker spawning isn't available in `bun test` and isn't the
 * thing under test anyway. We use a `MessageChannel` to simulate the
 * postMessage boundary: port1 stands in for the `Worker` on the main
 * side; port2 stands in for `DedicatedWorkerGlobalScope` on the host
 * side. Both ports speak the same `postMessage` / `addEventListener`
 * shape the transport relies on.
 *
 * The mock engine is a hand-rolled in-process implementation of the
 * `Engine` interface that emits scripted load + token events. The
 * test asserts those events arrive at the client side over the wire,
 * round-trip through the seq-tagged frames.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  CreateEngineOpts,
  Engine,
  EngineEvent,
  EngineEventMap,
  EngineMessage,
  EngineState,
  GenerateOpts,
  LoadProgress,
} from '../src/types.js';
import { connectWorkerEngine, hostEngineInWorker } from '../src/worker.js';

// ── Mock engine ──────────────────────────────────────────────────────────────

interface MockEngineHandle extends Engine {
  /** Drive the load-progress sequence the next time ensureReady runs. */
  loadScript: LoadProgress[];
  /** Drive the token sequence the next time generate runs. */
  tokenScript: string[];
  /** Set true to make ensureReady reject. */
  failLoad: boolean;
  /** Last messages received by generate. */
  lastMessages?: ReadonlyArray<EngineMessage>;
  /** Last GenerateOpts received. */
  lastOpts?: GenerateOpts;
  /** Whether the engine saw a dispose() call. */
  disposed: boolean;
}

function createMockEngine(opts: CreateEngineOpts): MockEngineHandle {
  const stateSubs = new Set<(s: EngineState) => void>();
  const loadSubs = new Set<(p: LoadProgress) => void>();
  let state: EngineState = 'idle';

  const handle: MockEngineHandle = {
    loadScript: [{ phase: 'init', backend: opts.backend }, { phase: 'ready' }],
    tokenScript: ['Hello', ' ', 'world'],
    failLoad: false,
    disposed: false,
    get model() {
      return opts.model;
    },
    get state() {
      return state;
    },
    get capabilities() {
      return opts.capabilities;
    },
    async ensureReady() {
      if (state === 'ready') return;
      if (handle.failLoad) {
        setState('error');
        throw new Error('mock load failure');
      }
      setState('loading');
      for (const p of handle.loadScript) {
        for (const sub of loadSubs) sub(p);
      }
      setState('ready');
    },
    on<K extends keyof EngineEventMap>(
      event: K,
      h: (value: EngineEventMap[K]) => void,
    ): () => void {
      if (event === 'state') {
        const fn = h as (s: EngineState) => void;
        stateSubs.add(fn);
        return () => stateSubs.delete(fn);
      }
      const fn = h as (p: LoadProgress) => void;
      loadSubs.add(fn);
      return () => loadSubs.delete(fn);
    },
    async *generate(
      messages: ReadonlyArray<EngineMessage>,
      genOpts?: GenerateOpts,
    ): AsyncIterable<EngineEvent> {
      handle.lastMessages = messages;
      handle.lastOpts = genOpts;
      await handle.ensureReady();
      for (const text of handle.tokenScript) {
        if (genOpts?.signal?.aborted) break;
        yield { kind: 'token', text };
        // Yield to the microtask queue so the consumer can interleave.
        await Promise.resolve();
      }
      yield {
        kind: 'usage',
        promptTokens: 1,
        outputTokens: handle.tokenScript.length,
        decodeMs: 1,
      };
    },
    async dispose() {
      handle.disposed = true;
      state = 'disposed';
      stateSubs.clear();
      loadSubs.clear();
    },
  };

  function setState(next: EngineState): void {
    if (state === next) return;
    state = next;
    for (const sub of stateSubs) sub(next);
  }

  return handle;
}

// ── Channel scaffolding ──────────────────────────────────────────────────────

const PRESET_OPTS: CreateEngineOpts = {
  model: { modelId: 'mock/test' },
  dtype: 'q4f16',
  backend: 'wasm',
  capabilities: {
    supportsTools: false,
    supportsVision: false,
    supportsAudio: false,
    contextWindow: 1024,
    supportsThinking: false,
  },
};

interface Harness {
  client: Engine;
  mock: MockEngineHandle;
  host: { dispose: () => Promise<void> };
  channel: MessageChannel;
}

function makeHarness(overrides?: Partial<CreateEngineOpts>): Harness {
  const channel = new MessageChannel();
  const hostOpts = { ...PRESET_OPTS, ...overrides };
  // Build the mock up-front so the test body can mutate its scripts
  // synchronously. The factory hands the same instance back to the
  // host when `init` arrives.
  const mock = createMockEngine(hostOpts);
  // port2 stands in for DedicatedWorkerGlobalScope; the cast is the
  // same one the production code does on `self` at the worker entry.
  const host = hostEngineInWorker(channel.port2 as unknown as DedicatedWorkerGlobalScope, {
    factory: () => mock,
  });
  // port1 stands in for the `Worker` constructed on the main thread.
  const client = connectWorkerEngine({
    worker: channel.port1 as unknown as Worker,
    engine: hostOpts,
  });
  channel.port1.start();
  channel.port2.start();
  return { client, mock, host, channel };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('connectWorkerEngine + hostEngineInWorker', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(async () => {
    await harness.client.dispose().catch(() => {});
    await harness.host.dispose().catch(() => {});
  });

  test('exposes preset metadata synchronously (no handshake required)', () => {
    expect(harness.client.state).toBe('idle');
    expect(harness.client.model.modelId).toBe('mock/test');
    expect(harness.client.capabilities.contextWindow).toBe(1024);
  });

  test('ensureReady forwards state + load events from worker', async () => {
    const states: EngineState[] = [];
    const loads: LoadProgress[] = [];
    harness.client.on('state', (s) => states.push(s));
    harness.client.on('load', (p) => loads.push(p));

    await harness.client.ensureReady();

    expect(harness.client.state).toBe('ready');
    expect(states).toContain('loading');
    expect(states).toContain('ready');
    expect(loads.some((p) => p.phase === 'init')).toBe(true);
    expect(loads.some((p) => p.phase === 'ready')).toBe(true);
  });

  test('generate streams events end-to-end over the wire', async () => {
    await harness.client.ensureReady();
    const events: EngineEvent[] = [];
    for await (const ev of harness.client.generate([{ role: 'user', text: 'hi' }])) {
      events.push(ev);
    }
    const tokens = events
      .filter((e) => e.kind === 'token')
      .map((e) => (e as { text: string }).text);
    expect(tokens).toEqual(['Hello', ' ', 'world']);
    const usage = events.find((e) => e.kind === 'usage');
    expect(usage).toBeDefined();
    expect((usage as { outputTokens: number }).outputTokens).toBe(3);
    expect(harness.mock.lastMessages?.[0]?.text).toBe('hi');
  });

  test('ensureReady rejects when host engine throws', async () => {
    // Allow the host's factory-created mock to settle, then force failure.
    await Promise.resolve();
    harness.mock.failLoad = true;
    await expect(harness.client.ensureReady()).rejects.toThrow(/mock load/);
  });

  test('multiple concurrent generate streams stay separated', async () => {
    await harness.client.ensureReady();
    harness.mock.tokenScript = ['a', 'b', 'c'];

    const collect = async (engine: Engine) => {
      const out: string[] = [];
      for await (const ev of engine.generate([{ role: 'user', text: 'go' }])) {
        if (ev.kind === 'token') out.push(ev.text);
      }
      return out;
    };

    const [a, b] = await Promise.all([collect(harness.client), collect(harness.client)]);
    expect(a).toEqual(['a', 'b', 'c']);
    expect(b).toEqual(['a', 'b', 'c']);
  });

  test('dispose tears down host engine + transitions client state', async () => {
    await harness.client.ensureReady();
    await harness.client.dispose();
    expect(harness.client.state).toBe('disposed');
    expect(harness.mock.disposed).toBe(true);

    // Subsequent calls on the disposed client should not hang.
    const events: EngineEvent[] = [];
    for await (const ev of harness.client.generate([{ role: 'user', text: 'x' }])) {
      events.push(ev);
    }
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });

  test('generate strips non-serializable signal before postMessage', async () => {
    await harness.client.ensureReady();
    const ctrl = new AbortController();
    const events: EngineEvent[] = [];
    for await (const ev of harness.client.generate([{ role: 'user', text: 'x' }], {
      maxNewTokens: 8,
      signal: ctrl.signal,
    })) {
      events.push(ev);
    }
    // The host side should have observed maxNewTokens but synthesized
    // its own signal — the client's was filtered before the wire.
    expect(harness.mock.lastOpts?.maxNewTokens).toBe(8);
    expect(harness.mock.lastOpts?.signal).toBeDefined();
    expect(harness.mock.lastOpts?.signal).not.toBe(ctrl.signal);
  });
});

describe('connectWorkerEngine handshake', () => {
  test('rejects ensureReady on handshake timeout', async () => {
    // A black-hole port: postMessage no-ops, no `init-ack` ever arrives.
    const blackHole: Worker = {
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      terminate: () => undefined,
      dispatchEvent: () => false,
      onmessage: null,
      onmessageerror: null,
      onerror: null,
    } as unknown as Worker;
    const client = connectWorkerEngine({
      worker: blackHole,
      engine: PRESET_OPTS,
      handshakeTimeoutMs: 25,
    });
    await expect(client.ensureReady()).rejects.toThrow(/handshake timeout/);
    // No dispose: the black-hole port can't ack the dispose frame, and
    // we've already proven the assertion the test cares about.
  });
});
