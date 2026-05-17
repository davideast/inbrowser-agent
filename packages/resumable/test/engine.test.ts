/**
 * Smoke tests — wire createJobEngine to createMemoryJobStore and
 * exercise the core flows. The shared conformance suite (task #80)
 * will be parameterized across every store; these tests assert the
 * engine's specific behaviors (terminal markers, subscribe-from-offset,
 * producer-throws-becomes-error).
 */
import { describe, expect, it } from 'bun:test';
import { createJobEngine } from '../src/engine';
import { createMemoryJobStore } from '../src/store/memory';
import type { JobEvent } from '../src/types';

type StrEvent = string;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('createJobEngine + createMemoryJobStore', () => {
  it('streams producer events through subscribe with a terminal marker', async () => {
    const store = createMemoryJobStore<StrEvent>();
    const engine = createJobEngine({ store });

    const { jobId } = await engine.start(async function* () {
      yield 'hello ';
      yield 'world';
    });

    const events = await collect(engine.subscribe(jobId));
    expect(events).toEqual([
      { kind: 'event', seq: 0, value: 'hello ' },
      { kind: 'event', seq: 1, value: 'world' },
      { kind: 'terminal', status: 'done' },
    ]);

    await engine.stop();
  });

  it('subscribe respects `from` and resumes from the offset', async () => {
    const store = createMemoryJobStore<StrEvent>();
    const engine = createJobEngine({ store });

    const { jobId } = await engine.start(async function* () {
      yield 'a';
      yield 'b';
      yield 'c';
    });

    // Wait for completion via a first full subscribe.
    await collect(engine.subscribe(jobId));

    const resumed = await collect(engine.subscribe(jobId, { from: 2 }));
    expect(resumed).toEqual([
      { kind: 'event', seq: 2, value: 'c' },
      { kind: 'terminal', status: 'done' },
    ]);

    await engine.stop();
  });

  it('a producer that throws yields a terminal { status: "error", reason }', async () => {
    const store = createMemoryJobStore<StrEvent>();
    const engine = createJobEngine({ store });

    const { jobId } = await engine.start(async function* () {
      yield 'partial';
      throw new Error('boom');
    });

    const events = await collect(engine.subscribe(jobId));
    const terminal = events.find(
      (e): e is Extract<JobEvent<StrEvent>, { kind: 'terminal' }> =>
        e.kind === 'terminal',
    );
    expect(terminal?.status).toBe('error');
    expect(terminal?.reason).toBe('boom');
    expect(events[0]).toEqual({ kind: 'event', seq: 0, value: 'partial' });

    await engine.stop();
  });

  it('subscribe yields events that arrive after subscription starts', async () => {
    const store = createMemoryJobStore<StrEvent>();
    const engine = createJobEngine({ store });

    // A producer that paces itself so the subscriber definitively
    // begins tailing before the events arrive.
    const { jobId } = await engine.start(async function* () {
      for (const v of ['x', 'y', 'z']) {
        await new Promise((r) => setTimeout(r, 5));
        yield v;
      }
    });

    const events = await collect(engine.subscribe(jobId));
    expect(events.filter((e) => e.kind === 'event')).toEqual([
      { kind: 'event', seq: 0, value: 'x' },
      { kind: 'event', seq: 1, value: 'y' },
      { kind: 'event', seq: 2, value: 'z' },
    ]);
    expect(events.at(-1)).toEqual({ kind: 'terminal', status: 'done' });

    await engine.stop();
  });

  it('get() returns a snapshot matching the final state', async () => {
    const store = createMemoryJobStore<StrEvent>();
    const engine = createJobEngine({ store });

    const { jobId } = await engine.start(async function* () {
      yield 'one';
    }, { data: { tag: 'unit' } });

    // Drain to terminal.
    await collect(engine.subscribe(jobId));

    const snap = await engine.get(jobId);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('done');
    expect(snap!.events).toEqual(['one']);
    expect(snap!.data).toEqual({ tag: 'unit' });
    expect(snap!.finishedAt).not.toBeNull();

    await engine.stop();
  });

  it('rejects sweep config when store has no sweepExpired', async () => {
    const store = createMemoryJobStore<StrEvent>();
    // Strip sweepExpired so the precondition fires.
    delete (store as Partial<typeof store>).sweepExpired;
    expect(() =>
      createJobEngine({
        store,
        sweep: { intervalMs: 1000 },
      }),
    ).toThrow(/sweepExpired/);
  });

  it('sweep deletes expired terminal jobs', async () => {
    const fakeNow = { t: 1_000_000 };
    const store = createMemoryJobStore<StrEvent>({
      defaultTtlMs: 100,
      now: () => fakeNow.t,
    });
    const engine = createJobEngine({ store, now: () => fakeNow.t });

    const { jobId } = await engine.start(async function* () {
      yield 'done';
    });

    // Drain to terminal so finishedAt is set.
    await collect(engine.subscribe(jobId));

    // Confirm the job is present.
    expect(await engine.get(jobId)).not.toBeNull();

    // Advance the clock past TTL.
    fakeNow.t += 500;
    const sweep = await store.sweepExpired!({ olderThan: fakeNow.t });
    expect(sweep.deleted).toBe(1);
    expect(await engine.get(jobId)).toBeNull();

    await engine.stop();
  });

  it('sweep leaves running jobs alone', async () => {
    const fakeNow = { t: 1_000_000 };
    const store = createMemoryJobStore<StrEvent>({
      defaultTtlMs: 50,
      now: () => fakeNow.t,
    });
    const engine = createJobEngine({ store, now: () => fakeNow.t });

    // Start a producer that hangs until released.
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    const { jobId } = await engine.start(async function* () {
      yield 'tick';
      await released;
    });

    // Make sure the first event has been appended before sweeping.
    await new Promise((r) => setTimeout(r, 10));

    fakeNow.t += 10_000;
    const sweep = await store.sweepExpired!({ olderThan: fakeNow.t });
    expect(sweep.deleted).toBe(0);
    expect(await engine.get(jobId)).not.toBeNull();
    expect((await engine.get(jobId))!.status).toBe('running');

    release();
    await collect(engine.subscribe(jobId));

    await engine.stop();
  });
});
