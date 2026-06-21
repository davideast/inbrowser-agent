import { describe, expect, test } from 'bun:test';
import {
  emptyModelUsage,
  normalizeModelUsage,
  sumModelUsage,
} from '../src/index.js';

describe('ModelUsage helpers', () => {
  test('emptyModelUsage returns the canonical zero accounting shape', () => {
    expect(emptyModelUsage()).toEqual({ promptTokens: 0, outputTokens: 0 });
  });

  test('normalizeModelUsage clamps invalid or negative values', () => {
    expect(
      normalizeModelUsage({
        promptTokens: -10,
        outputTokens: Number.NaN,
        cachedTokens: 3,
        reasoningTokens: -2,
        costUsd: 0.04,
      }),
    ).toEqual({
      promptTokens: 0,
      outputTokens: 0,
      cachedTokens: 3,
      reasoningTokens: 0,
      costUsd: 0.04,
    });
  });

  test('sumModelUsage preserves optional dimensions when any input reports them', () => {
    expect(
      sumModelUsage([
        { promptTokens: 10, outputTokens: 3, cachedTokens: 4 },
        { promptTokens: 5, outputTokens: 7, reasoningTokens: 2, costUsd: 0.01 },
      ]),
    ).toEqual({
      promptTokens: 15,
      outputTokens: 10,
      cachedTokens: 4,
      reasoningTokens: 2,
      costUsd: 0.01,
    });
  });
});
