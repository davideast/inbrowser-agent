import { describe, expect, test } from 'bun:test';
import type { TraceEvent } from '@inbrowser/agent';
import {
  buildDocsContextWindowSnapshot,
  traceHostContextForConfig,
  usageFromTurnMetrics,
} from '../src/lib/agent-usage';
import type { ChatTurn } from '../src/lib/chat-store';
import { DEFAULT_MODEL_SOURCE_CONFIG } from '../src/lib/model-source';

describe('docs site agent usage adapter', () => {
  test('builds an estimated next-send context snapshot from the active draft', () => {
    const snapshot = buildDocsContextWindowSnapshot({
      messages: [],
      currentPrompt: 'How does resumable streaming work?',
      config: { ...DEFAULT_MODEL_SOURCE_CONFIG, source: 'webgpu' },
    });

    expect(snapshot.basis).toBe('estimated-next-send');
    expect(snapshot.limitTokens).toBeGreaterThan(0);
    expect(snapshot.breakdown.some((row) => row.id === 'draft')).toBe(true);
  });

  test('projects persisted turn traces into request rows and session usage', () => {
    const config = {
      ...DEFAULT_MODEL_SOURCE_CONFIG,
      source: 'openrouter' as const,
      openrouterModel: 'openai/gpt-5-mini',
    };
    const hostContext = traceHostContextForConfig(config, 'react', 'provider-default');
    const traceEvents: TraceEvent[] = [
      {
        kind: 'llm_request',
        data: {
          requestId: 'turn-1#0',
          turnId: 'turn-1',
          iteration: 0,
          ts: 1,
          systemPrompt: 'sys',
          messages: [{ role: 'user', text: 'hello' }],
          tools: [],
          llm: { id: 'openrouter:openai/gpt-5-mini', supportsTools: true },
        },
      },
      {
        kind: 'llm_response',
        data: {
          requestId: 'turn-1#0',
          ts: 2,
          text: 'answer',
          thinking: '',
          toolCalls: [],
          usage: {
            promptTokens: 25,
            outputTokens: 10,
            cachedTokens: 5,
            costUsd: 0.001,
          },
        },
      },
    ];
    const messages: ChatTurn[] = [
      { role: 'user', text: 'hello' },
      {
        role: 'assistant',
        text: 'answer',
        turnId: 'turn-1',
        metrics: {
          tokensIn: 25,
          tokensOut: 10,
          tokensCached: 5,
          tokensReasoning: 0,
          costUsd: 0.001,
          costEstimated: false,
          iterations: 1,
        },
        traceEvents,
        traceHostContext: hostContext,
      },
    ];

    const snapshot = buildDocsContextWindowSnapshot({
      messages,
      currentPrompt: '',
      config,
    });

    expect(snapshot.sessionUsage?.requestRows[0]).toMatchObject({
      requestId: 'turn-1#0',
      providerId: 'openrouter',
      usageSource: 'provider',
      cachedInputTokens: 5,
    });
    expect(snapshot.sessionUsage?.tokensTotal).toBe(35);
  });

  test('adapts accumulated turn metrics for the headless inline usage component', () => {
    expect(
      usageFromTurnMetrics({
        tokensIn: 12,
        tokensOut: 4,
        tokensCached: 3,
        tokensReasoning: 1,
        costUsd: 0,
        costEstimated: true,
        iterations: 2,
      }),
    ).toMatchObject({
      requests: 2,
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: 3,
      reasoningTokens: 1,
    });
  });
});
