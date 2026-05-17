import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  generateRunId,
  openRunLog,
  type RunRecord,
} from '../../src/metrics/runs.js';

function freshDir(): string {
  return mkdtempSync(`${tmpdir()}/runs-`);
}

const sampleRecord: Omit<RunRecord, 'runId' | 'ts'> = {
  agent: 'hello-firestore',
  tool: 'design_firestore_hello_schema',
  mode: 'inverse',
  outcome: 'ok',
  durationMs: 7,
  eventIds: ['e1', 'e2'],
};

describe('generateRunId', () => {
  test('is sortable + has run- prefix', () => {
    const a = generateRunId(() => 1_000_000);
    const b = generateRunId(() => 2_000_000);
    expect(a < b).toBe(true);
    expect(a.startsWith('run-')).toBe(true);
  });
});

describe('openRunLog', () => {
  test('rejects bad projectId', () => {
    expect(() => openRunLog({ projectId: '../x' })).toThrow();
  });

  test('appends + reads NDJSON', () => {
    const dir = freshDir();
    try {
      const log = openRunLog({ projectId: 'p1', logDir: dir });
      log.append({ runId: 'run-1', ts: '2026-01-01T00:00:00Z', ...sampleRecord });
      log.append({
        runId: 'run-2',
        ts: '2026-01-01T00:00:01Z',
        ...sampleRecord,
        tool: 'write_firestore_hello_to_workspace',
        outcome: 'failed',
        errorSummary: 'boom',
      });
      log.close();

      const reopen = openRunLog({ projectId: 'p1', logDir: dir });
      const all = reopen.read();
      expect(all).toHaveLength(2);
      expect(all[0]!.tool).toBe('design_firestore_hello_schema');
      expect(all[1]!.outcome).toBe('failed');
      expect(all[1]!.errorSummary).toBe('boom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('filters by mode + outcome', () => {
    const dir = freshDir();
    try {
      const log = openRunLog({ projectId: 'p1', logDir: dir });
      log.append({ runId: 'a', ts: 't', ...sampleRecord });
      log.append({ runId: 'b', ts: 't', ...sampleRecord, mode: 'inference' });
      log.append({ runId: 'c', ts: 't', ...sampleRecord, outcome: 'failed' });

      expect(log.read({ mode: 'inverse' })).toHaveLength(2);
      expect(log.read({ mode: 'inference' })).toHaveLength(1);
      expect(log.read({ outcome: 'failed' })).toHaveLength(1);
      expect(log.read({ tool: 'design_firestore_hello_schema' })).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips malformed lines', () => {
    const dir = freshDir();
    try {
      const log = openRunLog({ projectId: 'p1', logDir: dir });
      log.append({ runId: 'a', ts: 't', ...sampleRecord });
      // Inject a corrupt line by writing through the same file path.
      const corruptPath = `${dir}/p1/runs.ndjson`;
      const fs = require('node:fs') as typeof import('node:fs');
      fs.appendFileSync(corruptPath, 'not-json\n');
      log.append({ runId: 'b', ts: 't', ...sampleRecord });
      expect(log.read()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
