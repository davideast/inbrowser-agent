import { describe, expect, test } from 'bun:test';
import { runBasicResumableFlow } from '../src/index.js';

describe('resumable-basic', () => {
  test('resumes from an offset and keeps a final snapshot', async () => {
    const result = await runBasicResumableFlow();

    expect(result.status).toBe('done');
    expect(result.snapshotEvents).toEqual(['plan', 'write files', 'finish']);
    expect(result.allEvents.at(-1)).toEqual({ kind: 'terminal', status: 'done' });
    expect(result.resumedEvents).toEqual([
      { kind: 'event', seq: 1, value: 'write files' },
      { kind: 'event', seq: 2, value: 'finish' },
      { kind: 'terminal', status: 'done' },
    ]);
  });
});
