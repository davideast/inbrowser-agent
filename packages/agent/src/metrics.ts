/**
 * `MetricsCollector` implementation — pricing tables + cost
 * derivation in one place. Pure functions; no I/O.
 *
 * Pricing is per-million-token USD figures. When the provider
 * reports a cost (OpenRouter's `x-cost` header), the collector
 * skips estimation and marks `costEstimated: false`. When the
 * model isn't in the pricing table, cost is set to 0 with
 * `costEstimated: true`.
 *
 * Update pricing rows below when providers revise rates — there's
 * no API to introspect them.
 */

import type { TurnMetrics } from './types/llm.js';
import type { MetricsCollector, RecordTurnInput, SessionTotals } from './types/metrics.js';

interface PricingRow {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cached input tokens (when cache-hit). */
  cacheRead: number;
}

/**
 * Per-(provider, model) pricing table. Keys are `${llmId}:${model}`
 * to avoid collisions when two providers ship a same-named model.
 */
const PRICING: Record<string, PricingRow> = {
  'gemini:gemini-3.1-pro-preview': { input: 2.5, output: 20.0, cacheRead: 0.625 },
  'gemini:gemini-3-flash-preview': { input: 0.5, output: 4.0, cacheRead: 0.125 },
  'gemini:gemini-3.1-flash-lite': { input: 0.15, output: 0.6, cacheRead: 0.0375 },
  // OpenRouter quotes cost on the response — we don't need a row.
  // Ollama is local — no cost.
  // Nano is on-device — no cost.
};

/**
 * Look up a pricing row. Returns undefined when the model isn't
 * priced — caller skips the cost field rather than fabricating one.
 */
export function findPricing(llmId: string, model: string): PricingRow | undefined {
  return PRICING[`${llmId}:${model}`];
}

/**
 * Derive a `TurnMetrics` value from one turn's raw usage. Pure
 * function — used by both the collector below and direct callers
 * that don't need session-level aggregation.
 */
export function computeTurnMetrics(input: RecordTurnInput): TurnMetrics {
  const { llmId, model, rawUsage, isByok } = input;
  const tokensCached = rawUsage.cachedTokens ?? 0;
  const tokensReasoning = rawUsage.reasoningTokens ?? 0;
  // Provider reported cost directly (OpenRouter): trust it.
  if (typeof rawUsage.costUsd === 'number') {
    return {
      tokensIn: rawUsage.promptTokens,
      tokensOut: rawUsage.completionTokens,
      tokensCached,
      tokensReasoning,
      costUsd: rawUsage.costUsd,
      costEstimated: false,
      isByok,
    };
  }
  // Estimate from the table.
  const row = findPricing(llmId, model);
  if (!row) {
    return {
      tokensIn: rawUsage.promptTokens,
      tokensOut: rawUsage.completionTokens,
      tokensCached,
      tokensReasoning,
      costUsd: 0,
      costEstimated: true,
      isByok,
    };
  }
  // Math: cached tokens get the cache rate; the rest of the prompt
  // gets the standard input rate; output tokens (which include
  // reasoning per most providers' billing) get the output rate.
  const billedInput = Math.max(0, rawUsage.promptTokens - tokensCached);
  const costUsd =
    (billedInput * row.input) / 1_000_000 +
    (tokensCached * row.cacheRead) / 1_000_000 +
    (rawUsage.completionTokens * row.output) / 1_000_000;
  return {
    tokensIn: rawUsage.promptTokens,
    tokensOut: rawUsage.completionTokens,
    tokensCached,
    tokensReasoning,
    costUsd,
    costEstimated: true,
    isByok,
  };
}

/** Build a stateful `MetricsCollector` for one session. */
export function createMetricsCollector(): MetricsCollector {
  let totals: SessionTotals = {
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    tokensReasoning: 0,
    costUsdTotal: 0,
    turnCount: 0,
  };
  return {
    recordTurn(input) {
      const m = computeTurnMetrics(input);
      totals = {
        tokensTotal: totals.tokensTotal + m.tokensIn + m.tokensOut,
        tokensIn: totals.tokensIn + m.tokensIn,
        tokensOut: totals.tokensOut + m.tokensOut,
        tokensCached: totals.tokensCached + m.tokensCached,
        tokensReasoning: totals.tokensReasoning + m.tokensReasoning,
        costUsdTotal: totals.costUsdTotal + m.costUsd,
        turnCount: totals.turnCount + 1,
      };
      return m;
    },
    totals: () => ({ ...totals }),
    reset() {
      totals = {
        tokensTotal: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensCached: 0,
        tokensReasoning: 0,
        costUsdTotal: 0,
        turnCount: 0,
      };
    },
  };
}
