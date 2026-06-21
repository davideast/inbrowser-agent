import { describe, expect, test } from 'bun:test';
import {
  type ModelContextMessageLike,
  buildContextWindowSnapshot,
  compactHistoryForModel,
  createTurnMetricsAccumulator,
  estimateRequestInputComposition,
  requestInputCompositionTotal,
} from '../src/usage/index.js';

const estimateTokens = (value: string | undefined | null): number => value?.length ?? 0;

describe('@inbrowser/agent/usage request composition', () => {
  test('splits request input into system, history, tool results, draft, and tool schemas', () => {
    const composition = estimateRequestInputComposition(
      {
        systemPrompt: 'sys',
        messages: [
          { role: 'system', text: 'sys' },
          { role: 'user', text: 'old' },
          { role: 'assistant', text: 'ok', toolCalls: [{ name: 'read_file' }] },
          { role: 'tool', text: 'result', resultJson: '{"ok":true}' },
          { role: 'user', text: 'now' },
        ],
        tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
      },
      { estimateTokens },
    );

    expect(composition.system).toBe(3);
    expect(composition.history).toBeGreaterThan(0);
    expect(composition.resentToolResults).toBe('result'.length + '{"ok":true}'.length);
    expect(composition.currentPrompt).toBe(3);
    expect(composition.toolSchemas).toBeGreaterThan(0);
    expect(requestInputCompositionTotal(composition)).toBeGreaterThan(0);
  });
});

describe('@inbrowser/agent/usage context snapshots', () => {
  test('main snapshot is always the estimated next send', () => {
    const snapshot = buildContextWindowSnapshot({
      systemPrompt: 'sys',
      currentPrompt: 'draft',
      messages: [
        { id: 'u1', role: 'user', text: 'hello', createdAt: 1 },
        { id: 'a1', role: 'assistant', text: 'world', createdAt: 2 },
      ],
      tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
      limitTokens: 100,
      estimateTokens,
    });

    expect(snapshot.basis).toBe('estimated-next-send');
    expect(snapshot.usedTokens).toBeGreaterThan('sysdraft'.length);
    expect(snapshot.percentFull).toBe(snapshot.usedTokens / 100);
    expect(snapshot.breakdown.some((row) => row.id === 'draft')).toBe(true);
  });

  test('session usage uses provider rows separately from the next-send context', () => {
    const snapshot = buildContextWindowSnapshot({
      systemPrompt: 'sys',
      currentPrompt: '',
      messages: [
        {
          id: 'u1',
          role: 'user',
          text: 'prompt',
          createdAt: 1,
          turnId: 'turn-1',
        } as ModelContextMessageLike & { turnId: string },
        {
          id: 'a1',
          role: 'assistant',
          text: 'answer',
          createdAt: 2,
          turnId: 'turn-1',
          metrics: {
            tokensIn: 100,
            tokensOut: 40,
            tokensCached: 25,
            tokensReasoning: 10,
            costUsd: 0.01,
          },
        } as ModelContextMessageLike & {
          turnId: string;
          metrics: {
            tokensIn: number;
            tokensOut: number;
            tokensCached: number;
            tokensReasoning: number;
            costUsd: number;
          };
        },
      ],
      tools: [],
      estimateTokens,
      tracesByTurn: {
        'turn-1': {
          turnId: 'turn-1',
          hostCtx: { providerId: 'openrouter', providerLabel: 'OpenRouter', modelLabel: 'model' },
          requests: [
            {
              requestId: 'turn-1#0',
              turnId: 'turn-1',
              iteration: 0,
              ts: 1,
              systemPrompt: 'sys',
              messages: [{ role: 'user', text: 'prompt' }],
              tools: [],
            },
          ],
          responses: [
            {
              requestId: 'turn-1#0',
              text: 'answer',
              thinking: 'hidden',
              usage: {
                promptTokens: 100,
                outputTokens: 40,
                cachedTokens: 25,
                reasoningTokens: 10,
                costUsd: 0.01,
              },
            },
          ],
        },
      },
    });

    expect(snapshot.sessionUsage?.tokensTotal).toBe(140);
    expect(snapshot.sessionUsage?.cachedInputTokens).toBe(25);
    expect(snapshot.sessionUsage?.reasoningTokens).toBe(10);
    expect(snapshot.sessionUsage?.costUsdTotal).toBe(0.01);
    expect(snapshot.sessionUsage?.requestRows[0]).toMatchObject({
      requestId: 'turn-1#0',
      usageSource: 'provider',
      freshInputTokens: 75,
      visibleOutputTokens: 30,
      costUsd: 0.01,
    });
  });
});

describe('@inbrowser/agent/usage compaction', () => {
  test('accepts app-specific tool-call summarizers and memory-message factories', () => {
    const olderText = 'x'.repeat(200);
    const result = compactHistoryForModel(
      [
        { id: 'u1', role: 'user', text: olderText, createdAt: 1 },
        {
          id: 'a1',
          role: 'assistant',
          text: 'done',
          createdAt: 2,
          toolCalls: [{ id: 'c1', name: 'write_file', argsJson: '{}', resultJson: '{}' }],
        },
        { id: 'u2', role: 'user', text: 'recent 1', createdAt: 3 },
        { id: 'a2', role: 'assistant', text: 'recent answer', createdAt: 4 },
        { id: 'u3', role: 'user', text: 'recent 2', createdAt: 5 },
      ],
      {
        force: true,
        keepRecentUserTurns: 2,
        summarizeToolCall: (call) => `${call.name} | validation=ok`,
        createMemoryMessage: (input) => ({ ...input, createdAt: input.createdAt }),
      },
    );

    expect(result.stats.compacted).toBe(true);
    expect(result.messages[0]?.text).toContain('validation=ok');
    expect(result.messages.at(-1)?.text).toBe('recent 2');
  });
});

describe('@inbrowser/agent/usage turn metrics accumulator', () => {
  test('sums ReAct iteration metrics into whole-turn totals', () => {
    const accumulator = createTurnMetricsAccumulator();
    accumulator.add({
      tokensIn: 10,
      tokensOut: 3,
      tokensCached: 2,
      tokensReasoning: 1,
      costUsd: 0.01,
      costEstimated: true,
    });
    accumulator.add({
      tokensIn: 20,
      tokensOut: 4,
      tokensCached: 5,
      tokensReasoning: 2,
      costUsd: 0.02,
    });

    expect(accumulator.totals()).toEqual({
      tokensIn: 30,
      tokensOut: 7,
      tokensCached: 7,
      tokensReasoning: 3,
      costUsd: 0.03,
      costEstimated: true,
      iterations: 2,
    });
  });
});
