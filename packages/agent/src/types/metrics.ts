/**
 * `MetricsCollector` — translates raw provider usage into typed
 * turn metrics + session totals.
 *
 * Pure functions. Receives provider id + raw usage and returns a
 * cost breakdown. Pricing tables live here, not inside provider
 * implementations.
 */

import type { RawUsage, TurnMetrics } from './llm.js';

export interface MetricsCollector {
  /** Stamp a turn-completion event. Returns the typed metrics shape. */
  recordTurn(input: RecordTurnInput): TurnMetrics;
  /** Aggregate across all recorded turns in this collector's lifetime. */
  totals(): SessionTotals;
  /** Reset the collector — call on session reset / clear. */
  reset(): void;
}

export interface RecordTurnInput {
  llmId: string;
  rawUsage: RawUsage;
  model: string;
  durationMs: number;
  isByok?: boolean;
}

export interface SessionTotals {
  tokensTotal: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  costUsdTotal: number;
  turnCount: number;
}
