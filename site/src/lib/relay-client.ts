/**
 * Wraps any @inbrowser/relay `InferenceProvider` (an async-generator) as a
 * `ModelClient` the @inbrowser/agent runtime consumes, adding a transient-
 * error retry. Provider-agnostic: works for Gemini, Ollama, etc.
 * Runs server-side only.
 *
 * Since relay now speaks the shared `@inbrowser/model/contract` — providers
 * yield `ModelEvent` and consume `ModelMessage` + nested `ToolSpec` — this
 * bridge is essentially a pass-through. The only transforms are:
 *   - assemble the relay-only transport fields (`provider`/`model`/`apiKey`/
 *     `temperature`) onto the incoming `ModelRequest`;
 *   - gate tool advertising on `toolUseEnabled` (send `[]` when the loop
 *     disabled tools this turn);
 *   - retry transient upstream failures (only while nothing has streamed);
 *   - guarantee a terminal `usage` event before returning.
 *
 * `apiKey` means whatever the chosen provider expects: a real API key for
 * Gemini (x-goog-api-key), the base URL for Ollama.
 *
 * Interim bridge: it disappears once the cloud providers move into
 * @inbrowser/model as native ModelClients (then relay speaks the contract too).
 */
import type { ModelClient, ModelEvent, ModelRequest, ModelUsage } from '@inbrowser/agent';
import type { InferenceProvider, NormalizedRequest } from '@inbrowser/relay';

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
      // The relay provider speaks the same contract now: messages pass
      // through as ModelMessage, tools pass through as nested ToolSpec.
      // The only relay-only additions are the transport fields. Only
      // advertise tools when the loop enabled them this turn.
      const nreq: NormalizedRequest = {
        provider: providerName,
        model,
        messages: req.messages,
        tools: req.toolUseEnabled ? req.tools : [],
        toolUseEnabled: req.toolUseEnabled,
        ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
        apiKey,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof req.topP === 'number' ? { topP: req.topP } : {}),
        ...(typeof req.topK === 'number' ? { topK: req.topK } : {}),
        signal,
      };

      // Retry transient upstream errors, but only while nothing has been
      // emitted yet for this turn (so we never duplicate streamed output).
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let usage: ModelUsage | undefined;
        let emitted = false;
        let retryErr: string | null = null;

        for await (const e of provider(nreq)) {
          if (e.kind === 'usage') {
            // Hold the final accounting; emit it once before returning.
            usage = e.usage;
          } else if (e.kind === 'error') {
            if (!emitted && !signal.aborted && attempt < MAX_ATTEMPTS && isTransient(e.message)) {
              retryErr = e.message;
              break;
            }
            yield e;
            return;
          } else {
            // text / thinking / tool_call are already ModelEvents — pass through.
            emitted = true;
            yield e;
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
