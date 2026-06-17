/**
 * Adapter from a callback-style chat provider to the core
 * `LlmClient` event-stream surface. Lets `AgentSession` /
 * `AgentStrategy` consume providers that expose `onText`,
 * `onToolCall`, etc. without each provider rewriting itself.
 *
 * The callback shape is what the playground's BYOK forms +
 * localStorage wiring already speak. This file flips it into the
 * `AsyncIterable<ChatEvent>` shape the core wants.
 *
 * A provider can later implement `LlmClient` natively and drop
 * the adapter; nothing forces the indirection.
 */

import type { TurnDetails } from './types/chat.js';
import type { ChatEvent, ChatRequest, LlmClient, RawUsage } from './types/llm.js';

/**
 * Minimal external surface the adapter expects. Re-declared here so
 * `@inbrowser/agent` doesn't import from a downstream package.
 */
export interface ProviderUsage {
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  costEstimated?: boolean;
  cachedTokens?: number;
  reasoningTokens?: number;
  isByok?: boolean;
}

export interface ProviderTurnDetails {
  generationId?: string;
  servedModel?: string;
  requestedModel?: string;
  fingerprint?: string;
  routing?: Record<string, unknown>;
}

export interface ProviderTurnResult {
  text?: string;
  thinking?: string;
  finishReason?: 'stop' | 'tool' | 'abort' | 'error';
  usage?: ProviderUsage;
  details?: ProviderTurnDetails;
}

export interface ProviderCallbacks {
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

export interface ProviderToolDecl {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ProviderChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: { callId: string; name: string; args: unknown; signature?: string }[];
  callId?: string;
  name?: string;
  resultJson?: string;
}

export interface CallbackProvider {
  readonly label: string;
  readonly supportsTools?: boolean;
  chatWithTools?(
    messages: ProviderChatMessage[],
    tools: ProviderToolDecl[],
    callbacks: ProviderCallbacks,
  ): Promise<ProviderTurnResult>;
  ask(
    prompt: string,
    onChunk: (chunk: string) => void,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderTurnResult>;
}

/**
 * Wrap a `CallbackProvider` instance in the `LlmClient` shape.
 * The adapter:
 *
 *   - Translates `ChatRequest` → `chatWithTools` / `ask` call.
 *   - Buffers callback events into an async queue and replays them
 *     as a `ChatEvent` `AsyncIterable`.
 *   - Forwards the final usage + details as a `turn_complete`
 *     event before closing the stream.
 */
export function callbackProviderAsLlmClient(provider: CallbackProvider, id: string): LlmClient {
  return {
    id,
    supportsTools: provider.supportsTools ?? typeof provider.chatWithTools === 'function',
    chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      return drive(provider, req, signal);
    },
  };
}

async function* drive(
  provider: CallbackProvider,
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

  const callbacks: ProviderCallbacks = {
    onText: (chunk) => push({ kind: 'text', chunk }),
    onThinking: (chunk) => push({ kind: 'thinking', chunk }),
    onToolCall: (call) =>
      push({
        kind: 'tool_call',
        id: call.callId,
        name: call.name,
        args: call.args,
        signature: call.signature,
      }),
    signal,
  };

  const messages: ProviderChatMessage[] = req.messages.map((m) => ({
    role: m.role,
    text: m.text,
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.callId ? { callId: m.callId } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.resultJson !== undefined ? { resultJson: m.resultJson } : {}),
  }));

  const tools: ProviderToolDecl[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  let result: ProviderTurnResult | undefined;
  let error: unknown;
  const driver = (async () => {
    try {
      if (req.toolUseEnabled && provider.chatWithTools) {
        result = await provider.chatWithTools(messages, tools, callbacks);
      } else {
        // Plain-chat path — flatten messages into a single prompt.
        const prompt = messages
          .filter((m) => m.role === 'user' || m.role === 'system')
          .map((m) => m.text ?? '')
          .filter(Boolean)
          .join('\n\n');
        result = await provider.ask(prompt, callbacks.onText, { signal });
      }
    } catch (e) {
      error = e;
    } finally {
      finish();
    }
  })();

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((r) => {
        resolver = r;
      });
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
