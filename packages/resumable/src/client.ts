/**
 * Reconnecting client — environment-agnostic consumer of a resumable job's
 * start + stream HTTP endpoints. Exported from the `@inbrowser/resumable`
 * root (no `./client` subpath). Generic over the event type.
 *
 * Two passes:
 *   1. POST `startUrl` to allocate a job; server returns `{ jobId }`.
 *   2. GET `streamUrl(jobId, from)` in a loop:
 *      - every event yielded bumps `received`.
 *      - if the connection drops mid-stream (read error, or close without
 *        `[DONE]`), reconnect with `from = received` and the durable log
 *        replays from there as if the drop never happened.
 *
 * The browser-lifecycle helper (`installBrowserLifecycle`) proactively cuts a
 * probably-dead socket when the tab returns to the foreground; the core never
 * reaches for `document`, so it runs anywhere.
 *
 * Transport errors are surfaced as `{ type: 'error' }` messages (not thrown and
 * not synthesized into the event type, which the client cannot know). Pair it
 * with `sseFromJob` on the server (both on the `@inbrowser/resumable` root).
 */

/** One item from the client stream: a decoded event, or a transport error. */
export type ClientMessage<TEvent> =
  | { type: 'event'; event: TEvent }
  | { type: 'error'; message: string };

export interface ResumableClientOptions<TEvent> {
  /** URL the client POSTs to start a new job. */
  startUrl: string;
  /** Builds the stream URL from a jobId + resume offset. */
  streamUrl: (jobId: string, from: number) => string;
  /** Parse one SSE payload into an event. Default `JSON.parse`. */
  parse?: (payload: string) => TEvent;
  /** Prefix for transport error messages (e.g. `'relay '`). Default `''`. */
  label?: string;
  /** Failsafe — give up after this many reconnect attempts. Default 300. */
  maxAttempts?: number;
  /** Gap before each reconnect, in ms. Default 300. */
  reconnectDelayMs?: number;
  /** Diagnostics for each reconnect decision. */
  onReconnect?: (info: {
    attempt: number;
    received: number;
    reason: 'connect_failed' | 'read_error' | 'stream_ended_no_done';
  }) => void;
  /** Called when the consumer aborts via the stream signal. */
  onConsumerAbort?: () => void;
  /**
   * Hook for cutting the current connection from outside the stream (e.g.
   * page-visibility integration). Invoked once per `stream()` call with a
   * function that aborts the in-flight connection; returns a cleanup. See
   * `installBrowserLifecycle`.
   */
  installLifecycle?: (abortCurrentConnection: () => void) => () => void;
  /** Inject a fetch implementation. Default uses the global. */
  fetchImpl?: typeof fetch;
}

export interface ResumableClient<TEvent> {
  /**
   * Start a job (POST `body`) and yield every event until terminal, surviving
   * connection drops by reconnecting with `from = received`. Pass a `signal` to
   * cancel.
   */
  stream(body: unknown, signal?: AbortSignal): AsyncIterable<ClientMessage<TEvent>>;
}

export function createResumableClient<TEvent>(
  opts: ResumableClientOptions<TEvent>,
): ResumableClient<TEvent> {
  return {
    stream: (body, signal) => streamJob<TEvent>(body, signal, opts),
  };
}

async function* streamJob<TEvent>(
  body: unknown,
  signal: AbortSignal | undefined,
  opts: ResumableClientOptions<TEvent>,
): AsyncGenerator<ClientMessage<TEvent>> {
  const parse = opts.parse ?? ((p: string) => JSON.parse(p) as TEvent);
  const label = opts.label ?? '';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 300;
  const reconnectDelayMs = opts.reconnectDelayMs ?? 300;

  // ── 1. Start the job ───────────────────────────────────────────
  let jobId: string;
  try {
    const res = await fetchImpl(opts.startUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      yield { type: 'error', message: `${label}start ${res.status}: ${text.slice(0, 240)}` };
      return;
    }
    const parsed = (await res.json()) as { jobId?: string };
    if (!parsed.jobId) {
      yield { type: 'error', message: `${label}start: no jobId in response` };
      return;
    }
    jobId = parsed.jobId;
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
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
          type: 'error',
          message: `${label}stream: gave up after ${maxAttempts} reconnect attempts`,
        };
        return;
      }

      currentConn = new AbortController();
      let response: Response;
      try {
        response = await fetchImpl(opts.streamUrl(jobId, received), { signal: currentConn.signal });
      } catch {
        if (consumerAborted) return;
        opts.onReconnect?.({ attempt, received, reason: 'connect_failed' });
        await delay(reconnectDelayMs);
        continue;
      }

      if (response.status === 404) {
        yield { type: 'error', message: `${label}job not found (expired or never started)` };
        return;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        yield {
          type: 'error',
          message: `${label}stream ${response.status}: ${text.slice(0, 240)}`,
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
          let event: TEvent;
          try {
            event = parse(payload);
          } catch {
            continue; // tolerate a malformed frame
          }
          received++;
          yield { type: 'event', event };
        }
      } catch {
        if (consumerAborted) return;
        opts.onReconnect?.({ attempt, received, reason: 'read_error' });
        await delay(reconnectDelayMs);
        continue;
      }

      if (sawDone) return;
      if (consumerAborted) return;
      // Stream closed without `[DONE]`: the job isn't finished. Reconnect.
      opts.onReconnect?.({ attempt, received, reason: 'stream_ended_no_done' });
      await delay(reconnectDelayMs);
    }
  } finally {
    signal?.removeEventListener('abort', onConsumerAbort);
    cleanupLifecycle?.();
  }
}

/**
 * Stream-line SSE reader. Yields each `data:` line payload as a raw string,
 * accumulating a buffer across reads so a chunk boundary mid-line never loses
 * data. (Every channel this consumes uses single-line `data:` events.)
 */
async function* readSseDataLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) throw new Error('SSE response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data: ')) continue;
        yield line.slice(6);
      }
    }
    if (buf.startsWith('data: ')) yield buf.slice(6);
  } finally {
    reader.releaseLock();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns an `installLifecycle` hook that proactively aborts the current
 * connection when the tab returns to the foreground, so a probably-dead
 * background socket reconnects immediately. SSR-safe (no-op without `document`).
 */
export function installBrowserLifecycle(): (abortCurrentConnection: () => void) => () => void {
  return (abortCurrentConnection) => {
    if (typeof document === 'undefined') return () => {};
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') abortCurrentConnection();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  };
}
