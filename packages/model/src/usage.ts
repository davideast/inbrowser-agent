import type { ModelUsage } from './contract.js';

export type ModelUsageInput = Partial<ModelUsage> | null | undefined;

export function emptyModelUsage(): ModelUsage {
  return { promptTokens: 0, outputTokens: 0 };
}

export function normalizeModelUsage(input: ModelUsageInput): ModelUsage {
  const promptTokens = nonNegative(input?.promptTokens) ?? 0;
  const outputTokens = nonNegative(input?.outputTokens) ?? 0;
  const cachedTokens = nonNegative(input?.cachedTokens);
  const reasoningTokens = nonNegative(input?.reasoningTokens);
  const costUsd = nonNegative(input?.costUsd);
  return {
    promptTokens,
    outputTokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export function sumModelUsage(usages: Iterable<ModelUsageInput>): ModelUsage {
  let promptTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let hasCachedTokens = false;
  let hasReasoningTokens = false;
  let hasCostUsd = false;

  for (const raw of usages) {
    const usage = normalizeModelUsage(raw);
    promptTokens += usage.promptTokens;
    outputTokens += usage.outputTokens;
    if (usage.cachedTokens !== undefined) {
      cachedTokens += usage.cachedTokens;
      hasCachedTokens = true;
    }
    if (usage.reasoningTokens !== undefined) {
      reasoningTokens += usage.reasoningTokens;
      hasReasoningTokens = true;
    }
    if (usage.costUsd !== undefined) {
      costUsd += usage.costUsd;
      hasCostUsd = true;
    }
  }

  return {
    promptTokens,
    outputTokens,
    ...(hasCachedTokens ? { cachedTokens } : {}),
    ...(hasReasoningTokens ? { reasoningTokens } : {}),
    ...(hasCostUsd ? { costUsd } : {}),
  };
}

function nonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}
