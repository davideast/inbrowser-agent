import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildRollbackEvent,
  generateEventId,
  HOST_AGENT_ID,
  openEventLog,
  defaultProjectLogDir,
  EventTooLargeError,
} from '../../src/events/log.js';
import { defaultEventValueCodec, identityCodec, ENVELOPE_KEY } from '../../src/events/codec.js';
import type { MutationEvent } from '../../src/types/events.js';

function freshDir(): string {
  return mkdtempSync(`${tmpdir()}/agent-events-`);
}

describe('generateEventId', () => {
  test('is base36, time-prefixed, sortable', () => {
    const a = generateEventId(() => 1_000_000);
    const b = generateEventId(() => 2_000_000);
    expect(a < b).toBe(true);
    // Format: <ts>[-<seq>]-<rand>. The no-sequence overload of
    // generateEventId emits the short form; appendEvent always passes
    // the sequence and emits the long form.
    expect(a).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
  });
});

describe('defaultProjectLogDir', () => {
  test('lives under $HOME/.pyric/projects', () => {
    expect(defaultProjectLogDir()).toContain('/.pyric/projects');
  });
});

describe('openEventLog', () => {
  test('rejects projectId with disallowed characters', () => {
    expect(() => openEventLog({ projectId: '../escape' })).toThrow();
    expect(() => openEventLog({ projectId: 'has space' })).toThrow();
  });

  test('appends events as NDJSON', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      log.append({
        agent: HOST_AGENT_ID,
        sessionId: 's1',
        tool: 'writeRules',
        phase: 'plan',
        target: { kind: 'workspace', path: 'workspace.rules' },
        reversible: true,
      });
      log.append({
        agent: HOST_AGENT_ID,
        sessionId: 's1',
        tool: 'writeRules',
        phase: 'commit',
        target: { kind: 'workspace', path: 'workspace.rules' },
        reversible: true,
        reverseOp: { tool: 'writeRules', args: { source: 'rules_version="2"' } },
      });
      log.close();

      const raw = readFileSync(`${dir}/p1/events.ndjson`, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);
      const plan = JSON.parse(lines[0]!) as MutationEvent;
      expect(plan.phase).toBe('plan');
      expect(plan.tool).toBe('writeRules');
      expect(plan.agent).toBe('host');
      const commit = JSON.parse(lines[1]!) as MutationEvent;
      expect(commit.phase).toBe('commit');
      expect(commit.reverseOp?.tool).toBe('writeRules');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('auto-generates id + ts when absent', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir, now: () => 12345 });
      const event = log.append({
        agent: HOST_AGENT_ID,
        sessionId: 's1',
        tool: 'writeRules',
        phase: 'plan',
        target: { kind: 'workspace', path: 'workspace.rules' },
        reversible: true,
      });
      log.close();
      expect(event.id).toMatch(/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
      expect(event.ts).toBe('1970-01-01T00:00:12.345Z');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('read() filters by sessionId, tool, phase, agent, since/until', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      log.append({
        agent: 'a1',
        sessionId: 's1',
        tool: 'writeRules',
        phase: 'plan',
        target: { kind: 'workspace', path: 'workspace.rules' },
        reversible: true,
        ts: '2026-01-01T00:00:00.000Z',
      });
      log.append({
        agent: 'a1',
        sessionId: 's1',
        tool: 'writeRules',
        phase: 'commit',
        target: { kind: 'workspace', path: 'workspace.rules' },
        reversible: true,
        reverseOp: { tool: 'writeRules', args: {} },
        ts: '2026-01-02T00:00:00.000Z',
      });
      log.append({
        agent: 'a2',
        sessionId: 's2',
        tool: 'deployRules',
        phase: 'commit',
        target: { kind: 'rules', path: 'projects/x/rulesets/active' },
        reversible: false,
        ts: '2026-01-03T00:00:00.000Z',
      });

      expect(log.read({ sessionId: 's1' })).toHaveLength(2);
      expect(log.read({ tool: 'deployRules' })).toHaveLength(1);
      expect(log.read({ phase: 'commit' })).toHaveLength(2);
      expect(log.read({ agent: 'a2' })).toHaveLength(1);
      expect(log.read({ since: '2026-01-02T00:00:00.000Z' })).toHaveLength(2);
      expect(log.read({ until: '2026-01-03T00:00:00.000Z' })).toHaveLength(2);
      expect(log.read({ targetKind: 'rules' })).toHaveLength(1);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('skips malformed NDJSON lines without crashing', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      log.append({
        agent: HOST_AGENT_ID,
        sessionId: 's1',
        tool: 'a',
        phase: 'plan',
        target: { kind: 'workspace', path: 'x' },
        reversible: false,
      });
      log.close();
      // Corrupt the file with a half-written line.
      const path = `${dir}/p1/events.ndjson`;
      const existing = readFileSync(path, 'utf8');
      require('node:fs').writeFileSync(path, existing + '{not json\n');

      const log2 = openEventLog({ projectId: 'p1', logDir: dir });
      expect(log2.read()).toHaveLength(1);
      log2.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('rejects writes after close', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      log.close();
      expect(() =>
        log.append({
          agent: HOST_AGENT_ID,
          sessionId: 's1',
          tool: 'a',
          phase: 'plan',
          target: { kind: 'workspace', path: 'x' },
          reversible: false,
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('buildRollbackEvent', () => {
  test('marks the event as terminal + links to original via metadata', () => {
    const original: MutationEvent = {
      id: 'abc',
      ts: '2026-01-01T00:00:00.000Z',
      agent: 'host',
      sessionId: 's1',
      tool: 'writeRules',
      phase: 'commit',
      target: { kind: 'workspace', path: 'workspace.rules' },
      reversible: true,
      reverseOp: { tool: 'writeRules', args: {} },
    };
    const draft = buildRollbackEvent({
      original,
      reason: 'undo',
      agent: 'host',
      sessionId: 's1',
      reverseOp: original.reverseOp,
    });
    expect(draft.phase).toBe('rollback');
    expect(draft.reversible).toBe(false);
    expect(draft.metadata?.['reason']).toBe('undo');
    expect(draft.metadata?.['originalEventId']).toBe('abc');
  });
});

describe('openEventLog — codec round-trip', () => {
  test('round-trips Date / Uint8Array / bigint through args + before + after', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      const ts = new Date('2026-05-11T13:00:00.000Z');
      const bytes = new Uint8Array([1, 2, 3]);
      const big = 12345n;
      log.append({
        agent: HOST_AGENT_ID,
        sessionId: 's1',
        tool: 'writeRich',
        args: { ts, bytes, big },
        phase: 'commit',
        target: { kind: 'doc', path: 'items/rich' },
        before: { ts },
        after: { bytes, big },
        reversible: true,
        reverseOp: { tool: 'writeRich', args: { ts } },
      });
      log.close();

      const log2 = openEventLog({ projectId: 'p1', logDir: dir });
      const events = log2.read();
      expect(events).toHaveLength(1);
      const ev = events[0]!;
      const a = ev.args as { ts: Date; bytes: Uint8Array; big: bigint };
      expect(a.ts).toBeInstanceOf(Date);
      expect(a.ts.toISOString()).toBe('2026-05-11T13:00:00.000Z');
      expect(a.bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(a.bytes)).toEqual([1, 2, 3]);
      expect(a.big).toBe(12345n);
      expect((ev.before as { ts: Date }).ts).toBeInstanceOf(Date);
      expect((ev.after as { bytes: Uint8Array }).bytes).toBeInstanceOf(Uint8Array);
      expect((ev.reverseOp!.args as { ts: Date }).ts).toBeInstanceOf(Date);
      log2.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('writes JSON envelopes to the file (visible on raw read)', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      log.append({
        agent: HOST_AGENT_ID,
        sessionId: 's1',
        tool: 't',
        args: { d: new Date('2026-05-11T00:00:00.000Z') },
        phase: 'commit',
        target: { kind: 'doc', path: 'x' },
        reversible: false,
      });
      log.close();
      const raw = require('node:fs').readFileSync(`${dir}/p1/events.ndjson`, 'utf8');
      expect(raw).toContain(`"${ENVELOPE_KEY}":"Date"`);
      expect(raw).toContain('"iso":"2026-05-11T00:00:00.000Z"');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('identityCodec passes everything through (no envelope on the wire)', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({
        projectId: 'p1',
        logDir: dir,
        codec: identityCodec,
      });
      log.append({
        agent: HOST_AGENT_ID,
        sessionId: 's1',
        tool: 't',
        args: { plain: 'json' },
        phase: 'commit',
        target: { kind: 'doc', path: 'x' },
        reversible: false,
      });
      log.close();
      const raw = require('node:fs').readFileSync(`${dir}/p1/events.ndjson`, 'utf8');
      expect(raw).not.toContain(ENVELOPE_KEY);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('openEventLog — size cap (atomicity guard)', () => {
  test('rejects events larger than maxEventBytes', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({
        projectId: 'p1',
        logDir: dir,
        maxEventBytes: 512,
      });
      const huge = 'x'.repeat(2000);
      let caught: unknown;
      try {
        log.append({
          agent: HOST_AGENT_ID,
          sessionId: 's1',
          tool: 'huge',
          args: { blob: huge },
          phase: 'commit',
          target: { kind: 'doc', path: 'items/huge' },
          reversible: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EventTooLargeError);
      expect((caught as EventTooLargeError).tool).toBe('huge');
      expect((caught as EventTooLargeError).cap).toBe(512);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('accepts events at the cap (default 64KB headroom)', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      // ~30KB payload — well within the 64KB default.
      const payload = 'x'.repeat(30 * 1024);
      log.append({
        agent: HOST_AGENT_ID,
        sessionId: 's1',
        tool: 'okSize',
        args: { blob: payload },
        phase: 'commit',
        target: { kind: 'doc', path: 'items/ok' },
        reversible: false,
      });
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('openEventLog — applied marker cache', () => {
  test('appliedEventIds() is empty for a fresh log', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      expect(log.appliedEventIds().size).toBe(0);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('appliedEventIds() finds events referenced by migrate_applied markers', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      // Append a marker referencing event id 'abc-001'.
      log.append({
        agent: 'replay',
        sessionId: 's',
        tool: 'whatever',
        phase: 'commit',
        target: { kind: 'other', path: 'replay/abc-001' },
        reversible: false,
        metadata: { type: 'migrate_applied', appliedEventId: 'abc-001' },
      });
      expect(log.appliedEventIds().has('abc-001')).toBe(true);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('cache invalidates on append so newly-added markers show up', () => {
    const dir = freshDir();
    try {
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      expect(log.appliedEventIds().has('e1')).toBe(false);
      log.append({
        agent: 'replay',
        sessionId: 's',
        tool: 't',
        phase: 'commit',
        target: { kind: 'other', path: 'replay/e1' },
        reversible: false,
        metadata: { type: 'migrate_applied', appliedEventId: 'e1' },
      });
      expect(log.appliedEventIds().has('e1')).toBe(true);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
