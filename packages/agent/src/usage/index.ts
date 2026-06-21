import type { ModelUsage, TurnMetrics } from '../types/llm.js';

export type ContextWindowBasis = 'estimated-next-send';
export type ContextWindowStatus = 'unknown' | 'low' | 'medium' | 'high' | 'critical';

export interface RequestCompositionMessageLike {
  role?: string;
  text?: string;
  callId?: string;
  name?: string;
  toolCalls?: unknown;
  resultJson?: string;
}

export interface RequestCompositionToolLike {
  name?: string;
  description?: string;
  parameters?: unknown;
}

export interface RequestCompositionTraceLike {
  systemPrompt?: string;
  messages?: readonly RequestCompositionMessageLike[];
  tools?: readonly RequestCompositionToolLike[];
  toolDeclarations?: readonly RequestCompositionToolLike[];
}

export interface RequestInputComposition {
  system: number;
  history: number;
  resentToolResults: number;
  currentPrompt: number;
  toolSchemas: number;
}

export interface ContextWindowBreakdownRow {
  id: 'system' | 'history' | 'tool-results' | 'tool-schemas' | 'draft';
  label: string;
  tokens: number;
  color: string;
  estimated: boolean;
}

export interface ModelContextToolCallLike {
  id: string;
  name: string;
  argsJson: string;
  resultJson?: string;
  summary?: string;
  thinkingUpToHere?: string;
}

export interface ModelContextMessageLike {
  id: string;
  role: string;
  text: string;
  thinking?: string;
  toolCalls?: readonly ModelContextToolCallLike[];
  createdAt?: number;
}

export interface ModelContextCompactionOptions<
  TMessage extends ModelContextMessageLike = ModelContextMessageLike,
> {
  force?: boolean;
  thresholdChars?: number;
  keepRecentUserTurns?: number;
  summarizeToolCall?: (call: ModelContextToolCallLike) => string;
  createMemoryMessage?: (
    input: { id: string; role: 'assistant'; text: string; createdAt: number },
    older: readonly TMessage[],
  ) => TMessage;
}

export interface ModelContextCompactionStats {
  compacted: boolean;
  originalChars: number;
  compactedChars: number;
  bytesSaved: number;
  turnsCompacted: number;
  messagesCompacted: number;
}

export interface ModelContextCompactionResult<
  TMessage extends ModelContextMessageLike = ModelContextMessageLike,
> {
  messages: TMessage[];
  stats: ModelContextCompactionStats;
}

export interface ContextWindowCompactionPreview {
  rawTokens: number;
  currentTokens: number;
  compactedTokens: number;
  automaticSavedTokens: number;
  manualSavedTokens: number;
  savedTokens: number;
  stats: ModelContextCompactionStats;
  retains: string[];
  loses: string[];
}

export interface ContextWindowPromptCostEstimate {
  costUsd: number;
  estimated: boolean;
  source: string;
  inputPricePerMillion: number;
  cacheReadPricePerMillion: number;
}

export interface ContextWindowPricing {
  current: ContextWindowPromptCostEstimate | null;
  compacted: ContextWindowPromptCostEstimate | null;
  savedCostUsd: number | null;
}

export interface SessionTurnUsage {
  id: string;
  label: string;
  requestCount: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  freshInputTokens: number;
  visibleOutputTokens: number;
  tokensTotal: number;
  costUsd?: number;
  multiplierContribution?: number;
}

export type ContextWindowInputComposition = RequestInputComposition;

export type SessionUsageCategoryId =
  | 'fresh-input'
  | 'cached-input'
  | 'visible-output'
  | 'reasoning-output'
  | 'reported-total';

export type ContextWindowSessionSpendCategoryId = SessionUsageCategoryId;

export interface SessionUsageDetailRow {
  id: string;
  label: string;
  tokens: number;
  color: string;
  estimated: boolean;
  source: 'provider-reported' | 'estimated-from-traces';
  description: string;
}

export interface SessionUsageCategoryDetail {
  id: SessionUsageCategoryId;
  label: string;
  source: 'provider-reported' | 'estimated-from-traces' | 'mixed' | 'unavailable';
  note: string;
  rows: SessionUsageDetailRow[];
}

export interface SessionRequestUsage {
  id: string;
  requestId: string;
  turnId: string;
  iteration: number;
  ts?: number;
  providerId?: string;
  providerLabel?: string;
  modelLabel?: string;
  strategy?: string;
  strategySource?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  freshInputTokens: number;
  visibleOutputTokens: number;
  tokensTotal: number;
  costUsd?: number;
  usageSource: 'provider' | 'estimate';
  composition: ContextWindowInputComposition;
  messageCount: number;
  toolResultMessageCount: number;
  toolNames: string[];
  toolSchemaNames: string[];
  emittedToolCalls: SessionToolRef[];
  resentToolResults: SessionToolRef[];
  cacheInsight?: SessionCacheInsight;
}

export interface SessionCacheInsight {
  hitRate: number;
  cachedTokens: number;
  freshTokens: number;
  knownMinimumTokens?: number;
  meetsKnownMinimum?: boolean;
  likelyStablePrefixTokens: number;
  providerMode: string;
  explanation: string;
}

export interface SessionToolRef {
  name: string;
  callId?: string;
  messageId?: string;
  tokensEstimated?: number;
}

export interface SessionTokenUsage {
  turns: number;
  requests: number | null;
  tokensTotal: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsdTotal?: number;
  workMultiplier?: number;
  averageRequestTokens?: number;
  turnRows: SessionTurnUsage[];
  requestRows: SessionRequestUsage[];
  categoryDetails: Partial<Record<SessionUsageCategoryId, SessionUsageCategoryDetail>>;
  teachingNotes: {
    providerUsage: string;
    estimatedComposition: string;
    contextVsSpend: string;
  };
}

export interface ContextWindowSnapshot {
  basis: ContextWindowBasis;
  usedTokens: number;
  limitTokens?: number;
  percentFull?: number;
  status: ContextWindowStatus;
  breakdown: ContextWindowBreakdownRow[];
  compaction: ModelContextCompactionStats;
  compactionPreview: ContextWindowCompactionPreview;
  pricing: ContextWindowPricing;
  toolCount: number;
  sessionUsage?: SessionTokenUsage;
}

export interface ContextWindowRequestLike extends RequestCompositionTraceLike {
  requestId?: string;
  turnId?: string;
  iteration?: number;
  ts?: number;
}

