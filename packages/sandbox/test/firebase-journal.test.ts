import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../src/remote/firebase/rtdb/host/journal.js';

test('journal survives reopening and pruning keeps non-replayable current-generation tombstones', () => {
  const directory = mkdtempSync(join(tmpdir(), 'firebase-journal-'));
  try {
    const journal = openJournal(directory);
    const request = {
      id: 'one',
      sessionId: 's',
      kind: 'request' as const,
      type: 'run.start',
      sentAt: 1,
      payload: { command: 'side effect' },
    };
    journal.put('s/one', {
      sessionId: 's',
      generation: 'current',
      hash: 'digest',
      acceptedAt: 1,
      completedAt: 2,
      request,
      response: { ...request, kind: 'response', replyTo: 'one' },
    });
    expect(() => openJournal(directory)).toThrow('already in use');
    journal.close();
    const reopened = openJournal(directory);
    expect(reopened.get('s/one')?.hash).toBe('digest');
    reopened.prune(3, 'current');
    expect(reopened.get('s/one')?.response?.kind).toBe('error');
    expect(reopened.get('s/one')?.request.payload).toEqual({});
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
