/**
 * Job specs + the producer factory shared by the worker host and any caller
 * that needs to describe a job declaratively.
 *
 * A `Producer` is a function and can't cross `postMessage`, so the client ships
 * a serializable `JobSpec` and the worker reconstitutes the work via
 * `buildProducer(spec)` (see `hostJobEngine`'s `buildProducer` contract). Phase 5
 * extends the `JobSpec` union with the real agent spec; for now the only member
 * is a self-contained demo so the durable-jobs runtime can be exercised end to
 * end without a model.
 */
import type { Producer } from '@inbrowser/resumable';

/** A self-contained demo job: emit `count` tokens, `everyMs` apart. */
export interface DemoJobSpec {
  kind: 'demo';
  count: number;
  everyMs: number;
}

/** Union of every job the worker can run. Phase 5 adds the agent spec. */
export type JobSpec = DemoJobSpec;

/**
 * Turn a serializable `JobSpec` into the `Producer<string>` the engine drives.
 * The producer's `ctx.signal` fires when the engine wants the work abandoned
 * (job cancelled / stopped), so the demo awaits a signal-aware delay between
 * tokens and bails out cleanly when aborted.
 */
export function buildProducer(spec: JobSpec): Producer<string> {
  switch (spec.kind) {
    case 'demo':
      return async function* demo(ctx) {
        for (let i = 0; i < spec.count; i++) {
          if (ctx.signal.aborted) return;
          if (i > 0) await delay(spec.everyMs, ctx.signal);
          if (ctx.signal.aborted) return;
          yield `tok${i}`;
        }
      };
  }
}

/** A `setTimeout` delay that resolves early (without throwing) when aborted. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