export interface ContextWindowResponseLike {
  requestId?: string;
  text?: string;
  thinking?: string;
  toolCalls?: unknown;
  usage?: Partial<ModelUsage>;
}

export interface ContextWindowTraceLike {
  turnId: string;
  requests: readonly ContextWindowRequestLike[];
  responses: readonly ContextWindowResponseLike[];
  hostCtx?: {
    providerId?: string;
    providerLabel?: string;
    modelLabel?: string;
    strategy?: string;
    strategySource?: string;
  };
}

export type ContextWindowTokenEstimator = (value: string | undefined | null) => number;

export type ContextWindowPromptCostEstimator = (input: {
  providerId: string;
  modelId: string;
  promptTokens: number;
  cachedTokens: number;
}) => ContextWindowPromptCostEstimate | null;

export interface BuildContextWindowSnapshotOptions<
  TMessage extends ModelContextMessageLike = ModelContextMessageLike,
> {
  messages: readonly TMessage[];
  currentPrompt?: string;
  systemPrompt: string;
  tools: readonly RequestCompositionToolLike[];
  limitTokens?: number;
  providerId?: string;
  modelId?: string;
  estimateTokens?: ContextWindowTokenEstimator;
  estimatePromptInputCost?: ContextWindowPromptCostEstimator;
  compactHistory?: (
    messages: readonly TMessage[],
    opts?: ModelContextCompactionOptions<TMessage>,
  ) => ModelContextCompactionResult<TMessage>;
  compactionOptions?: ModelContextCompactionOptions<TMessage>;
  sessionTurns?: number;
  sessionRequests?: number | null;
  sessionTokensTotal?: number;
  sessionInputTokens?: number;
  sessionOutputTokens?: number;
  sessionCachedInputTokens?: number;
  sessionReasoningTokens?: number;
  sessionCostUsdTotal?: number;
  tracesByTurn?: Record<string, ContextWindowTraceLike>;
}

export type ContextWindowSessionTurn = SessionTurnUsage;
export type ContextWindowSessionDetailRow = SessionUsageDetailRow;
export type ContextWindowSessionCategoryDetail = SessionUsageCategoryDetail;
export type ContextWindowSessionRequest = SessionRequestUsage;
export type ContextWindowSessionCacheInsight = SessionCacheInsight;
export type ContextWindowSessionToolRef = SessionToolRef;
export type ContextWindowSessionUsage = SessionTokenUsage;

export const MODEL_CONTEXT_COMPACTION_THRESHOLD_CHARS = 80_000;
export const MODEL_CONTEXT_RECENT_USER_TURNS = 2;

const BREAKDOWN_META: Record<
  ContextWindowBreakdownRow['id'],
  Omit<ContextWindowBreakdownRow, 'tokens' | 'estimated'>
> = {
  system: { id: 'system', label: 'System prompt', color: '#a4d4a8' },
  history: { id: 'history', label: 'Conversation', color: '#8bb7ff' },
  'tool-results': { id: 'tool-results', label: 'Tool results', color: '#f0c36a' },
  'tool-schemas': { id: 'tool-schemas', label: 'Tool schemas', color: '#c9a7ff' },
  draft: { id: 'draft', label: 'Current draft', color: '#f08a8a' },
};

const EMPTY_COMPACTION: ModelContextCompactionStats = {
  compacted: false,
  originalChars: 0,
  compactedChars: 0,
  bytesSaved: 0,
  turnsCompacted: 0,
  messagesCompacted: 0,
};

const COMPACTION_RETAINS = [
  'the most recent 2 user turns verbatim',
  'older user prompts and assistant outcomes as deterministic memory',
  'older tool names, one-line summaries, write paths, and validation summaries',
];

const COMPACTION_LOSES = [
  'verbatim older assistant text and reasoning',
  'full older tool arguments and bulky tool results',
  'old assistant/tool-call pairing details beyond the retained recent turns',
];

const MAX_MEMORY_CHARS = 16_000;
const MAX_MEMORY_TOOL_LINES = 80;

export function estimateRequestInputComposition(
  request: RequestCompositionTraceLike,
  opts: { estimateTokens?: ContextWindowTokenEstimator } = {},
): RequestInputComposition {
  const estimateTokens = opts.estimateTokens ?? defaultTokenEstimate;
  const messages = request.messages ?? [];
  const systemPrompt = request.systemPrompt ?? '';
  const userMessages = messages.filter((message) => message.role === 'user');
  const currentPromptMessage = userMessages[userMessages.length - 1];
  let system = tokenEstimate(systemPrompt, estimateTokens);
  let history = 0;
  let resentToolResults = 0;
  const currentPrompt = tokenEstimate(currentPromptMessage?.text, estimateTokens);

  for (const message of messages) {
    const textTokens = tokenEstimate(message.text, estimateTokens);
    const toolCallTokens = tokenEstimate(safeStringify(message.toolCalls), estimateTokens);
    const resultTokens = tokenEstimate(message.resultJson, estimateTokens);
    if (message.role === 'system') {
      if (!systemPrompt || message.text !== systemPrompt) system += textTokens;
    } else if (message.role === 'tool') {
      resentToolResults += textTokens + resultTokens;
    } else if (message === currentPromptMessage) {
    } else {
      history += textTokens + toolCallTokens + resultTokens;
    }
  }

  return {
    system,
    history,
    resentToolResults,
    currentPrompt,
    toolSchemas: tokenEstimate(
      safeStringify(request.tools ?? request.toolDeclarations ?? []),
      estimateTokens,
    ),
  };
}

export function requestInputCompositionTotal(composition: RequestInputComposition): number {
  return (
    composition.system +
    composition.history +
    composition.resentToolResults +
    composition.currentPrompt +
    composition.toolSchemas
  );
}

export function collectRequestToolNames(request: RequestCompositionTraceLike): string[] {
  const names = new Set<string>();
  for (const tool of request.tools ?? request.toolDeclarations ?? []) {
    if (tool.name) names.add(tool.name);
  }
  for (const message of request.messages ?? []) {
    const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    for (const call of calls) {
      if (call && typeof call === 'object') {
        const name = (call as { name?: unknown }).name;
        if (typeof name === 'string') names.add(name);
      }
    }
  }
  return [...names].sort();
}

