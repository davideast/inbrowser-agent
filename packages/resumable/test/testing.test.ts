/**
 * Verify the testing utilities exposed at `@inbrowser/resumable/testing`
 * actually catch the conditions they claim to. Run against the
 * memory store (memoized so the two engines share state).
 */
import { describe, expect, it } from 'bun:test';
import { probeStoreDurability, probeSweepTtl } from '../src/testing';
import { createMemoryJobStore } from '../src/store/memory';

describe('probeStoreDurability', () => {
  it('passes when the two engines share store data', async () => {
    const store = createMemoryJobStore<string>();
    const result = await probeStoreDurability({
      makeStore: () => store,
      makeEvent: (i) => `event-${i}`,
      eventCount: 4,
    });
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.name.startsWith('engine B'))?.ok).toBe(true);
  });

  it('fails when the second store cannot see the job', async () => {
    // Two isolated memory stores: engine B looks for the job in a
    // store that doesn't have it. The probe should fail with a
    // meaningful step breakdown rather than hanging.
    let i = 0;
    const result = await probeStoreDurability({
      makeStore: () => (i++ === 0 ? createMemoryJobStore<string>() : createMemoryJobStore<string>()),
      makeEvent: (n) => `e${n}`,
      eventCount: 3,
    });
    expect(result.ok).toBe(false);
    // Engine B's subscribe returns immediately when the job is missing,
    // so we report 0/3 events.
    expect(result.reason).toContain('engine B');
  });

  it('respects waitMs between engines', async () => {
    const store = createMemoryJobStore<string>();
    const t0 = Date.now();
    const result = await probeStoreDurability({
      makeStore: () => store,
      makeEvent: (i) => `e${i}`,
      eventCount: 2,
      waitMs: 30,
    });
    expect(result.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
  });
});

describe('probeSweepTtl', () => {
  it('passes against a store with TTL + sweepExpired', async () => {
    const store = createMemoryJobStore<string>({ defaultTtlMs: 50 });
    const result = await probeSweepTtl({
      store: store as typeof store & {
        sweepExpired: NonNullable<typeof store.sweepExpired>;
      },
      makeEvent: (i) => `e${i}`,
      ttlMs: 10,
      postFinishWaitMs: 30,
    });
    expect(result.ok).toBe(true);
    expect(result.steps.length).toBe(2);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });
});
