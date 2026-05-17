import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { openEventLog } from '../../src/events/log.js';
import { main } from '../../src/cli/main.js';

function captureStream() {
  const buf: Buffer[] = [];
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  (stream as unknown as { isTTY: boolean }).isTTY = false;
  (stream as PassThrough).on('data', (c: Buffer) => buf.push(c));
  return { stream, text: () => Buffer.concat(buf).toString('utf8') };
}

function seedMixed(dir: string) {
  const log = openEventLog({ projectId: 'p1', logDir: dir });
  // Real mutation.
  log.append({
    agent: 'host',
    sessionId: 's1',
    tool: 'setDoc',
    args: { path: 'items/a', data: { v: 1 } },
    phase: 'commit',
    target: { kind: 'doc', path: 'items/a' },
    reversible: true,
  });
  // Bookkeeping: migrate_applied marker.
  log.append({
    agent: 'replay',
    sessionId: 's-replay',
    tool: 'setDoc',
    phase: 'commit',
    target: { kind: 'other', path: 'replay/abc' },
    reversible: false,
    metadata: { type: 'migrate_applied', appliedEventId: 'abc' },
  });
  // Bookkeeping: migrate_intent marker.
  log.append({
    agent: 'host',
    sessionId: 's-migrate',
    tool: 'migrate',
    phase: 'commit',
    target: { kind: 'other', path: 'migrate/intent' },
    reversible: false,
    metadata: { type: 'migrate_intent', plannedEventIds: ['abc', 'def'] },
  });
  log.close();
}

describe('agent events bookkeeping filter', () => {
  test('default output hides migrate_applied + migrate_intent markers', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-events-bk-`);
    try {
      seedMixed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['events', '--project', 'p1', '--events-dir', dir],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const lines = out.text().trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0].tool).toBe('setDoc');
      expect(lines[0].target.kind).toBe('doc');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('--include-bookkeeping shows everything', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-events-bk-`);
    try {
      seedMixed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['events', '--project', 'p1', '--events-dir', dir, '--include-bookkeeping'],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const lines = out.text().trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      const types = lines.map(
        (l) => (l.metadata as { type?: string } | undefined)?.type ?? '(none)',
      );
      expect(types).toEqual(['(none)', 'migrate_applied', 'migrate_intent']);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