export function buildContextWindowSnapshot<TMessage extends ModelContextMessageLike>(
  opts: BuildContextWindowSnapshotOptions<TMessage>,
): ContextWindowSnapshot {
  const prompt = opts.currentPrompt?.trim() ?? '';
  const compact = opts.compactHistory ?? compactHistoryForModel;
  const estimateTokens = opts.estimateTokens ?? defaultTokenEstimate;
  const rawRows = rowsFromParts({
    systemPrompt: opts.systemPrompt,
    messages: opts.messages,
    tools: opts.tools,
    prompt,
    estimated: true,
    estimateTokens,
  });
  const compacted = compact(opts.messages, opts.compactionOptions);
  const rows = rowsFromParts({
    systemPrompt: opts.systemPrompt,
    messages: compacted.messages,
    tools: opts.tools,
    prompt,
    estimated: true,
    estimateTokens,
  });
  const forceCompacted = compact(opts.messages, {
    ...opts.compactionOptions,
    force: true,
  });
  const forceRows = rowsFromParts({
    systemPrompt: opts.systemPrompt,
    messages: forceCompacted.messages,
    tools: opts.tools,
    prompt,
    estimated: true,
    estimateTokens,
  });
  const rawTokens = totalTokens(Object.values(rawRows));
  const usedTokens = totalTokens(Object.values(rows));
  const forceTokens = totalTokens(Object.values(forceRows));
  return finalizeSnapshot({
    rows: Object.values(rows),
    limitTokens: opts.limitTokens,
    compaction: compacted.stats,
    compactionPreview: buildCompactionPreview({
      rawTokens,
      currentTokens: usedTokens,
      compactedTokens: forceTokens,
      stats: forceCompacted.stats,
    }),
    pricing: buildPricing({
      providerId: opts.providerId,
      modelId: opts.modelId,
      estimatePromptInputCost: opts.estimatePromptInputCost,
      currentTokens: usedTokens,
      compactedTokens: forceTokens,
    }),
    toolCount: opts.tools.length,
    sessionUsage: sessionUsageFromOptions(opts, usedTokens, estimateTokens),
  });
}

