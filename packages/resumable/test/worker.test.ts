/**
 * Worker transport — RPC plumbing for the `JobEngine` over a `MessagePort`.
 *
 * Real worker spawning isn't available in `bun test` and isn't the thing
 * under test anyway. We use a `MessageChannel` to simulate the postMessage
 * boundary: `port1` stands in for the host-side worker scope, `port2` for the
 * client-side `Worker`/`MessagePort` on the page. Both speak the same minimal
 * `postMessage` / `addEventListener` shape (`PortLike`) the transport relies
 * on. The host owns one `createJobEngine` backed by the in-memory store; the
 * producer is reconstructed from a serializable spec via `buildProducer`,
 * since a function can't cross `postMessage`.
 *
 * Mirrors `packages/model/test/worker.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryJobStore } from '../src/store/memory.js';
import type { JobEvent } from '../src/types.js';
import { type JobEngineHost, connectJobEngine, hostJobEngine } from '../src/worker.js';

// ── Specs ────────────────────────────────────────────────────────────────────
// The serializable job spec the client ships; the host's `buildProducer`
// reconstructs the producer from it.

interface ValuesSpec {
  values: string[];
}

interface SlowSpec {
  /** Yield this many events, pausing `delayMs` between each. */
  count: number;
  delayMs: number;
}

type StrSpec = ValuesSpec | SlowSpec;

