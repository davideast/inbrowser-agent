/**
 * Adapter from the playground's existing `LlmProvider` shape to the
 * core `LlmClient` interface. Lets new core code (AgentSession,
 * AgentStrategy) consume providers via the narrow event-stream
 * surface without each provider needing a refactor.
 *
 * The existing `LlmProvider` is callback-based (`onText`,
 * `onToolCall`, etc.) and lives in the React host alongside its
 * BYOK forms + localStorage wiring. This file flips it into the
 * `AsyncIterable<ChatEvent>` shape the core wants.
 *
 * Each provider can later migrate to natively implement `LlmClient`
 * to drop this adapter. The plan calls this "slice 4 — one
 * provider at a time"; the adapter exists so slice 4 doesn't have
 * to land atomically.
 */

import type {
  ChatEvent,
  ChatRequest,
  LlmClient,
  RawUsage,
} from './types/llm.js';
import type { TurnDetails } from './types/chat.js';

/**
 * Minimal external surface the adapter expects. Matches the shape
 * `examples/admin-compat-browser/src/llm.ts` exports. We re-declare
 * it here so `@inbrowser/agent` doesn't import from the playground.
 */
export interface LegacyProviderUsage {
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  costEstimated?: boolean;
  cachedTokens?: number;
  reasoningTokens?: number;
  isByok?: boolean;
}

export interface LegacyTurnDetails {
  generationId?: string;
  servedModel?: string;
  requestedModel?: string;
  fingerprint?: string;
  routing?: Record<string, unknown>;
}

export interface LegacyChatTurnResult {
  text?: string;
  thinking?: string;
  finishReason?: 'stop' | 'tool' | 'abort' | 'error';
  usage?: LegacyProviderUsage;
  details?: LegacyTurnDetails;
}

export interface LegacyChatCallbacks {
  onText(chunk: string): void;
  onThinking?(chunk: string): void;
  onToolCall(call: {
    callId: string;
    name: string;
    args: unknown;
    signature?: string;
  }): void;
  signal?: AbortSignal;
}

export interface LegacyToolDecl {
  name: string;
  description: string;
  parameters: unknown;
}

export interface LegacyChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: { callId: string; name: string; args: unknown; signature?: string }[];
  callId?: string;
  name?: string;
  resultJson?: string;
}

export interface LegacyProvider {
  readonly label: string;
  readonly supportsTools?: boolean;
  chatWithTools?(
    messages: LegacyChatMessage[],
    tools: LegacyToolDecl[],
    callbacks: LegacyChatCallbacks,
  ): Promise<LegacyChatTurnResult>;
  ask(
    prompt: string,
    onChunk: (chunk: string) => void,
    options?: { signal?: AbortSignal },
  ): Promise<LegacyChatTurnResult>;
}

/**
 * Wrap a legacy `LlmProvider` instance in the `LlmClient` shape.
 * The adapter:
 *
 *   - Translates `ChatRequest` → legacy `chatWithTools` / `ask`
 *     call.
 *   - Buffers callback events into an async queue and replays them
 *     as a `ChatEvent` `AsyncIterable`.
 *   - Forwards the final usage + details as a `turn_complete`
 *     event before closing the stream.
 */
export function legacyProviderAsLlmClient(legacy: LegacyProvider, id: string): LlmClient {
  return {
    id,
    supportsTools: legacy.supportsTools ?? typeof legacy.chatWithTools === 'function',
    chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      return drive(legacy, req, signal);
    },
  };
}

async function* drive(
  legacy: LegacyProvider,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncIterable<ChatEvent> {
  const queue: ChatEvent[] = [];
  let resolver: (() => void) | null = null;
  let done = false;

  function push(ev: ChatEvent) {
    queue.push(ev);
    resolver?.();
    resolver = null;
  }
  function finish() {
    done = true;
    resolver?.();
    resolver = null;
  }

  const callbacks: LegacyChatCallbacks = {
    onText: (chunk) => push({ kind: 'text', chunk }),
    onThinking: (chunk) => push({ kind: 'thinking', chunk }),
    onToolCall: (call) => push({
      kind: 'tool_call',
      id: call.callId,
      name: call.name,
      args: call.args,
      signature: call.signature,
    }),
    signal,
  };

  const messagesLegacy: LegacyChatMessage[] = req.messages.map((m) => ({
    role: m.role,
    text: m.text,
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.callId ? { callId: m.callId } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.resultJson !== undefined ? { resultJson: m.resultJson } : {}),
  }));

  const toolsLegacy: LegacyToolDecl[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  let result: LegacyChatTurnResult | undefined;
  let error: unknown;
  const driver = (async () => {
    try {
      if (req.toolUseEnabled && legacy.chatWithTools) {
        result = await legacy.chatWithTools(messagesLegacy, toolsLegacy, callbacks);
      } else {
        // Plain-chat path — flatten messages into a single prompt.
        const prompt = messagesLegacy
          .filter((m) => m.role === 'user' || m.role === 'system')
          .map((m) => m.text ?? '')
          .filter(Boolean)
          .join('\n\n');
        result = await legacy.ask(prompt, callbacks.onText, { signal });
      }
    } catch (e) {
      error = e;
    } finally {
      finish();
    }
  })();

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((r) => { resolver = r; });
    }
    const next = queue.shift();
    if (next) yield next;
  }
  await driver;

  if (error) {
    yield { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    return;
  }
  if (result) {
    const rawUsage: RawUsage = {
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.outputTokens ?? 0,
      cachedTokens: result.usage?.cachedTokens,
      reasoningTokens: result.usage?.reasoningTokens,
      ...(typeof result.usage?.costUsd === 'number' ? { costUsd: result.usage.costUsd } : {}),
    };
    const details: TurnDetails = {
      requestedModel: result.details?.requestedModel ?? '',
      ...(result.details?.servedModel ? { servedModel: result.details.servedModel } : {}),
      ...(result.details?.fingerprint ? { fingerprint: result.details.fingerprint } : {}),
      ...(result.details?.routing ? { routing: result.details.routing } : {}),
    };
    yield { kind: 'turn_complete', usage: rawUsage, details };
  }
}
