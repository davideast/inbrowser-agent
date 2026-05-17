/**
 * `@inbrowser/resumable/testing` — utilities for verifying a `JobStore`
 * implementation end-to-end.
 *
 * Three layers ship here:
 *
 *  - `probeStoreDurability` — in-process durability check. Runs a
 *    producer to terminal under one engine, then subscribes from a
 *    BRAND NEW engine pointing at the same underlying store data,
 *    asserting every event survives the handoff. The library version
 *    of "Probe A/B" from `plans/sw-inference-backgrounding-recovery.md`
 *    — for the HTTP-level instance-death variant (kill the process
 *    mid-stream), wrap this in your deploy harness.
 *
 *  - `probeSweepTtl` — verifies a job with `ttlMs` is deleted after
 *    its TTL, while a running job is left alone. Probes C/D from
 *    `plans/job-ttl-store-contract.md`.
 *
 *  - `runJobStoreConformance` (re-exported via package test helpers)
 *    — the parameterized describe/it suite that every JobStore
 *    implementation runs through. Internal to the package's test
 *    tree; downstream stores copy or import the helper directly.
 *
 * Memory stores can pass these probes only if both engines point at
 * the SAME store instance (their data isn't shared across calls).
 * RTDB stores naturally share data via the URL + rootPath, so two
 * `createRtdbJobStore({…})` calls with matching config pass.
 */
import { type JobEngine, createJobEngine } from './engine.js';
import type { JobStore } from './store/contract.js';
import type { JobEvent } from './types.js';

export interface DurabilityProbeOpts<TEvent> {
  /**
   * Each call returns a `JobStore` view of the SAME underlying data.
   * For RTDB: two `createRtdbJobStore({ url, rootPath })` calls with
   * identical config naturally share data. For memory: cache the
   * created store and return the same instance both times.
   */
  makeStore: () => JobStore<TEvent>;
  /** Build the i-th event the synthetic producer should yield. */
  makeEvent: (i: number) => TEvent;
  /** Number of events the producer yields. Default 5. */
  eventCount?: number;
  /**
   * Milliseconds to wait between the two engines. Default 0 — set to
   * something large (e.g. `12 * 60_000`) to prove durability over
   * time (Probe A).
   */
  waitMs?: number;
  /** Per-event yield interval in the synthetic producer. Default 0. */
  eventIntervalMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
  /** Per-step breakdown for debugging. */
  steps: Array<{ name: string; ok: boolean; detail?: string }>;
  durationMs: number;
}

/**
 * Drive a producer to terminal on engine A, then subscribe from a
 * fresh engine B against the same store data. Asserts every event
 * survives the handoff. Set `waitMs` to test durability over time.
 */