function isSlow(spec: StrSpec): spec is SlowSpec {
  return 'count' in spec;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

// ── Harness ──────────────────────────────────────────────────────────────────

interface Harness {
  host: JobEngineHost;
  channels: MessageChannel[];
  /** Open another client port on the same host (a second tab). */
  addClient(): ReturnType<typeof connectJobEngine<string, StrSpec>>;
}

function makeHarness(): Harness {
  const host = hostJobEngine<string, StrSpec>({
    store: createMemoryJobStore<string>(),
    buildProducer: (spec) =>
      async function* () {
        if (isSlow(spec)) {
          for (let i = 0; i < spec.count; i++) {
            await new Promise((r) => setTimeout(r, spec.delayMs));
            yield `e${i}`;
          }
          return;
        }
        for (const v of spec.values) yield v;
      },
  });

  const channels: MessageChannel[] = [];
  function addClient() {
    const channel = new MessageChannel();
    channels.push(channel);
    host.connect(channel.port1 as unknown as import('../src/worker.js').PortLike);
    const client = connectJobEngine<string, StrSpec>(
      channel.port2 as unknown as import('../src/worker.js').PortLike,
    );
    channel.port1.start();
    channel.port2.start();
    return client;
  }

  return { host, channels, addClient };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('hostJobEngine + connectJobEngine', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(async () => {
    await harness.host.stop().catch(() => {});
    for (const ch of harness.channels) {
      ch.port1.close();
      ch.port2.close();
    }
  });

  test('start + subscribe streams events then terminal over the wire', async () => {
    const client = harness.addClient();
    const { jobId } = await client.start({ values: ['a', 'b', 'c'] });
    expect(typeof jobId).toBe('string');

    const events = await collect(client.subscribe(jobId));
    expect(events).toEqual([
      { kind: 'event', seq: 0, value: 'a' },
      { kind: 'event', seq: 1, value: 'b' },
      { kind: 'event', seq: 2, value: 'c' },
      { kind: 'terminal', status: 'done' },
    ]);
  });

  test('durable replay: subscribe with { from } resumes from the offset', async () => {
    const client = harness.addClient();
    const { jobId } = await client.start({ values: ['a', 'b', 'c'] });

    // Drain to terminal so the store has the full log persisted.
    await collect(client.subscribe(jobId));

    // A fresh subscribe replays through the transport from the offset.
    const resumed = await collect(client.subscribe(jobId, { from: 1 }));
    expect(resumed).toEqual([
      { kind: 'event', seq: 1, value: 'b' },
      { kind: 'event', seq: 2, value: 'c' },
      { kind: 'terminal', status: 'done' },
    ]);
  });

  test('get() returns a snapshot over the wire', async () => {
    const client = harness.addClient();
    const { jobId } = await client.start({ values: ['a', 'b', 'c'] });
    await collect(client.subscribe(jobId));

    const snap = await client.get(jobId);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('done');
    expect(snap!.events).toEqual(['a', 'b', 'c']);

    // A missing job round-trips as null.
    expect(await client.get('nope')).toBeNull();
  });

  test('concurrent: two ports tailing the same job both see the full stream', async () => {
    const clientA = harness.addClient();
    const clientB = harness.addClient();

    const { jobId } = await clientA.start({ values: ['a', 'b', 'c'] });

    // Both clients subscribe to the SAME jobId across two MessageChannels.
    // No cross-routing: each gets its own independent, complete stream.
    const [a, b] = await Promise.all([
      collect(clientA.subscribe(jobId)),
      collect(clientB.subscribe(jobId)),
    ]);

    const expected: JobEvent<string>[] = [
      { kind: 'event', seq: 0, value: 'a' },
      { kind: 'event', seq: 1, value: 'b' },
      { kind: 'event', seq: 2, value: 'c' },
      { kind: 'terminal', status: 'done' },
    ];
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
  });

  test('concurrent subscribes on ONE port stay routed by request id', async () => {
    const client = harness.addClient();
    const { jobId } = await client.start({ values: ['a', 'b', 'c'] });

    // Two simultaneous subscribes on the same port must not cross — each
    // is keyed by its own rid. One resumes from 1, the other from 0.
    const [full, tail] = await Promise.all([
      collect(client.subscribe(jobId)),
      collect(client.subscribe(jobId, { from: 1 })),
    ]);

    expect(full).toEqual([
      { kind: 'event', seq: 0, value: 'a' },
      { kind: 'event', seq: 1, value: 'b' },
      { kind: 'event', seq: 2, value: 'c' },
      { kind: 'terminal', status: 'done' },
    ]);
    expect(tail).toEqual([
      { kind: 'event', seq: 1, value: 'b' },
      { kind: 'event', seq: 2, value: 'c' },
      { kind: 'terminal', status: 'done' },
    ]);
  });

  test('cancellation: breaking the for-await stops the host subscribe; no further frames', async () => {
    // Count host→client frames on this channel so we can prove the stream
    // quiesces after the consumer walks away.
    const channel = new MessageChannel();
    harness.channels.push(channel);

    let hostFrameCount = 0;
    channel.port2.addEventListener('message', () => {
      hostFrameCount++;
    });

    harness.host.connect(channel.port1 as unknown as import('../src/worker.js').PortLike);
    const client = connectJobEngine<string, StrSpec>(
      channel.port2 as unknown as import('../src/worker.js').PortLike,
    );
    channel.port1.start();
    channel.port2.start();

    // A producer that yields slowly and indefinitely-ish (10 events, 10ms
    // apart). We break after the first event.
    const { jobId } = await client.start({ count: 10, delayMs: 10 });

    let seen = 0;
    for await (const ev of client.subscribe(jobId)) {
      if (ev.kind === 'event') {
        seen++;
        if (seen === 1) break; // consumer walks away after one event
      }
    }
    expect(seen).toBe(1);

    // The break sends a subscribe-cancel; the host aborts its
    // engine.subscribe. Wait well past several producer ticks and assert
    // the frame count has stopped climbing — no events leak after cancel.
    const countAfterBreak = hostFrameCount;
    await new Promise((r) => setTimeout(r, 80));
    expect(hostFrameCount).toBe(countAfterBreak);
  });

  test('cancellation: aborting the subscribe signal also stops the host', async () => {
    const client = harness.addClient();
    const { jobId } = await client.start({ count: 10, delayMs: 10 });

    const ac = new AbortController();
    const received: JobEvent<string>[] = [];
    const drain = (async () => {
      for await (const ev of client.subscribe(jobId, { signal: ac.signal })) {
        received.push(ev);
        if (received.length === 1) ac.abort();
      }
    })();

    await drain;
    expect(received.length).toBe(1);
    expect(received[0]!.kind).toBe('event');
  });
});
