import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { main } from '../../src/cli/main.js';
import { openEventLog } from '../../src/events/log.js';

function captureStream() {
  const buf: Buffer[] = [];
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  (stream as unknown as { isTTY: boolean }).isTTY = false;
  (stream as PassThrough).on('data', (c: Buffer) => buf.push(c));
  return { stream, text: () => Buffer.concat(buf).toString('utf8') };
}

function seed(dir: string) {
  const log = openEventLog({ projectId: 'p1', logDir: dir });
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
  // A legacy event (no args).
  log.append({
    agent: 'host',
    sessionId: 's1',
    tool: 'setDoc',
    phase: 'commit',
    target: { kind: 'doc', path: 'items/legacy' },
    reversible: true,
  });
  log.close();
}

describe('agent migrate', () => {
  test('emits a migrate_plan event per replayable commit + summary', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-migrate-`);
    try {
      seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['migrate', '--project', 'p1', '--events-dir', dir],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const lines = out
        .text()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const plans = lines.filter((l) => l.type === 'migrate_plan');
      expect(plans).toHaveLength(2); // legacy skipped
      const summary = lines.find((l) => l.type === 'migrate_summary');
      expect(summary).toBeDefined();
      expect(summary.plannedCount).toBe(2);
      expect(summary.skippedLegacy).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('--record appends a migrate_intent marker to the log', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-migrate-`);
    try {
      seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['migrate', '--project', 'p1', '--events-dir', dir, '--record'],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const recorded = out
        .text()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .find((l) => l.type === 'migrate_intent_recorded');
      expect(recorded).toBeDefined();
      expect(recorded.plannedCount).toBe(2);

      // Re-open the log and find the intent marker.
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      const intents = log
        .read()
        .filter((e) => (e.metadata as { type?: string } | undefined)?.type === 'migrate_intent');
      expect(intents).toHaveLength(1);
      expect((intents[0]!.metadata as { plannedEventIds: string[] }).plannedEventIds).toHaveLength(
        2,
      );
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('respects --since-event cutoff', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-migrate-`);
    try {
      seed(dir);
      // Find the second commit's id to use as the cutoff.
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      const second = log.read({ phase: 'commit', tool: 'setDoc' })[0]!;
      log.close();

      const out = captureStream();
      const code = await main({
        argv: ['migrate', '--project', 'p1', '--events-dir', dir, '--since-event', second.id],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const plans = out
        .text()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((l) => l.type === 'migrate_plan');
      // setDoc commit at the cutoff is the only one with args >= cutoff.
      // (the legacy one is also >= cutoff but skipped for no args)
      expect(plans).toHaveLength(1);
      expect(plans[0].tool).toBe('setDoc');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('respects --tools allowlist', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-migrate-`);
    try {
      seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['migrate', '--project', 'p1', '--events-dir', dir, '--tools', 'writeRules'],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const plans = out
        .text()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((l) => l.type === 'migrate_plan');
      expect(plans).toHaveLength(1);
      expect(plans[0].tool).toBe('writeRules');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('rejects --project with path-traversal characters', async () => {
    const out = captureStream();
    const code = await main({
      argv: ['migrate', '--project', '../escape'],
      stdout: out.stream,
    });
    expect(code).toBe(64);
  });
});
