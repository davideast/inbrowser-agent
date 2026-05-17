/**
 * `createResumableClient` — env-agnostic reconnecting consumer of a
 * relay's `/inference/job` + `/inference/job/:id/stream` endpoints.
 *
 * Two passes:
 *   1. POST to `startUrl` to allocate a job. Server returns `{ jobId }`.
 *   2. GET `streamUrl(jobId, from)` in a loop:
 *      - every event yielded to the consumer bumps `received`.
 *      - if the connection drops mid-stream (read error or close
 *        without `[DONE]`), reconnect with `from=received`.
 *      - the server's durable log replays from there as if the drop
 *        never happened.
 *
 * The browser-lifecycle integration (proactively aborting the
 * connection on `visibilitychange` so reconnection is immediate
 * instead of waiting for the OS-level socket teardown) lives in
 * `./browser.ts` — env-agnostic core doesn't reach for `document`.
 */
import { readSseDataLines } from '../sse.js';
import type { InferenceEvent, NormalizedRequest } from '../types.js';

export interface ResumableClientOpts {
  /** URL the client POSTs to start a new job. */
  startUrl: string;
  /** Function that builds the stream URL given a jobId + resume offset. */
  streamUrl: (jobId: string, from: number) => string;
  /**
   * Failsafe — give up after this many reconnect attempts. A truly
   * disconnected mobile session will reconnect many times; this just
   * stops an infinite loop when the server is genuinely gone.
   * Default 300.
   */
  maxAttempts?: number;
  /**
   * Gap between a dropped connection and the next reconnect, in ms.
   * Default 300.
   */
  reconnectDelayMs?: number;
  /**
   * Called when the client decides to reconnect (read error, close
   * without `[DONE]`, etc.). Hosts can use this for diagnostics.
   */
  onReconnect?: (info: {
    attempt: number;
    received: number;
    reason: 'connect_failed' | 'read_error' | 'stream_ended_no_done';
  }) => void;
  /**
   * Called when the consumer aborts the controller; useful for
   * teardown bookkeeping outside the iterator.
   */
  onConsumerAbort?: () => void;
  /**
   * Hook for cutting the *current* connection from outside the
   * stream — e.g. page-visibility integration that proactively
   * aborts a probably-dead socket when the tab comes back to the
   * foreground (Android Chrome). The hook is invoked once per
   * stream() call with a function that aborts whichever connection
   * is in flight at that moment; it returns a cleanup the client
   * runs when the stream ends. See `installBrowserLifecycle`.
   */
  installLifecycle?: (abortCurrentConnection: () => void) => () => void;
  /**
   * Inject a fetch implementation. Default uses the global. Useful
   * when wrapping with retries / circuit breakers.
   */
  fetchImpl?: typeof fetch;
}

export interface ResumableClient {
  /**
   * Start an inference job and yield every event until terminal.
   * Survives connection drops by reconnecting with `from=received`.
   */
  stream(req: NormalizedRequest): AsyncIterable<InferenceEvent>;
}

export function createResumableClient(opts: ResumableClientOpts): ResumableClient {
  return {
    stream(req: NormalizedRequest): AsyncIterable<InferenceEvent> {
      return streamViaRelay(req, opts);
    },
  };
}

async function* streamViaRelay(
  req: NormalizedRequest,
  opts: ResumableClientOpts,
): AsyncGenerator<InferenceEvent> {
  const { signal, ...rest } = req;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 300;
  const reconnectDelayMs = opts.reconnectDelayMs ?? 300;

  // ── 1. Start the job ───────────────────────────────────────────
  let jobId: string;
  try {
    const res = await fetchImpl(opts.startUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rest),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      yield {
        kind: 'error',
        message: `relay start ${res.status}: ${text.slice(0, 240)}`,
      };
      return;
    }
    const parsed = (await res.json()) as { jobId?: string };
    if (!parsed.jobId) {
      yield { kind: 'error', message: 'relay start: no jobId in response' };
      return;
    }
    jobId = parsed.jobId;
  } catch (e) {
    if (signal?.aborted) return;
    yield {
      kind: 'error',
      message: e instanceof Error ? e.message : String(e),
    };
    return;
  }

  // ── 2. Tail with reconnect-and-replay ──────────────────────────
  let received = 0;
  let consumerAborted = false;
  let currentConn: AbortController | null = null;

  const onConsumerAbort = (): void => {
    consumerAborted = true;
    opts.onConsumerAbort?.();
    currentConn?.abort();
  };
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener('abort', onConsumerAbort, { once: true });
  }

  const cleanupLifecycle = opts.installLifecycle?.(() => currentConn?.abort());

  try {
    let attempt = 0;
    while (true) {
      if (consumerAborted) return;
      attempt++;
      if (attempt > maxAttempts) {
        yield {
          kind: 'error',
          message: `relay stream: gave up after ${maxAttempts} reconnect attempts`,
        };
        return;
      }

      currentConn = new AbortController();
      let response: Response;
      try {
        response = await fetchImpl(opts.streamUrl(jobId, received), {
          signal: currentConn.signal,
        });
      } catch {
        if (consumerAborted) return;
        opts.onReconnect?.({
          attempt,
          received,
          reason: 'connect_failed',
        });
        await delay(reconnectDelayMs);
        continue;
      }

      if (response.status === 404) {
        yield {
          kind: 'error',
          message: 'relay job not found (expired or never started)',
        };
        return;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        yield {
          kind: 'error',
          message: `relay stream ${response.status}: ${text.slice(0, 240)}`,
        };
        return;
      }

      let sawDone = false;
      try {
        for await (const payload of readSseDataLines(response.body)) {
          if (payload === '[DONE]') {
            sawDone = true;
            break;
          }
          if (consumerAborted) return;
          let evt: InferenceEvent;
          try {
            evt = JSON.parse(payload) as InferenceEvent;
          } catch {
            continue;
          }
          received++;
          yield evt;
        }
      } catch {
        if (consumerAborted) return;
        opts.onReconnect?.({
          attempt,
          received,
          reason: 'read_error',
        });
        await delay(reconnectDelayMs);
        continue;
      }

      if (sawDone) return;

      // Stream ended without `[DONE]` — the connection closed but the
      // job isn't finished. Reconnect from where we left off.
      if (consumerAborted) return;
      opts.onReconnect?.({
        attempt,
        received,
        reason: 'stream_ended_no_done',
      });
      await delay(reconnectDelayMs);
    }
  } finally {
    signal?.removeEventListener('abort', onConsumerAbort);
    cleanupLifecycle?.();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { installBrowserLifecycle } from './browser.js';
