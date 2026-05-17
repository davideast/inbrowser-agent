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
  (stream as PassThrough).on('data', (chunk: Buffer) => buf.push(chunk));
  return {
    stream,
    text: () => Buffer.concat(buf).toString('utf8'),
  };
}

function seed(dir: string) {
  const log = openEventLog({ projectId: 'p1', logDir: dir });
  const plan = log.append({
    agent: 'host',
    sessionId: 's1',
    tool: 'writeRules',
    phase: 'plan',
    target: { kind: 'workspace', path: 'workspace.rules' },
    reversible: true,
  });
  const commit = log.append({
    agent: 'host',
    sessionId: 's1',
    tool: 'writeRules',
    phase: 'commit',
    target: { kind: 'workspace', path: 'workspace.rules' },
    reversible: true,
    reverseOp: { tool: 'writeRules', args: { source: 'prev' } },
    metadata: { planEventId: plan.id, ok: true },
  });
  const irreversible = log.append({
    agent: 'host',
    sessionId: 's1',
    tool: 'enableService',
    phase: 'commit',
    target: { kind: 'service', path: 'firebasestorage.googleapis.com' },
    reversible: false,
    irreversibleReason: 'service enablement is one-way',
  });
  log.close();
  return { plan, commit, irreversible };
}

describe('agent events', () => {
  test('streams each event as one NDJSON line', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-events-cli-`);
    try {
      seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['events', '--project', 'p1', '--events-dir', dir],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const lines = out
        .text()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      expect(lines[0].phase).toBe('plan');
      expect(lines[1].phase).toBe('commit');
      expect(lines[2].phase).toBe('commit');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('filters by tool', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-events-cli-`);
    try {
      seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['events', '--project', 'p1', '--events-dir', dir, '--tool', 'enableService'],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const lines = out
        .text()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0].tool).toBe('enableService');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('errors out when --project is missing', async () => {
    const out = captureStream();
    const code = await main({ argv: ['events'], stdout: out.stream });
    expect(code).toBe(1);
    const parsed = JSON.parse(out.text().trim().split('\n')[0]!);
    expect(parsed.type).toBe('error');
  });

  test('rejects path-traversal in --project via hardening', async () => {
    const out = captureStream();
    const code = await main({
      argv: ['events', '--project', '../escape'],
      stdout: out.stream,
    });
    expect(code).toBe(64);
    const parsed = JSON.parse(out.text().trim().split('\n')[0]!);
    expect(parsed.name).toBe('InputHardeningError');
  });
});

describe('agent undo', () => {
  test('--dry-run prints the rollback plan without appending', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-undo-cli-`);
    try {
      const { commit } = seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['undo', '--project', 'p1', '--events-dir', dir, '--event', commit.id, '--dry-run'],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(out.text().trim().split('\n')[0]!);
      expect(parsed.type).toBe('undo_plan');
      expect(parsed.reverseOp.tool).toBe('writeRules');

      // No rollback event should have been appended.
      const log = openEventLog({ projectId: 'p1', logDir: dir });
      const rollbacks = log.read({ phase: 'rollback' });
      expect(rollbacks).toHaveLength(0);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('records a rollback event when invoked for real', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-undo-cli-`);
    try {
      const { commit } = seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['undo', '--project', 'p1', '--events-dir', dir, '--event', commit.id],
        stdout: out.stream,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(out.text().trim().split('\n')[0]!);
      expect(parsed.type).toBe('undo_recorded');
      expect(parsed.nextStep).toContain('invoke');

      const log = openEventLog({ projectId: 'p1', logDir: dir });
      const rollbacks = log.read({ phase: 'rollback' });
      expect(rollbacks).toHaveLength(1);
      expect(rollbacks[0]!.metadata?.['originalEventId']).toBe(commit.id);
      log.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('refuses to undo an irreversible event', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-undo-cli-`);
    try {
      const { irreversible } = seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['undo', '--project', 'p1', '--events-dir', dir, '--event', irreversible.id],
        stdout: out.stream,
      });
      expect(code).toBe(64);
      const parsed = JSON.parse(out.text().trim().split('\n')[0]!);
      expect(parsed.name).toBe('Irreversible');
      expect(parsed.reason).toBe('service enablement is one-way');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('refuses to undo a plan-phase event', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-undo-cli-`);
    try {
      const { plan } = seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['undo', '--project', 'p1', '--events-dir', dir, '--event', plan.id],
        stdout: out.stream,
      });
      expect(code).toBe(64);
      const parsed = JSON.parse(out.text().trim().split('\n')[0]!);
      expect(parsed.name).toBe('NotCommit');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('refuses to undo the same event twice', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-undo-cli-`);
    try {
      const { commit } = seed(dir);
      const out1 = captureStream();
      await main({
        argv: ['undo', '--project', 'p1', '--events-dir', dir, '--event', commit.id],
        stdout: out1.stream,
      });
      const out2 = captureStream();
      const code = await main({
        argv: ['undo', '--project', 'p1', '--events-dir', dir, '--event', commit.id],
        stdout: out2.stream,
      });
      expect(code).toBe(64);
      const parsed = JSON.parse(out2.text().trim().split('\n')[0]!);
      expect(parsed.name).toBe('AlreadyUndone');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('reports NotFound for an unknown event id', async () => {
    const dir = mkdtempSync(`${tmpdir()}/agent-undo-cli-`);
    try {
      seed(dir);
      const out = captureStream();
      const code = await main({
        argv: ['undo', '--project', 'p1', '--events-dir', dir, '--event', 'nope-nope'],
        stdout: out.stream,
      });
      expect(code).toBe(64);
      const parsed = JSON.parse(out.text().trim().split('\n')[0]!);
      expect(parsed.name).toBe('NotFound');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