export function formatContextTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 100_000) {
    const k = n / 1000;
    const s = k.toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

export function formatContextRatio(snapshot: ContextWindowSnapshot): string {
  const used = formatContextTokens(snapshot.usedTokens);
  if (!snapshot.limitTokens) return `${used} tokens used`;
  return `${used} / ${formatContextTokens(snapshot.limitTokens)} tokens used`;
}

export function formatContextPercent(snapshot: ContextWindowSnapshot): string {
  if (snapshot.percentFull === undefined) return 'limit unknown';
  return `${Math.round(snapshot.percentFull * 100)}% full`;
}

export function compactHistoryForModel<TMessage extends ModelContextMessageLike>(
  messages: readonly TMessage[],
  opts: ModelContextCompactionOptions<TMessage> = {},
): ModelContextCompactionResult<TMessage> {
  const thresholdChars = opts.thresholdChars ?? MODEL_CONTEXT_COMPACTION_THRESHOLD_CHARS;
  const keepRecent = Math.max(1, opts.keepRecentUserTurns ?? MODEL_CONTEXT_RECENT_USER_TURNS);
  const originalChars = estimateHistoryChars(messages);
  if (!opts.force && originalChars <= thresholdChars) {
    return {
      messages: messages.slice(),
      stats: unchangedStats(originalChars),
    };
  }

  const userIndexes = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  if (userIndexes.length <= keepRecent) {
    return {
      messages: messages.slice(),
      stats: unchangedStats(originalChars),
    };
  }

  const keepStart = userIndexes[userIndexes.length - keepRecent]!;
  const older = messages.slice(0, keepStart);
  const recent = messages.slice(keepStart);
  if (older.length === 0) {
    return {
      messages: messages.slice(),
      stats: unchangedStats(originalChars),
    };
  }

  const memory = buildMemoryMessage(older, opts);
  const compacted = [memory, ...recent];
  const compactedChars = estimateHistoryChars(compacted);
  return {
    messages: compacted,
    stats: {
      compacted: true,
      originalChars,
      compactedChars,
      bytesSaved: Math.max(0, originalChars - compactedChars),
      turnsCompacted: countUserTurns(older),
      messagesCompacted: older.length,
    },
  };
}

export function estimateHistoryChars(messages: readonly ModelContextMessageLike[]): number {
  let total = 0;
  for (const message of messages) {
    total +=
      message.id.length +
      message.role.length +
      message.text.length +
      (message.thinking?.length ?? 0) +
      32;
    for (const call of message.toolCalls ?? []) {
      total +=
        call.id.length +
        call.name.length +
        call.argsJson.length +
        (call.resultJson?.length ?? 0) +
        (call.summary?.length ?? 0) +
        (call.thinkingUpToHere?.length ?? 0) +
        32;
    }
  }
  return total;
}

export interface AggregatedTurnMetrics {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  costUsd: number;
  costEstimated: boolean;
  isByok?: boolean;
  iterations: number;
}

export interface TurnMetricsAccumulator {
  add(metrics: TurnMetrics): AggregatedTurnMetrics;
  totals(): AggregatedTurnMetrics;
  reset(): void;
}

export function createTurnMetricsAccumulator(): TurnMetricsAccumulator {
  let agg = zeroAggregatedTurnMetrics();
  return {
    add(metrics) {
      agg = {
        tokensIn: agg.tokensIn + (metrics.tokensIn ?? 0),
        tokensOut: agg.tokensOut + (metrics.tokensOut ?? 0),
        tokensCached: agg.tokensCached + (metrics.tokensCached ?? 0),
        tokensReasoning: agg.tokensReasoning + (metrics.tokensReasoning ?? 0),
        costUsd: agg.costUsd + (metrics.costUsd ?? 0),
        costEstimated: agg.costEstimated || metrics.costEstimated === true,
        ...(metrics.isByok !== undefined
          ? { isByok: metrics.isByok }
          : agg.isByok !== undefined
            ? { isByok: agg.isByok }
            : {}),
        iterations: agg.iterations + 1,
      };
      return agg;
    },
    totals() {
      return agg;
    },
    reset() {
      agg = zeroAggregatedTurnMetrics();
    },
  };
}

function rowsFromParts({
  systemPrompt,
  messages,
  tools,
  prompt,
  estimated,
  estimateTokens,
}: {
  systemPrompt: string;
  messages: readonly ModelContextMessageLike[];
  tools: readonly RequestCompositionToolLike[];
  prompt: string;
  estimated: boolean;
  estimateTokens: ContextWindowTokenEstimator;
}): Record<ContextWindowBreakdownRow['id'], ContextWindowBreakdownRow> {
  const rows = emptyRows(estimated);
  rows.system.tokens = tokenEstimate(systemPrompt, estimateTokens);
  for (const message of messages) {
    rows.history.tokens +=
      tokenEstimate(message.text, estimateTokens) + tokenEstimate(message.thinking, estimateTokens);
    rows['tool-results'].tokens += toolCallTokens(message.toolCalls, estimateTokens);
  }
  rows['tool-schemas'].tokens = toolSchemaTokens(tools, estimateTokens);
  rows.draft.tokens = tokenEstimate(prompt, estimateTokens);
  return rows;
}

function emptyRows(
  estimated: boolean,
): Record<ContextWindowBreakdownRow['id'], ContextWindowBreakdownRow> {
  return {
    system: { ...BREAKDOWN_META.system, tokens: 0, estimated },
    history: { ...BREAKDOWN_META.history, tokens: 0, estimated },
    'tool-results': { ...BREAKDOWN_META['tool-results'], tokens: 0, estimated },
    'tool-schemas': { ...BREAKDOWN_META['tool-schemas'], tokens: 0, estimated },
    draft: { ...BREAKDOWN_META.draft, tokens: 0, estimated },
  };
}

function finalizeSnapshot({
  rows,
  limitTokens,
  compaction,
  compactionPreview,
  pricing,
  toolCount,
  sessionUsage,
}: {
  rows: ContextWindowBreakdownRow[];
  limitTokens?: number;
  compaction: ModelContextCompactionStats;
  compactionPreview: ContextWindowCompactionPreview;
  pricing: ContextWindowPricing;
  toolCount: number;
  sessionUsage?: SessionTokenUsage;
}): ContextWindowSnapshot {
  const breakdown = rows.filter((row) => row.tokens > 0);
  const usedTokens = breakdown.reduce((sum, row) => sum + row.tokens, 0);
  const percentFull = limitTokens && limitTokens > 0 ? usedTokens / limitTokens : undefined;
  return {
    basis: 'estimated-next-send',
    usedTokens,
    ...(limitTokens !== undefined ? { limitTokens } : {}),
    ...(percentFull !== undefined ? { percentFull } : {}),
    status: statusFor(percentFull),
    breakdown,
    compaction,
    compactionPreview,
    pricing,
    toolCount,
    ...(sessionUsage ? { sessionUsage } : {}),
  };
}

function totalTokens(rows: readonly ContextWindowBreakdownRow[]): number {
  return rows.reduce((sum, row) => sum + row.tokens, 0);
}

function buildCompactionPreview({
  rawTokens,
  currentTokens,
  compactedTokens,
  stats,
}: {
  rawTokens: number;
  currentTokens: number;
  compactedTokens: number;
  stats: ModelContextCompactionStats;
}): ContextWindowCompactionPreview {
  const automaticSavedTokens = Math.max(0, rawTokens - currentTokens);
  const manualSavedTokens = Math.max(0, currentTokens - compactedTokens);
  return {
    rawTokens,
    currentTokens,
    compactedTokens,
    automaticSavedTokens,
    manualSavedTokens,
    savedTokens: manualSavedTokens,
    stats,
    retains: COMPACTION_RETAINS,
    loses: COMPACTION_LOSES,
  };
}

function sessionUsageFromOptions<TMessage extends ModelContextMessageLike>(
  opts: BuildContextWindowSnapshotOptions<TMessage>,
  currentContextTokens: number,
  estimateTokens: ContextWindowTokenEstimator,
): ContextWindowSnapshot['sessionUsage'] {
  const turnRows = sessionTurnRowsFromMessages(
    opts.messages,
    opts.tracesByTurn,
    currentContextTokens,
  );
  const requestRows = sessionRequestRowsFromTraces(
    opts.tracesByTurn,
    opts.messages,
    estimateTokens,
  );
  if (
    opts.sessionTurns === undefined &&
    opts.sessionTokensTotal === undefined &&
    opts.sessionInputTokens === undefined &&
    opts.sessionOutputTokens === undefined &&
    turnRows.length === 0 &&
    requestRows.length === 0
  ) {
    return undefined;
  }
  const derived = sumSessionTurnRows(turnRows);
  const inputTokens = Math.max(0, opts.sessionInputTokens ?? derived.inputTokens);
  const outputTokens = Math.max(0, opts.sessionOutputTokens ?? derived.outputTokens);
  const tokensTotal = Math.max(0, opts.sessionTokensTotal ?? inputTokens + outputTokens);
  const requests =
    opts.sessionRequests === undefined
      ? derived.requests
      : opts.sessionRequests === null
        ? null
        : Math.max(0, opts.sessionRequests);
  const workMultiplier =
    currentContextTokens > 0 && tokensTotal > 0 ? tokensTotal / currentContextTokens : undefined;
  const averageRequestTokens =
    typeof requests === 'number' && requests > 0 ? tokensTotal / requests : undefined;
  const cachedInputTokens = Math.max(0, opts.sessionCachedInputTokens ?? derived.cachedInputTokens);
  const reasoningTokens = Math.max(0, opts.sessionReasoningTokens ?? derived.reasoningTokens);
  const costUsdTotal = opts.sessionCostUsdTotal ?? derived.costUsdTotal;
  return {
    turns: opts.sessionTurns ?? turnRows.length,
    requests,
    tokensTotal,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    ...(costUsdTotal !== undefined ? { costUsdTotal } : {}),
    ...(workMultiplier !== undefined ? { workMultiplier } : {}),
    ...(averageRequestTokens !== undefined ? { averageRequestTokens } : {}),
    turnRows,
    requestRows,
    categoryDetails: buildSessionCategoryDetails({
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      tokensTotal,
      requestRows,
    }),
    teachingNotes: {
      providerUsage:
        'Provider usage totals are authoritative for input, cache, output, and reasoning when the provider reports them.',
      estimatedComposition:
        'Source-level input slices are estimated from saved provider-visible request traces using the configured token estimator.',
      contextVsSpend:
        'The context window is one next request; session spend is every provider request already made.',
    },
  };
}

function sessionRequestRowsFromTraces(
  tracesByTurn: Record<string, ContextWindowTraceLike> | undefined,
  messages: readonly ModelContextMessageLike[],
  estimateTokens: ContextWindowTokenEstimator,
): SessionRequestUsage[] {
  if (!tracesByTurn) return [];
  const toolIndex = buildToolCallIndex(messages);
  const rows: SessionRequestUsage[] = [];
  for (const trace of Object.values(tracesByTurn)) {
    const responsesById = new Map<string, ContextWindowResponseLike>();
    for (const response of trace.responses) {
      if (response.requestId) responsesById.set(response.requestId, response);
    }
    for (const [index, request] of trace.requests.entries()) {
      const requestId = request.requestId ?? `${trace.turnId}#${request.iteration ?? index}`;
      const response = responsesById.get(requestId) ?? trace.responses[index];
      const composition = estimateRequestInputComposition(request, { estimateTokens });
      const usage = response?.usage;
      const estimatedInput = requestInputCompositionTotal(composition);
      const reasoningTokens = Math.max(
        0,
        nonNegative(usage?.reasoningTokens) ?? tokenEstimate(response?.thinking, estimateTokens),
      );
      const inputTokens = Math.max(0, nonNegative(usage?.promptTokens) ?? estimatedInput);
      const outputTokens = Math.max(
        0,
        nonNegative(usage?.outputTokens) ??
          tokenEstimate(response?.text, estimateTokens) + reasoningTokens,
      );
      const cachedInputTokens = Math.min(
        inputTokens,
        Math.max(0, nonNegative(usage?.cachedTokens) ?? 0),
      );
      const boundedReasoningTokens = Math.min(outputTokens, reasoningTokens);
      const iteration = request.iteration ?? index;
      const toolSchemaNames = toolNamesFromDeclarations(request);
      const emittedToolCalls = toolRefsFromResponseToolCalls(
        response,
        toolIndex,
        trace.turnId,
        estimateTokens,
      );
      const resentToolResults = toolRefsFromToolResultMessages(
        request,
        toolIndex,
        trace.turnId,
        estimateTokens,
      );
      const previousRequest = trace.requests[index - 1];
      const previousComposition = previousRequest
        ? estimateRequestInputComposition(previousRequest, { estimateTokens })
        : undefined;
      const freshInputTokens = Math.max(0, inputTokens - cachedInputTokens);
      rows.push({
        id: requestId,
        requestId,
        turnId: request.turnId ?? trace.turnId,
        iteration,
        ...(typeof request.ts === 'number' ? { ts: request.ts } : {}),
        ...(trace.hostCtx?.providerId ? { providerId: trace.hostCtx.providerId } : {}),
        ...(trace.hostCtx?.providerLabel ? { providerLabel: trace.hostCtx.providerLabel } : {}),
        ...(trace.hostCtx?.modelLabel ? { modelLabel: trace.hostCtx.modelLabel } : {}),
        ...(trace.hostCtx?.strategy ? { strategy: trace.hostCtx.strategy } : {}),
        ...(trace.hostCtx?.strategySource ? { strategySource: trace.hostCtx.strategySource } : {}),
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningTokens: boundedReasoningTokens,
        freshInputTokens,
        visibleOutputTokens: Math.max(0, outputTokens - boundedReasoningTokens),
        tokensTotal: inputTokens + outputTokens,
        ...(typeof usage?.costUsd === 'number' ? { costUsd: usage.costUsd } : {}),
        usageSource: usage ? 'provider' : 'estimate',
        composition,
        messageCount: request.messages?.length ?? 0,
        toolResultMessageCount:
          request.messages?.filter((message) => message.role === 'tool').length ?? 0,
        toolNames: collectRequestToolNames(request),
        toolSchemaNames,
        emittedToolCalls,
        resentToolResults,
        cacheInsight: buildRequestCacheInsight({
          providerId: trace.hostCtx?.providerId,
          modelLabel: trace.hostCtx?.modelLabel,
          iteration,
          inputTokens,
          cachedInputTokens,
          freshInputTokens,
          composition,
          previousComposition,
        }),
      });
    }
  }
  rows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.requestId.localeCompare(b.requestId));
  return rows;
}

