import {
  type ContextWindowSnapshot,
  type ContextWindowTraceHostContext,
  type ContextWindowTraceLike,
  type ModelContextMessageLike,
  type SessionTokenUsage,
  buildContextWindowSnapshot,
  contextWindowTraceEventsToTraces,
} from '@inbrowser/agent/usage';
import { createGraphToolRegistry } from '../agent/graph-tools';
import type { AgentTurnMetrics } from './agent-types';
import type { ChatTurn } from './chat-store';
import { REACT_SYSTEM_PROMPT, SYSTEM_PROMPT } from './local-agent';
import type { ModelSourceConfig } from './model-source';
import { PRESET_META, onDeviceContextWindow } from './on-device-agent';

interface BuildDocsContextWindowOptions {
  messages: readonly ChatTurn[];
  currentPrompt: string;
  config: ModelSourceConfig;
}

export function buildDocsContextWindowSnapshot({
  messages,
  currentPrompt,
  config,
}: BuildDocsContextWindowOptions): ContextWindowSnapshot {
  const hostContext = traceHostContextForConfig(config);
  return buildContextWindowSnapshot({
    messages: messages.map(toModelContextMessage),
    currentPrompt,
    systemPrompt: systemPromptForConfig(config),
    tools: createGraphToolRegistry().list(),
    limitTokens: contextLimitForConfig(config),
    providerId: hostContext.providerId,
    modelId: modelIdForConfig(config),
    tracesByTurn: tracesByTurnFromMessages(messages),
  });
}

export function traceHostContextForConfig(
  config: ModelSourceConfig,
  strategy?: string,
  strategySource?: string,
): ContextWindowTraceHostContext {
  const base = (() => {
    switch (config.source) {
      case 'gemini':
        return {
          providerId: 'gemini',
          providerLabel: 'Gemini',
          modelLabel: config.geminiModel,
        };
      case 'openrouter':
        return {
          providerId: 'openrouter',
          providerLabel: 'OpenRouter',
          modelLabel: config.openrouterModel,
        };
      case 'ollama':
        return {
          providerId: 'ollama',
          providerLabel: 'Ollama',
          modelLabel: config.ollamaModel,
        };
      case 'llama':
        return {
          providerId: 'llama',
          providerLabel: 'Llama server',
          modelLabel: config.llamaModel,
        };
      case 'webgpu':
        return {
          providerId: 'on-device',
          providerLabel: 'On-device',
          modelLabel: PRESET_META[config.webgpuPreset].label,
        };
    }
  })();
  return {
    ...base,
    ...(strategy ? { strategy } : {}),
    ...(strategySource ? { strategySource } : {}),
  };
}

export function modelIdForConfig(config: ModelSourceConfig): string {
  switch (config.source) {
    case 'gemini':
      return config.geminiModel;
    case 'openrouter':
      return config.openrouterModel;
    case 'ollama':
      return config.ollamaModel;
    case 'llama':
      return config.llamaModel;
    case 'webgpu':
      return config.webgpuPreset;
  }
}

export function systemPromptForConfig(config: ModelSourceConfig): string {
  return config.source === 'gemini' || config.source === 'openrouter' || config.source === 'ollama'
    ? REACT_SYSTEM_PROMPT
    : SYSTEM_PROMPT;
}

export function usageFromTurnMetrics(
  metrics: AgentTurnMetrics | undefined,
): SessionTokenUsage | undefined {
  if (!metrics) return undefined;
  const inputTokens = Math.max(0, metrics.tokensIn);
  const outputTokens = Math.max(0, metrics.tokensOut);
  return {
    turns: 1,
    requests: metrics.iterations,
    tokensTotal: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens: Math.max(0, metrics.tokensCached),
    reasoningTokens: Math.max(0, metrics.tokensReasoning),
    costUsdTotal: metrics.costUsd,
    turnRows: [],
    requestRows: [],
    categoryDetails: {},
    teachingNotes: {
      providerUsage: '',
      estimatedComposition: '',
      contextVsSpend: '',
    },
  };
}

function contextLimitForConfig(config: ModelSourceConfig): number | undefined {
  return config.source === 'webgpu' ? onDeviceContextWindow(config.webgpuPreset) : undefined;
}

function tracesByTurnFromMessages(
  messages: readonly ChatTurn[],
): Record<string, ContextWindowTraceLike> {
  const traceEvents = messages.flatMap((message) => message.traceEvents ?? []);
  const hostCtxByTurn: Record<string, ContextWindowTraceHostContext | undefined> = {};
  for (const message of messages) {
    if (message.turnId && message.traceHostContext) {
      hostCtxByTurn[message.turnId] = message.traceHostContext;
    }
  }
  return contextWindowTraceEventsToTraces(traceEvents, hostCtxByTurn);
}

function toModelContextMessage(message: ChatTurn, index: number): ModelContextMessageLike {
  return {
    id: `${message.role}-${index}`,
    role: message.role,
    text: message.text,
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.metrics ? { metrics: message.metrics } : {}),
    createdAt: index,
  } as ModelContextMessageLike;
}
