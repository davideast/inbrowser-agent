/**
 * Adapter from a callback-style chat provider to the core
 * `ModelClient` event-stream surface. Lets `AgentSession` /
 * `AgentStrategy` consume providers that expose `onText`,
 * `onToolCall`, etc. without each provider rewriting itself.
 *
 * The callback shape is what the playground's BYOK forms +
 * localStorage wiring already speak. This file flips it into the
 * `AsyncIterable<ModelEvent>` shape the core wants.
 *
 * A provider can later implement `ModelClient` natively and drop
 * the adapter; nothing forces the indirection.
 */

import type { ModelClient, ModelEvent, ModelRequest, ModelUsage } from './types/llm.js';

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
 * Wrap a `CallbackProvider` instance in the `ModelClient` shape.
 * The adapter:
 *
 *   - Translates `ModelRequest` → `chatWithTools` / `ask` call.
 *   - Buffers callback events into an async queue and replays them
 *     as a `ModelEvent` `AsyncIterable`.
 *   - Forwards the final usage as a `usage` event before the iterable
 *     returns (the return itself signals turn completion — there is no
 *     separate terminal event).
 */
export function callbackProviderAsLlmClient(provider: CallbackProvider, id: string): ModelClient {
  return {
    id,
    supportsTools: provider.supportsTools ?? typeof provider.chatWithTools === 'function',
    chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      return drive(provider, req, signal);
    },
  };
}

async function* drive(
  provider: CallbackProvider,
  req: ModelRequest,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const queue: ModelEvent[] = [];
  let resolver: (() => void) | null = null;
  let done = false;

  function push(ev: ModelEvent) {
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
    onText: (chunk) => push({ kind: 'text', text: chunk }),
    onThinking: (chunk) => push({ kind: 'thinking', text: chunk }),
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
    ...(m.toolCalls
      ? {
          toolCalls: m.toolCalls.map((tc) => ({
            callId: tc.id,
            name: tc.name,
            args: tc.args,
            ...(tc.signature ? { signature: tc.signature } : {}),
          })),
        }
      : {}),
    ...(m.toolCallId ? { callId: m.toolCallId } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.resultJson !== undefined ? { resultJson: m.resultJson } : {}),
  }));

  const tools: ProviderToolDecl[] = req.tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
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
  // The turn completed without error. Emit final accounting as a `usage` event
  // before returning, per the ModelClient contract (the return itself signals
  // turn completion). A well-behaved provider returns usage; default to zeros if
  // it did not, so the "usage before a normal return" guarantee always holds and
  // the turn is never silently dropped by the consumer.
  // Provider-reported `details` (servedModel/fingerprint/routing) is no longer
  // carried on the stream — the session synthesizes `{ requestedModel }` from the
  // client id.
  const usage: ModelUsage = {
    promptTokens: result?.usage?.promptTokens ?? 0,
    outputTokens: result?.usage?.outputTokens ?? 0,
    ...(result?.usage?.cachedTokens !== undefined
      ? { cachedTokens: result.usage.cachedTokens }
      : {}),
    ...(result?.usage?.reasoningTokens !== undefined
      ? { reasoningTokens: result.usage.reasoningTokens }
      : {}),
    ...(typeof result?.usage?.costUsd === 'number' ? { costUsd: result.usage.costUsd } : {}),
  };
  yield { kind: 'usage', usage };
}