interface ToolCallIndexHit {
  name: string;
  callId: string;
  messageId: string;
}

function buildToolCallIndex(
  messages: readonly ModelContextMessageLike[],
): Map<string, ToolCallIndexHit> {
  const index = new Map<string, ToolCallIndexHit>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const turnId = (message as { turnId?: unknown }).turnId;
    if (typeof turnId !== 'string') continue;
    for (const call of message.toolCalls ?? []) {
      index.set(toolIndexKey(turnId, call.id), {
        name: call.name,
        callId: call.id,
        messageId: message.id,
      });
    }
  }
  return index;
}

function toolIndexKey(turnId: string, callId: string): string {
  return `${turnId}:${callId}`;
}

function toolNamesFromDeclarations(req: ContextWindowRequestLike): string[] {
  const names = new Set<string>();
  for (const tool of req.tools ?? req.toolDeclarations ?? []) {
    if (tool.name) names.add(tool.name);
  }
  return [...names].sort();
}

function toolRefsFromResponseToolCalls(
  response: ContextWindowResponseLike | undefined,
  index: Map<string, ToolCallIndexHit>,
  turnId: string,
  estimateTokens: ContextWindowTokenEstimator,
): SessionToolRef[] {
  const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
  return calls.map((raw): SessionToolRef => {
    const call =
      raw && typeof raw === 'object'
        ? (raw as { callId?: unknown; id?: unknown; name?: unknown; args?: unknown })
        : {};
    const callId =
      typeof call.callId === 'string'
        ? call.callId
        : typeof call.id === 'string'
          ? call.id
          : undefined;
    const hit = callId ? index.get(toolIndexKey(turnId, callId)) : undefined;
    const name = typeof call.name === 'string' ? call.name : (hit?.name ?? 'tool_call');
    return {
      name,
      ...(callId ? { callId } : {}),
      ...(hit?.messageId ? { messageId: hit.messageId } : {}),
      tokensEstimated:
        tokenEstimate(name, estimateTokens) +
        tokenEstimate(safeStringify(call.args), estimateTokens),
    };
  });
}

function toolRefsFromToolResultMessages(
  req: ContextWindowRequestLike,
  index: Map<string, ToolCallIndexHit>,
  turnId: string,
  estimateTokens: ContextWindowTokenEstimator,
): SessionToolRef[] {
  const refs: SessionToolRef[] = [];
  for (const message of req.messages ?? []) {
    if (message.role !== 'tool') continue;
    const callId = message.callId;
    const hit = callId ? index.get(toolIndexKey(turnId, callId)) : undefined;
    refs.push({
      name: message.name ?? hit?.name ?? 'tool_result',
      ...(callId ? { callId } : {}),
      ...(hit?.messageId ? { messageId: hit.messageId } : {}),
      tokensEstimated:
        tokenEstimate(message.text, estimateTokens) +
        tokenEstimate(message.resultJson, estimateTokens),
    });
  }
  return refs;
}

