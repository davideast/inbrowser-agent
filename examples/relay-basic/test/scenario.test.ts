import { describe, expect, test } from 'bun:test';
import { runBasicRelayFlow } from '../src/index.js';

describe('relay-basic', () => {
  test('starts, streams, and resumes a relay job', async () => {
    const result = await runBasicRelayFlow();

    expect(result.sawDone).toBe(true);
    expect(result.events.map((event) => event.kind)).toEqual(['thinking', 'text', 'usage']);
    expect(result.events[1]).toEqual({ kind: 'text', text: 'hello from script-model' });
    expect(result.resumedEvents.map((event) => event.kind)).toEqual(['text', 'usage']);
  });
});
