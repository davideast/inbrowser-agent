/**
 * Adapts any @inbrowser/relay `InferenceProvider` (an async-generator) to the
 * unified `ModelClient` contract @inbrowser/agent consumes. Provider-agnostic:
 * the InferenceEvent -> ModelEvent mapping is identical for Gemini, Ollama, etc.
 * Runs server-side only.
 *
 * `apiKey` means whatever the chosen provider expects: a real API key for Gemini
 * (x-goog-api-key), the base URL for Ollama.
 *
 * Event mapping (relay InferenceEvent -> ModelEvent):
 *   text/thinking    -> rename `chunk` -> `text`
 *   tool_call        -> rename `callId` -> `id`
 *   usage            -> nested under `usage`; emitted before the iterable returns
 *   error            -> passthrough, then stop
 *
 * Interim bridge: it disappears once the cloud providers move into
 * @inbrowser/model as native ModelClients (then relay speaks the contract too).
 */
import type { ModelClient, ModelEvent, ModelRequest, ModelUsage } from '@inbrowser/agent';
import type { ChatMessage, InferenceProvider, NormalizedRequest } from '@inbrowser/relay';

export interface RelayLlmOptions {
  provider: InferenceProvider;
  /** Routing/id label (e.g. 'gemini', 'ollama'). */
  providerName: string;
  model: string;
  /** Provider-specific: Gemini API key, or Ollama base URL. */
  apiKey: string;
  temperature?: number;
}

const MAX_ATTEMPTS = 3;

/** Transient upstream failures worth retrying (overload / rate limit). */
function isTransient(message: string): boolean {
  return /\b(429|500|502|503|504)\b|overloaded|unavailable|rate.?limit|resource_exhausted|timeout|temporarily/i.test(
    message,
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function relayModelClient(opts: RelayLlmOptions): ModelClient {
  const { provider, providerName, model, apiKey, temperature } = opts;
  return {
    id: `${providerName}:${model}`,
    supportsTools: true,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      // ModelMessage -> relay ChatMessage (relay still uses `callId`).
      const messages: ChatMessage[] = req.messages.map((m) => ({
        role: m.role,
        text: m.text ?? '',
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

      const nreq: NormalizedRequest = {
        provider: providerName,
        model,
        messages,
        // relay still speaks the flat tool shape; flatten the nested ToolSpec.
        // Only advertise tools when the loop enabled them this turn.
        tools: req.toolUseEnabled
          ? req.tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters,
            }))
          : [],
        apiKey,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        signal,
      };

      // Retry transient upstream errors, but only while nothing has been
      // emitted yet for this turn (so we never duplicate streamed output).
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let usage: ModelUsage | undefined;
        let emitted = false;
        let retryErr: string | null = null;

        for await (const e of provider(nreq)) {
          if (e.kind === 'text') {
            emitted = true;
            yield { kind: 'text', text: e.chunk };
          } else if (e.kind === 'thinking') {
            emitted = true;
            yield { kind: 'thinking', text: e.chunk };
          } else if (e.kind === 'tool_call') {
            emitted = true;
            yield {
              kind: 'tool_call',
              id: e.callId,
              name: e.name,
              args: e.args,
              ...(e.signature ? { signature: e.signature } : {}),
            };
          } else if (e.kind === 'usage') {
            usage = {
              promptTokens: e.promptTokens,
              outputTokens: e.outputTokens,
              ...(e.cachedTokens !== undefined ? { cachedTokens: e.cachedTokens } : {}),
              ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}),
            };
          } else if (e.kind === 'error') {
            if (!emitted && !signal.aborted && attempt < MAX_ATTEMPTS && isTransient(e.message)) {
              retryErr = e.message;
              break;
            }
            yield { kind: 'error', message: e.message };
            return;
          }
        }

        if (retryErr) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }

        // Final accounting before the iterable returns (the contract's terminal
        // is the return itself). `details` is synthesized downstream from the
        // client id, so it is no longer emitted here.
        yield { kind: 'usage', usage: usage ?? { promptTokens: 0, outputTokens: 0 } };
        return;
      }
    },
  };
}
