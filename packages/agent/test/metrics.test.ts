import { describe, expect, test } from 'bun:test';
import { computeTurnMetrics, createMetricsCollector, findPricing } from '../src/index.js';

describe('findPricing', () => {
  test('returns a row for known (provider, model) pair', () => {
    expect(findPricing('gemini', 'gemini-3.1-flash-lite')).toEqual({
      input: 0.15,
      output: 0.6,
      cacheRead: 0.0375,
    });
  });

  test('returns undefined for unknown model', () => {
    expect(findPricing('gemini', 'made-up-model')).toBeUndefined();
  });

  test('keys on provider — same model under different providers differ', () => {
    expect(findPricing('ollama', 'gemini-3.1-pro-preview')).toBeUndefined();
  });
});

describe('computeTurnMetrics', () => {
  test('uses provider-reported cost when present (OpenRouter shape)', () => {
    const m = computeTurnMetrics({
      llmId: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      durationMs: 1500,
      rawUsage: { promptTokens: 1000, completionTokens: 200, costUsd: 0.0042 },
    });
    expect(m.costUsd).toBe(0.0042);
    expect(m.costEstimated).toBe(false);
  });

  test('estimates cost from the pricing table when provider does not report it', () => {
    const m = computeTurnMetrics({
      llmId: 'gemini',
      model: 'gemini-3.1-flash-lite',
      durationMs: 1500,
      rawUsage: { promptTokens: 10000, completionTokens: 1000, cachedTokens: 2000 },
    });
    // billed input = 10000-2000 = 8000 @ 0.15/M = 0.0012
    // cached = 2000 @ 0.0375/M = 0.000075
    // output = 1000 @ 0.60/M = 0.0006
    // total ≈ 0.001875
    expect(m.costEstimated).toBe(true);
    expect(m.costUsd).toBeCloseTo(0.001875, 6);
    expect(m.tokensCached).toBe(2000);
  });

  test('returns zero cost when model is not in the pricing table', () => {
    const m = computeTurnMetrics({
      llmId: 'gemini',
      model: 'unknown-model',
      durationMs: 100,
      rawUsage: { promptTokens: 100, completionTokens: 50 },
    });
    expect(m.costUsd).toBe(0);
    expect(m.costEstimated).toBe(true);
  });

  test('threads through isByok flag', () => {
    const m = computeTurnMetrics({
      llmId: 'gemini',
      model: 'gemini-3.1-flash-lite',
      durationMs: 100,
      isByok: true,
      rawUsage: { promptTokens: 100, completionTokens: 50 },
    });
    expect(m.isByok).toBe(true);
  });
});

describe('createMetricsCollector', () => {
  test('aggregates totals across turns', () => {
    const c = createMetricsCollector();
    c.recordTurn({
      llmId: 'gemini',
      model: 'gemini-3.1-flash-lite',
      durationMs: 100,
      rawUsage: { promptTokens: 1000, completionTokens: 200 },
    });
    c.recordTurn({
      llmId: 'gemini',
      model: 'gemini-3.1-flash-lite',
      durationMs: 100,
      rawUsage: { promptTokens: 500, completionTokens: 100 },
    });
    const totals = c.totals();
    expect(totals.turnCount).toBe(2);
    expect(totals.tokensIn).toBe(1500);
    expect(totals.tokensOut).toBe(300);
    expect(totals.tokensTotal).toBe(1800);
    expect(totals.costUsdTotal).toBeGreaterThan(0);
  });

  test('reset clears totals', () => {
    const c = createMetricsCollector();
    c.recordTurn({
      llmId: 'gemini',
      model: 'gemini-3.1-flash-lite',
      durationMs: 100,
      rawUsage: { promptTokens: 1000, completionTokens: 200 },
    });
    c.reset();
    expect(c.totals().turnCount).toBe(0);
    expect(c.totals().costUsdTotal).toBe(0);
  });
});