function buildRequestCacheInsight({
  providerId,
  modelLabel,
  iteration,
  inputTokens,
  cachedInputTokens,
  freshInputTokens,
  composition,
  previousComposition,
}: {
  providerId?: string;
  modelLabel?: string;
  iteration: number;
  inputTokens: number;
  cachedInputTokens: number;
  freshInputTokens: number;
  composition: ContextWindowInputComposition;
  previousComposition?: ContextWindowInputComposition;
}): SessionCacheInsight {
  const knownMinimumTokens = knownCacheMinimumTokens(providerId, modelLabel);
  const likelyStablePrefixTokens = previousComposition
    ? Math.min(inputTokens, repeatedInputShapeTokens(composition, previousComposition))
    : 0;
  const hitRate = inputTokens > 0 ? cachedInputTokens / inputTokens : 0;
  const meetsKnownMinimum =
    knownMinimumTokens === undefined ? undefined : inputTokens >= knownMinimumTokens;
  return {
    hitRate,
    cachedTokens: cachedInputTokens,
    freshTokens: freshInputTokens,
    ...(knownMinimumTokens !== undefined ? { knownMinimumTokens } : {}),
    ...(meetsKnownMinimum !== undefined ? { meetsKnownMinimum } : {}),
    likelyStablePrefixTokens,
    providerMode: cacheProviderMode(providerId),
    explanation: cacheExplanation({
      cachedInputTokens,
      freshInputTokens,
      iteration,
      meetsKnownMinimum,
      likelyStablePrefixTokens,
    }),
  };
}

function repeatedInputShapeTokens(
  current: ContextWindowInputComposition,
  previous: ContextWindowInputComposition,
): number {
  return (
    Math.min(current.system, previous.system) +
    Math.min(current.history, previous.history) +
    Math.min(current.toolSchemas, previous.toolSchemas) +
    Math.min(current.resentToolResults, previous.resentToolResults)
  );
}

function knownCacheMinimumTokens(providerId?: string, modelLabel?: string): number | undefined {
  if (providerId !== 'gemini') return undefined;
  if (
    !modelLabel ||
    /(^|\s)(gemini\s*)?3\.5\s+flash/i.test(modelLabel) ||
    /^flash$/i.test(modelLabel)
  ) {
    return 4096;
  }
  return undefined;
}

function cacheProviderMode(providerId?: string): string {
  switch (providerId) {
    case 'gemini':
      return 'Gemini implicit caching';
    case 'openrouter':
      return 'OpenRouter provider cache telemetry';
    case 'claude':
      return 'Claude prompt caching telemetry';
    default:
      return 'Provider cache telemetry';
  }
}

function cacheExplanation({
  cachedInputTokens,
  freshInputTokens,
  iteration,
  meetsKnownMinimum,
  likelyStablePrefixTokens,
}: {
  cachedInputTokens: number;
  freshInputTokens: number;
  iteration: number;
  meetsKnownMinimum?: boolean;
  likelyStablePrefixTokens: number;
}): string {
  if (cachedInputTokens > 0 && freshInputTokens > 0) {
    return 'Partial cache hit: stable prefix hit cache; new tool results/current prompt were fresh.';
  }
  if (cachedInputTokens > 0) {
    return likelyStablePrefixTokens > 0
      ? 'Cache hit: large repeated prefix detected; provider reported cached tokens.'
      : 'Cache hit: provider reported cached tokens for this request.';
  }
  if (iteration === 0) {
    return 'No provider-reported cached tokens; this is the first request in the turn, so there may be no warm prompt prefix yet.';
  }
  if (meetsKnownMinimum === false) {
    return 'No provider-reported cached tokens; this request is below the known prompt-caching threshold.';
  }
  return 'No provider-reported cached tokens; likely changed prefix, expired cache, different route, or provider chose not to serve a cache hit.';
}

function buildSessionCategoryDetails({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  reasoningTokens,
  tokensTotal,
  requestRows,
}: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  tokensTotal: number;
  requestRows: readonly SessionRequestUsage[];
}): SessionTokenUsage['categoryDetails'] {
  const freshInputTokens = Math.max(0, inputTokens - Math.min(inputTokens, cachedInputTokens));
  const boundedReasoning = Math.min(outputTokens, reasoningTokens);
  const visibleOutputTokens = Math.max(0, outputTokens - boundedReasoning);
  const classified =
    freshInputTokens +
    Math.min(inputTokens, cachedInputTokens) +
    visibleOutputTokens +
    boundedReasoning;
  const remainder = Math.max(0, tokensTotal - classified);
  return {
    'fresh-input': {
      id: 'fresh-input',
      label: 'Fresh input',
      source: requestRows.length > 0 ? 'mixed' : 'unavailable',
      note:
        requestRows.length > 0
          ? 'Provider totals say how much fresh input was billed; the source slices below distribute that total by estimated request composition.'
          : 'Source-level input composition needs saved provider-visible request traces. This restored session only has high-level token metrics.',
      rows:
        requestRows.length > 0
          ? scaledCompositionRows(sumRequestCompositions(requestRows), freshInputTokens)
          : [],
    },
    'cached-input': {
      id: 'cached-input',
      label: 'Cached input',
      source: cachedInputTokens > 0 ? 'provider-reported' : 'unavailable',
      note:
        cachedInputTokens > 0
          ? 'Cache-read tokens are provider-reported. They still appear in usage and are usually cheaper when the provider exposes cache pricing.'
          : 'No provider-reported cached input has appeared in this session yet.',
      rows:
        cachedInputTokens > 0
          ? [
              {
                id: 'cache-read',
                label: 'Cache-read input',
                tokens: Math.min(inputTokens, cachedInputTokens),
                color: '#a4d4a8',
                estimated: false,
                source: 'provider-reported',
                description: 'Repeated prompt/context served from provider cache when reported.',
              },
            ]
          : [],
    },
    'visible-output': {
      id: 'visible-output',
      label: 'Visible output',
      source: visibleOutputTokens > 0 ? 'provider-reported' : 'unavailable',
      note:
        visibleOutputTokens > 0
          ? 'Visible output is provider-reported completion text after hidden reasoning is removed when available.'
          : 'No visible output tokens have been reported yet.',
      rows:
        visibleOutputTokens > 0
          ? [
              {
                id: 'assistant-output',
                label: 'Assistant-visible output',
                tokens: visibleOutputTokens,
                color: '#f0c36a',
                estimated: false,
                source: 'provider-reported',
                description:
                  'Generated app, rules, code, repairs, tests, and final assistant text before local preview renders.',
              },
            ]
          : [],
    },
    'reasoning-output': {
      id: 'reasoning-output',
      label: 'Reasoning output',
      source: boundedReasoning > 0 ? 'provider-reported' : 'unavailable',
      note:
        boundedReasoning > 0
          ? 'Reasoning output is separated only when provider telemetry exposes it.'
          : 'No reasoning output was reported for this session.',
      rows:
        boundedReasoning > 0
          ? [
              {
                id: 'reasoning',
                label: 'Hidden reasoning output',
                tokens: boundedReasoning,
                color: '#c9a7ff',
                estimated: false,
                source: 'provider-reported',
                description:
                  'Hidden model reasoning tokens reported separately from visible completion text.',
              },
            ]
          : [],
    },
    'reported-total': {
      id: 'reported-total',
      label: 'Reported total',
      source: remainder > 0 ? 'provider-reported' : 'unavailable',
      note:
        remainder > 0
          ? 'These tokens were included in the provider total but did not fit the available input/output/cache/reasoning split.'
          : 'No unclassified reported-total tokens remain after the available usage split.',
      rows:
        remainder > 0
          ? [
              {
                id: 'reported-total',
                label: 'Unclassified provider total',
                tokens: remainder,
                color: '#8aa0b8',
                estimated: false,
                source: 'provider-reported',
                description: 'Provider total remainder when detailed usage fields are missing.',
              },
            ]
          : [],
    },
  };
}

