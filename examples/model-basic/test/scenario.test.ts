import { describe, expect, test } from 'bun:test';
import { runBasicModelFlow } from '../src/index.js';

describe('model-basic', () => {
  test('splits thinking, parses tool calls, and sums usage', async () => {
    const result = await runBasicModelFlow();

    expect(result.thinkingText).toBe('Need current package docs');
    expect(result.toolNames).toEqual(['search_docs']);
    expect(result.answerText).toContain('Use the workspace package');
    expect(result.usage).toEqual({
      promptTokens: 25,
      outputTokens: 14,
      cachedTokens: 4,
      reasoningTokens: 3,
      costUsd: 0.002,
    });
  });
});