export async function probeStoreDurability<TEvent>(
  opts: DurabilityProbeOpts<TEvent>,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const count = opts.eventCount ?? 5;
  const waitMs = opts.waitMs ?? 0;
  const interval = opts.eventIntervalMs ?? 0;
  const steps: ProbeResult['steps'] = [];

  const store1 = opts.makeStore();
  const engineA = createJobEngine({ store: store1 });
  let jobId: string;
  try {
    const { jobId: id } = await engineA.start(async function* () {
      for (let i = 0; i < count; i++) {
        if (interval > 0) await new Promise((r) => setTimeout(r, interval));
        yield opts.makeEvent(i);
      }
    });
    jobId = id;
    steps.push({ name: 'engine A: started', ok: true, detail: `jobId=${id}` });
  } catch (e) {
    steps.push({
      name: 'engine A: started',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, reason: 'engine A start failed', steps, durationMs: Date.now() - t0 };
  }

  // Drive A to terminal so the producer is done before we hand off.
  const aEvents = await collectEvents(engineA, jobId);
  const aTerminal = aEvents.find((e) => e.kind === 'terminal');
  if (!aTerminal || aTerminal.kind !== 'terminal' || aTerminal.status !== 'done') {
    steps.push({
      name: 'engine A: ran to terminal',
      ok: false,
      detail: `terminal=${JSON.stringify(aTerminal)}`,
    });
    await engineA.stop();
    return {
      ok: false,
      reason: 'engine A did not reach status=done',
      steps,
      durationMs: Date.now() - t0,
    };
  }
  steps.push({
    name: 'engine A: ran to terminal',
    ok: true,
    detail: `${aEvents.filter((e) => e.kind === 'event').length}/${count} events`,
  });
  await engineA.stop();

  if (waitMs > 0) {
    steps.push({ name: `waited ${waitMs}ms`, ok: true });
    await new Promise((r) => setTimeout(r, waitMs));
  }

  // Engine B against the same store data — verify every event survives.
  const store2 = opts.makeStore();
  const engineB = createJobEngine({ store: store2 });
  const bEvents = await collectEvents(engineB, jobId);
  const bDataEvents = bEvents.filter((e) => e.kind === 'event');
  if (bDataEvents.length !== count) {
    steps.push({
      name: 'engine B: replayed events',
      ok: false,
      detail: `expected ${count}, got ${bDataEvents.length}`,
    });
    await engineB.stop();
    return {
      ok: false,
      reason: `engine B saw ${bDataEvents.length} events, expected ${count}`,
      steps,
      durationMs: Date.now() - t0,
    };
  }
  steps.push({
    name: 'engine B: replayed events',
    ok: true,
    detail: `${bDataEvents.length}/${count} events`,
  });
  await engineB.stop();

  return { ok: true, steps, durationMs: Date.now() - t0 };
}

export interface SweepProbeOpts<TEvent> {
  /** A store that implements `sweepExpired`. */
  store: JobStore<TEvent> & {
    sweepExpired: NonNullable<JobStore<TEvent>['sweepExpired']>;
  };
  makeEvent: (i: number) => TEvent;
  /** TTL in ms. Default 50. */
  ttlMs?: number;
  /** Wait after finishing before sweeping. Default ttlMs + 20. */
  postFinishWaitMs?: number;
}

/**
 * Verify that a terminal job with `ttlMs` is swept after its TTL
 * (Probe C), and that a running job is NEVER swept (Probe D).
 */
export async function probeSweepTtl<TEvent>(opts: SweepProbeOpts<TEvent>): Promise<ProbeResult> {
  const t0 = Date.now();
  const steps: ProbeResult['steps'] = [];
  const ttlMs = opts.ttlMs ?? 50;
  const waitMs = opts.postFinishWaitMs ?? ttlMs + 20;
  const engine = createJobEngine({ store: opts.store });

  // Probe C — terminal job swept.
  const cJob = await engine.start(
    async function* () {
      yield opts.makeEvent(0);
    },
    { ttlMs },
  );
  await collectEvents(engine, cJob.jobId);
  await new Promise((r) => setTimeout(r, waitMs));
  const cSweep = await opts.store.sweepExpired({ olderThan: Date.now() });
  const cSnap = await opts.store.snapshot(cJob.jobId);
  if (cSnap !== null) {
    steps.push({
      name: 'probe C: terminal job swept',
      ok: false,
      detail: `still present after sweep (deleted=${cSweep.deleted})`,
    });
    await engine.stop();
    return {
      ok: false,
      reason: 'TTL job not swept',
      steps,
      durationMs: Date.now() - t0,
    };
  }
  steps.push({
    name: 'probe C: terminal job swept',
    ok: true,
    detail: `deleted=${cSweep.deleted}, scanned=${cSweep.scanned}`,
  });

  // Probe D — running job is NEVER swept.
  let release: () => void = () => {};
  const released = new Promise<void>((r) => {
    release = r;
  });
  const dJob = await engine.start(
    async function* () {
      yield opts.makeEvent(0);
      await released;
    },
    { ttlMs },
  );

  await new Promise((r) => setTimeout(r, Math.max(20, ttlMs / 2)));
  await opts.store.sweepExpired({ olderThan: Date.now() + 1_000_000 });
  const dSnap = await opts.store.snapshot(dJob.jobId);
  if (!dSnap || dSnap.status !== 'running') {
    steps.push({
      name: 'probe D: running job survives sweep',
      ok: false,
      detail: `snap=${JSON.stringify(dSnap)}`,
    });
    release();
    await engine.stop();
    return {
      ok: false,
      reason: 'running job was swept',
      steps,
      durationMs: Date.now() - t0,
    };
  }
  steps.push({ name: 'probe D: running job survives sweep', ok: true });

  release();
  await collectEvents(engine, dJob.jobId);
  await engine.stop();
  return { ok: true, steps, durationMs: Date.now() - t0 };
}

async function collectEvents<TEvent>(
  engine: JobEngine<TEvent>,
  jobId: string,
): Promise<JobEvent<TEvent>[]> {
  const out: JobEvent<TEvent>[] = [];
  for await (const evt of engine.subscribe(jobId)) out.push(evt);
  return out;
}
