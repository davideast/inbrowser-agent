/**
 * Adapts any @inbrowser/relay `InferenceProvider` (an async-generator)
 * to @inbrowser/agent's `LlmClient`. Provider-agnostic: the
 * InferenceEvent -> ChatEvent mapping is identical for Gemini, Ollama,
 * etc. Runs server-side only.
 *
 * `apiKey` means whatever the chosen provider expects: a real API key
 * for Gemini (x-goog-api-key), the base URL for Ollama.
 *
 * Event mapping (relay InferenceEvent -> agent ChatEvent):
 *   text/thinking      -> passthrough
 *   tool_call          -> rename `callId` -> `id`
 *   usage (terminal)   -> buffered, emitted as `turn_complete`
 *   error              -> passthrough, then stop
 */
import type { ChatEvent, ChatRequest, LlmClient, RawUsage } from '@inbrowser/agent';
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

export function relayLlmClient(opts: RelayLlmOptions): LlmClient {
  const { provider, providerName, model, apiKey, temperature } = opts;
  return {
    id: `${providerName}:${model}`,
    supportsTools: true,
    async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const messages: ChatMessage[] = req.messages.map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        ...(m.callId ? { callId: m.callId } : {}),
        ...(m.name ? { name: m.name } : {}),
        ...(m.resultJson !== undefined ? { resultJson: m.resultJson } : {}),
      }));

      const nreq: NormalizedRequest = {
        provider: providerName,
        model,
        messages,
        // Only advertise tools when the loop enabled them this turn.
        tools: req.toolUseEnabled ? req.tools : [],
        apiKey,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        signal,
      };

      // Retry transient upstream errors, but only while nothing has been
      // emitted yet for this turn (so we never duplicate streamed output).
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let usage: RawUsage | undefined;
        let emitted = false;
        let retryErr: string | null = null;

        for await (const e of provider(nreq)) {
          if (e.kind === 'text') {
            emitted = true;
            yield { kind: 'text', chunk: e.chunk };
          } else if (e.kind === 'thinking') {
            emitted = true;
            yield { kind: 'thinking', chunk: e.chunk };
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
              completionTokens: e.outputTokens,
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

        yield {
          kind: 'turn_complete',
          usage: usage ?? { promptTokens: 0, completionTokens: 0 },
          details: { requestedModel: model },
        };
        return;
      }
    },
  };
}