function scaledCompositionRows(
  composition: ContextWindowInputComposition,
  targetTokens: number,
): SessionUsageDetailRow[] {
  if (targetTokens <= 0) return [];
  const total = requestInputCompositionTotal(composition);
  if (total <= 0) return [];
  return [
    compositionRow(
      'system',
      'System prompt',
      composition.system,
      total,
      targetTokens,
      '#a4d4a8',
      'Agent instructions and workspace references sent with model requests.',
    ),
    compositionRow(
      'history',
      'Conversation/history',
      composition.history,
      total,
      targetTokens,
      '#8bb7ff',
      'Prior user, assistant, and tool-call context re-sent across requests.',
    ),
    compositionRow(
      'tool-schemas',
      'Tool schemas',
      composition.toolSchemas,
      total,
      targetTokens,
      '#c9a7ff',
      'Function/tool declarations available to the model for these requests.',
    ),
    compositionRow(
      'resent-tool-results',
      'Resent tool results',
      composition.resentToolResults,
      total,
      targetTokens,
      '#f0c36a',
      'Earlier tool results that appeared again in later provider-visible messages.',
    ),
    compositionRow(
      'current-prompt',
      'Current prompt',
      composition.currentPrompt,
      total,
      targetTokens,
      '#f08a8a',
      'The active user prompt portion of each request.',
    ),
  ].filter((row) => row.tokens > 0);
}

function compositionRow(
  id: string,
  label: string,
  componentTokens: number,
  compositionTotal: number,
  targetTokens: number,
  color: string,
  description: string,
): SessionUsageDetailRow {
  return {
    id,
    label,
    tokens: Math.round(targetTokens * (componentTokens / compositionTotal)),
    color,
    estimated: true,
    source: 'estimated-from-traces',
    description,
  };
}

function sumRequestCompositions(
  requestRows: readonly SessionRequestUsage[],
): ContextWindowInputComposition {
  return requestRows.reduce<ContextWindowInputComposition>(
    (sum, row) => ({
      system: sum.system + row.composition.system,
      history: sum.history + row.composition.history,
      resentToolResults: sum.resentToolResults + row.composition.resentToolResults,
      currentPrompt: sum.currentPrompt + row.composition.currentPrompt,
      toolSchemas: sum.toolSchemas + row.composition.toolSchemas,
    }),
    {
      system: 0,
      history: 0,
      resentToolResults: 0,
      currentPrompt: 0,
      toolSchemas: 0,
    },
  );
}

function sessionTurnRowsFromMessages(
  messages: readonly ModelContextMessageLike[],
  tracesByTurn: Record<string, ContextWindowTraceLike> | undefined,
  currentContextTokens: number,
): SessionTurnUsage[] {
  const rows: SessionTurnUsage[] = [];
  for (const message of messages) {
    const metrics = (message as { metrics?: TurnMetrics & { tokensTotal?: number } }).metrics;
    if (message.role !== 'assistant' || !metrics) continue;
    const inputTokens = Math.max(0, metrics.tokensIn ?? 0);
    const outputTokens = Math.max(0, metrics.tokensOut ?? 0);
    const cachedInputTokens = Math.min(
      inputTokens,
      Math.max(0, metrics.tokensCached ?? (metrics as { cachedTokens?: number }).cachedTokens ?? 0),
    );
    const reasoningTokens = Math.min(
      outputTokens,
      Math.max(
        0,
        metrics.tokensReasoning ?? (metrics as { reasoningTokens?: number }).reasoningTokens ?? 0,
      ),
    );
    const tokensTotal = Math.max(0, metrics.tokensTotal ?? inputTokens + outputTokens);
    const turnId = (message as { turnId?: unknown }).turnId;
    const requestCount =
      typeof turnId === 'string' ? (tracesByTurn?.[turnId]?.requests.length ?? null) : null;
    const multiplierContribution =
      currentContextTokens > 0 && tokensTotal > 0 ? tokensTotal / currentContextTokens : undefined;
    rows.push({
      id: message.id,
      label: `Turn ${rows.length + 1}`,
      requestCount,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      freshInputTokens: Math.max(0, inputTokens - cachedInputTokens),
      visibleOutputTokens: Math.max(0, outputTokens - reasoningTokens),
      tokensTotal,
      ...(typeof metrics.costUsd === 'number' ? { costUsd: metrics.costUsd } : {}),
      ...(multiplierContribution !== undefined ? { multiplierContribution } : {}),
    });
  }
  return rows;
}

function sumSessionTurnRows(rows: readonly SessionTurnUsage[]): {
  requests: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsdTotal?: number;
} {
  let requests: number | null = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningTokens = 0;
  let costUsdTotal = 0;
  let hasCost = false;
  for (const row of rows) {
    if (row.requestCount === null) {
      requests = null;
    } else if (requests !== null) {
      requests += row.requestCount;
    }
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cachedInputTokens += row.cachedInputTokens;
    reasoningTokens += row.reasoningTokens;
    if (typeof row.costUsd === 'number') {
      costUsdTotal += row.costUsd;
      hasCost = true;
    }
  }
  return {
    requests,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    ...(hasCost ? { costUsdTotal } : {}),
  };
}

