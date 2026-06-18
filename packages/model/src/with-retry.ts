/**
 * `withRetry` — a reusable `ModelClient` decorator that retries
 * transient upstream failures, but only while nothing has been emitted
 * yet for the current turn (so streamed output is never duplicated).
 *
 * This is the docs agent's old `relayModelClient` retry, lifted out of
 * the site bridge into a shared, provider-agnostic decorator. A wrapped
 * client guarantees a terminal `usage` event before its iterable
 * returns (the contract's terminal is the return itself); the inner
 * client's `usage` is forwarded once.
 */
import type { ModelClient, ModelEvent, ModelRequest, ModelUsage } from './contract.js';

/** Default transient-failure matcher (overload / rate limit / 5xx). */
function defaultIsTransient(message: string): boolean {
  return /\b(429|500|502|503|504)\b|overloaded|unavailable|rate.?limit|resource_exhausted|timeout|temporarily/i.test(
    message,
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface WithRetryOpts {
  /** Total attempts before giving up. Default 3. */
  maxAttempts?: number;
  /** Predicate over a `{kind:'error'}` message that decides retryability. */
  isTransient?: (message: string) => boolean;
}

/**
 * Wrap a `ModelClient` so transient errors are retried with exponential
 * backoff. Only retries while nothing has streamed this turn; once any
 * text / thinking / tool_call has been yielded, an error passes straight
 * through (we never duplicate partial output). A terminal `usage` event
 * is always emitted before the iterable returns.
 */
export function withRetry(client: ModelClient, opts: WithRetryOpts = {}): ModelClient {
  const maxAttempts = opts.maxAttempts ?? 3;
  const isTransient = opts.isTransient ?? defaultIsTransient;

  return {
    id: client.id,
    supportsTools: client.supportsTools,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let usage: ModelUsage | undefined;
        let emitted = false;
        let retryErr: string | null = null;

        for await (const e of client.chat(req, signal)) {
          if (e.kind === 'usage') {
            // Hold the final accounting; emit it once before returning.
            usage = e.usage;
          } else if (e.kind === 'error') {
            if (!emitted && !signal.aborted && attempt < maxAttempts && isTransient(e.message)) {
              retryErr = e.message;
              break;
            }
            yield e;
            return;
          } else {
            // text / thinking / tool_call pass straight through.
            emitted = true;
            yield e;
          }
        }

        if (retryErr) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }

        // Final accounting before the iterable returns (the contract's
        // terminal is the return itself).
        yield { kind: 'usage', usage: usage ?? { promptTokens: 0, outputTokens: 0 } };
        return;
      }
    },
  };
}
