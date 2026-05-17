/**
 * Unit tests for `replayEvents()`. Uses a stub `ToolDispatch` that
 * records calls — no Firestore involvement. The simulator integration
 * test in `test/integration/replay-simulator.test.ts` covers the
 * full dev→prod round-trip.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openEventLog } from '../../src/events/log.js';
import { replayEvents, ReplayInvariantError } from '../../src/events/replay.js';
import type {
  MutationEvent,
  ToolContext,
  ToolDispatch,
  ToolResult,
  ReplayProgress,
} from '../../src/index.js';

function freshDir(): string {
  return mkdtempSync(`${tmpdir()}/agent-replay-`);
}

function stubDispatch(scripted: Record<string, ToolResult>): {
  dispatch: ToolDispatch;
  calls: { name: string; args: unknown }[];
} {
  const calls: { name: string; args: unknown }[] = [];
  return {
    calls,
    dispatch: {
      async execute(call) {
        calls.push({ name: call.name, args: call.args });
        return scripted[call.name] ?? { ok: true, summary: `${call.name} ok` };
      },
    },
  };
}

const fakeCtx = (): ToolContext => ({
  workspace: {
    presetId: '',
    rules: '',
    code: '',
    appSource: '',
    stitch: { projectId: null, latestScreenUrl: null, brief: null },
  },
  runtime: {
    terminal: [],
    runSummary: null,
    deploy: null,
    parseError: null,
    uiErrors: [],
    sandboxVersion: 0,
  },
  sandbox: {
    async run() { return { ok: true, durationMs: 0, docsTouched: 0, errors: 0, entries: [] }; },
    async deployRules() { return { ok: true, messages: [] }; },
    async readState() { return {}; },
    reseed() {},
    dispose() {},
  },
  lint: () => ({ warnings: [] }),
  signal: new AbortController().signal,
});

function seed(log: ReturnType<typeof openEventLog>) {
  log.append({
    agent: 'host',
    sessionId: 's1',
    tool: 'writeRules',
    args: { source: 'rules_version="2"' },
    phase: 'commit',
    target: { kind: 'workspace', path: 'workspace.rules' },
    reversible: true,
    reverseOp: { tool: 'writeRules', args: { source: '' } },
  });
  log.append({
    agent: 'host',
    sessionId: 's1',
    tool: 'setDoc',
    args: { path: 'items/a', data: { v: 1 } },
    phase: 'commit',
    target: { kind: 'doc', path: 'items/a' },
    reversible: true,
    reverseOp: { tool: 'deleteDoc', args: { path: 'items/a' } },
  });
}

async function collect(iter: AsyncIterable<ReplayProgress>): Promise<ReplayProgress[]> {
  const out: ReplayProgress[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('replayEvents', () => {
  test('dispatches every commit event with its stored args', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      seed(log);
      const { dispatch, calls } = stubDispatch({});

      const events = await collect(
        replayEvents({ log, dispatch, toolContext: fakeCtx }),
      );

      const applied = events.filter((e) => e.type === 'applied');
      expect(applied).toHaveLength(2);
      expect(calls).toEqual([
        { name: 'writeRules', args: { source: 'rules_version="2"' } },
        { name: 'setDoc', args: { path: 'items/a', data: { v: 1 } } },
      ]);
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type !== 'done') throw new Error('unreachable');
      expect(done.applied).toBe(2);
      expect(done.errors).toBe(0);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('writes a migrate_applied marker per applied event', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      seed(log);
      const { dispatch } = stubDispatch({});

      await collect(replayEvents({ log, dispatch, toolContext: fakeCtx }));

      // Re-read the log — should now have 2 commits + 2 markers.
      const markers = log
        .read()
        .filter((e) => (e.metadata as { type?: string } | undefined)?.type === 'migrate_applied');
      expect(markers).toHaveLength(2);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('skips events that already have a migrate_applied marker (idempotent)', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      seed(log);
      const { dispatch, calls } = stubDispatch({});

      // First replay.
      await collect(replayEvents({ log, dispatch, toolContext: fakeCtx }));
      const firstCount = calls.length;

      // Second replay — should be a no-op.
      const events2 = await collect(
        replayEvents({ log, dispatch, toolContext: fakeCtx }),
      );
      expect(calls.length).toBe(firstCount);
      const skipped = events2.filter((e) => e.type === 'skipped');
      expect(skipped).toHaveLength(2);
      for (const s of skipped) {
        if (s.type === 'skipped') expect(s.reason).toBe('already_applied');
      }
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('dry-run yields plan events without dispatching', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      seed(log);
      const { dispatch, calls } = stubDispatch({});

      const events = await collect(
        replayEvents({ log, dispatch, toolContext: fakeCtx, dryRun: true }),
      );
      const plans = events.filter((e) => e.type === 'plan');
      expect(plans).toHaveLength(2);
      expect(calls).toHaveLength(0);
      // No markers written.
      const markers = log
        .read()
        .filter((e) => (e.metadata as { type?: string } | undefined)?.type === 'migrate_applied');
      expect(markers).toHaveLength(0);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('respects sinceEventId — skips earlier events', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      seed(log);
      const all = log.read({ phase: 'commit' });
      const cutoff = all[1]!.id; // second commit
      const { dispatch, calls } = stubDispatch({});

      await collect(
        replayEvents({ log, dispatch, toolContext: fakeCtx, sinceEventId: cutoff }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe('setDoc');
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('respects toolAllowlist and pathDenyList', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      seed(log);
      const { dispatch, calls } = stubDispatch({});

      // Allowlist: only setDoc.
      await collect(
        replayEvents({
          log,
          dispatch,
          toolContext: fakeCtx,
          toolAllowlist: ['setDoc'],
        }),
      );
      expect(calls.map((c) => c.name)).toEqual(['setDoc']);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }

    const dir2 = freshDir();
    try {
      const log = openEventLog({ projectId: 'p2', logDir: dir2 });
      seed(log);
      const { dispatch, calls } = stubDispatch({});

      // Deny: items/a path.
      await collect(
        replayEvents({
          log,
          dispatch,
          toolContext: fakeCtx,
          pathDenyList: ['items/a'],
        }),
      );
      expect(calls.map((c) => c.name)).toEqual(['writeRules']);
      log.close();
    } finally {
      rmSync(dir2, { recursive: true });
    }
  });

  test('throws ReplayInvariantError on a no-args commit event', async () => {
    // The library has never been published — every commit event
    // emitted by wrapMutating carries args. An event without args is
    // a protocol violation (someone hand-appended a commit and didn't
    // include args). Fail loudly rather than silently skip.
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      log.append({
        agent: 'host',
        sessionId: 's1',
        tool: 'setDoc',
        phase: 'commit',
        target: { kind: 'doc', path: 'bogus/foo' },
        reversible: true,
      });
      const { dispatch } = stubDispatch({});

      let caught: unknown;
      try {
        await collect(replayEvents({ log, dispatch, toolContext: fakeCtx }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ReplayInvariantError);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('emits error event when dispatch returns ok:false', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      seed(log);
      const { dispatch } = stubDispatch({
        setDoc: { ok: false, summary: 'permission-denied' } satisfies ToolResult,
      });

      const events = await collect(
        replayEvents({ log, dispatch, toolContext: fakeCtx }),
      );
      const errors = events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      if (errors[0]!.type === 'error') expect(errors[0]!.message).toBe('permission-denied');
      const done = events.find((e) => e.type === 'done');
      if (done?.type === 'done') {
        expect(done.applied).toBe(1);
        expect(done.errors).toBe(1);
      }
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('targetLog option writes markers to a separate log', async () => {
    const sourceDir = freshDir();
    const targetDir = freshDir();
    try {
      const sourceLog = openEventLog({ projectId: 'dev', logDir: sourceDir });
      const targetLog = openEventLog({ projectId: 'prod', logDir: targetDir });
      seed(sourceLog);
      const { dispatch } = stubDispatch({});

      await collect(
        replayEvents({ log: sourceLog, dispatch, toolContext: fakeCtx, targetLog }),
      );

      // Source log should NOT have markers.
      const sourceMarkers = sourceLog
        .read()
        .filter((e: MutationEvent) => (e.metadata as { type?: string } | undefined)?.type === 'migrate_applied');
      expect(sourceMarkers).toHaveLength(0);
      // Target log should have 2 markers.
      const targetMarkers = targetLog
        .read()
        .filter((e: MutationEvent) => (e.metadata as { type?: string } | undefined)?.type === 'migrate_applied');
      expect(targetMarkers).toHaveLength(2);
      sourceLog.close();
      targetLog.close();
    } finally {
      rmSync(sourceDir, { recursive: true });
      rmSync(targetDir, { recursive: true });
    }
  });

  test('shouldApply resolver can skip or abort', async () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      seed(log);
      const { dispatch, calls } = stubDispatch({});

      const events = await collect(
        replayEvents({
          log,
          dispatch,
          toolContext: fakeCtx,
          shouldApply: (e) => (e.tool === 'setDoc' ? 'skip' : 'apply'),
        }),
      );
      expect(calls.map((c) => c.name)).toEqual(['writeRules']);
      const skipped = events.filter((e) => e.type === 'skipped');
      expect(skipped.length).toBe(1);
      if (skipped[0]!.type === 'skipped') expect(skipped[0]!.reason).toBe('shouldapply_skip');
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