function buildPricing({
  providerId,
  modelId,
  estimatePromptInputCost,
  currentTokens,
  compactedTokens,
}: {
  providerId?: string;
  modelId?: string;
  estimatePromptInputCost?: ContextWindowPromptCostEstimator;
  currentTokens: number;
  compactedTokens: number;
}): ContextWindowPricing {
  if (!providerId || !modelId || !estimatePromptInputCost) {
    return { current: null, compacted: null, savedCostUsd: null };
  }
  const current = estimatePromptInputCost({
    providerId,
    modelId,
    promptTokens: currentTokens,
    cachedTokens: 0,
  });
  const compacted = estimatePromptInputCost({
    providerId,
    modelId,
    promptTokens: compactedTokens,
    cachedTokens: 0,
  });
  return {
    current,
    compacted,
    savedCostUsd: current && compacted ? Math.max(0, current.costUsd - compacted.costUsd) : null,
  };
}

function unchangedStats(chars: number): ModelContextCompactionStats {
  return {
    compacted: false,
    originalChars: chars,
    compactedChars: chars,
    bytesSaved: 0,
    turnsCompacted: 0,
    messagesCompacted: 0,
  };
}

interface OlderTurn<TMessage extends ModelContextMessageLike> {
  user: TMessage | null;
  assistant: TMessage[];
  system: TMessage[];
}

function buildMemoryMessage<TMessage extends ModelContextMessageLike>(
  older: readonly TMessage[],
  opts: ModelContextCompactionOptions<TMessage>,
): TMessage {
  const lines: string[] = [
    'Prior conversation memory (deterministically compacted for model context only; the full visible transcript is preserved in the UI/session):',
  ];
  const turns = groupOlderTurns(older);
  let toolLines = 0;
  turns.forEach((turn, index) => {
    lines.push('');
    lines.push(`Turn ${index + 1}:`);
    if (turn.user) lines.push(`User: ${preview(turn.user.text, 360)}`);
    for (const system of turn.system) {
      lines.push(`System: ${preview(system.text, 220)}`);
    }
    const assistantOutcome = latestNonEmptyAssistantText(turn.assistant);
    if (assistantOutcome) lines.push(`Assistant outcome: ${preview(assistantOutcome, 420)}`);
    for (const call of turn.assistant.flatMap((m) => m.toolCalls ?? [])) {
      if (toolLines >= MAX_MEMORY_TOOL_LINES) continue;
      lines.push(`Tool: ${(opts.summarizeToolCall ?? summarizeToolCall)(call)}`);
      toolLines += 1;
    }
  });
  if (toolLines >= MAX_MEMORY_TOOL_LINES) {
    lines.push(
      `Tool: additional older tool calls omitted after ${MAX_MEMORY_TOOL_LINES} compact rows`,
    );
  }

  const text = limitChars(lines.join('\n'), MAX_MEMORY_CHARS);
  const first = older[0];
  const last = older[older.length - 1];
  const input = {
    id: `context-memory-${stableHash(older.map((m) => m.id).join('|'))}`,
    role: 'assistant' as const,
    text,
    createdAt: first?.createdAt ?? last?.createdAt ?? 0,
  };
  return opts.createMemoryMessage ? opts.createMemoryMessage(input, older) : (input as TMessage);
}

function groupOlderTurns<TMessage extends ModelContextMessageLike>(
  messages: readonly TMessage[],
): OlderTurn<TMessage>[] {
  const turns: OlderTurn<TMessage>[] = [];
  let current: OlderTurn<TMessage> | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      current = { user: message, assistant: [], system: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { user: null, assistant: [], system: [] };
      turns.push(current);
    }
    if (message.role === 'assistant') current.assistant.push(message);
    else if (message.role === 'system') current.system.push(message);
  }
  return turns;
}

function countUserTurns(messages: readonly ModelContextMessageLike[]): number {
  return messages.filter((message) => message.role === 'user').length;
}

function latestNonEmptyAssistantText(messages: readonly ModelContextMessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messages[i]?.text.trim();
    if (text) return text;
  }
  return '';
}

function summarizeToolCall(call: ModelContextToolCallLike): string {
  const args = safeParse(call.argsJson);
  const result = safeParse(call.resultJson ?? '');
  const path = pathFrom(args) ?? pathFrom(result?.data);
  const summary = call.summary ?? (typeof result?.summary === 'string' ? result.summary : '');
  return [call.name, path ? `path=${path}` : '', summary ? `summary=${preview(summary, 220)}` : '']
    .filter(Boolean)
    .join(' | ');
}

function pathFrom(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const path = (value as { path?: unknown }).path;
  return typeof path === 'string' ? path : null;
}

function safeParse(json: string): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function preview(text: string, max: number): string {
  return limitChars(text.replace(/\s+/g, ' ').trim(), max);
}

function limitChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function statusFor(percent: number | undefined): ContextWindowStatus {
  if (percent === undefined) return 'unknown';
  if (percent >= 0.95) return 'critical';
  if (percent >= 0.8) return 'high';
  if (percent >= 0.5) return 'medium';
  return 'low';
}

function toolCallTokens(
  calls: readonly ModelContextToolCallLike[] | undefined,
  estimateTokens: ContextWindowTokenEstimator,
): number {
  if (!calls) return 0;
  let total = 0;
  for (const call of calls) {
    total += tokenEstimate(call.argsJson, estimateTokens);
    total += tokenEstimate(call.resultJson, estimateTokens);
    total += tokenEstimate(call.summary, estimateTokens);
  }
  return total;
}

function toolSchemaTokens(
  tools: readonly RequestCompositionToolLike[],
  estimateTokens: ContextWindowTokenEstimator,
): number {
  const declarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return tokenEstimate(safeStringify(declarations), estimateTokens);
}

export function tokenEstimate(
  value: string | undefined | null,
  estimateTokens: ContextWindowTokenEstimator = defaultTokenEstimate,
): number {
  return estimateTokens(value) ?? 0;
}

export function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function defaultTokenEstimate(value: string | undefined | null): number {
  return value ? Math.ceil(value.length / 4) : 0;
}

function nonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function zeroAggregatedTurnMetrics(): AggregatedTurnMetrics {
  return {
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    tokensReasoning: 0,
    costUsd: 0,
    costEstimated: false,
    iterations: 0,
  };
}
