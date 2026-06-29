import { describe, expect, test } from 'bun:test';
import { runBasicAgentFlow } from '../src/index.js';

describe('agent-basic', () => {
  test('runs a deterministic ReAct turn with a real tool registry', async () => {
    const result = await runBasicAgentFlow();

    expect(result.thinking).toContain('mutation tool');
    expect(result.toolSummaries).toEqual(['wrote 84 chars']);
    expect(result.text).toBe('Rules were written to the session workspace.');
    expect(result.finalRules).toContain('rules_version');
    expect(result.events.map((event) => event.kind)).toContain('workspace_changed');
  });
});
