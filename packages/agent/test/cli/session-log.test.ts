import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openSessionLog } from '../../src/cli/session-log.js';

function freshDir(): string {
  return mkdtempSync(`${tmpdir()}/agent-log-`);
}

describe('openSessionLog', () => {
  it('writes one NDJSON line per event', () => {
    const dir = freshDir();
    try {
      const log = openSessionLog({ logDir: dir, sessionId: 'sess-abc' });
      log.write({ type: 'a' });
      log.write({ type: 'b' });
      log.close();
      const path = `${dir}/sess-abc.ndjson`;
      expect(readFileSync(path, 'utf8')).toBe('{"type":"a"}\n{"type":"b"}\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns a no-op writer when disabled', () => {
    const log = openSessionLog({ sessionId: 'x', disabled: true });
    expect(log.path).toBeNull();
    log.write({ type: 'ignored' });
    log.close();
  });

  it('creates the parent directory if missing', () => {
    const root = freshDir();
    try {
      const nested = `${root}/nested/dir`;
      const log = openSessionLog({ logDir: nested, sessionId: 's' });
      log.write({ type: 'hi' });
      log.close();
      expect(readFileSync(`${nested}/s.ndjson`, 'utf8')).toBe('{"type":"hi"}\n');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('appends across reopens', () => {
    const dir = freshDir();
    try {
      const a = openSessionLog({ logDir: dir, sessionId: 'sx' });
      a.write({ n: 1 });
      a.close();
      const b = openSessionLog({ logDir: dir, sessionId: 'sx' });
      b.write({ n: 2 });
      b.close();
      const out = readFileSync(`${dir}/sx.ndjson`, 'utf8');
      expect(out).toBe('{"n":1}\n{"n":2}\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
