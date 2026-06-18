import type { DocsAgentEvent, VisitedCard } from './agent-types';

export interface AgentStreamHandlers {
  onToken?(text: string): void;
  onTool?(name: string, detail: string): void;
  onVisited?(card: VisitedCard): void;
  onError?(message: string): void;
  onDone?(): void;
}

const RECONNECT_MS = 400;
const MAX_ATTEMPTS = 200;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Apply one event; returns true when it is terminal (stop consuming). */
function dispatch(ev: DocsAgentEvent, h: AgentStreamHandlers): boolean {
  if (ev.type === 'token') h.onToken?.(ev.text);
  else if (ev.type === 'tool') h.onTool?.(ev.name, ev.detail);
  else if (ev.type === 'visited') h.onVisited?.(ev.card);
  else if (ev.type === 'error') {
    h.onError?.(ev.message);
    return true;
  } else if (ev.type === 'done') {
    h.onDone?.();
    return true;
  }
  return false;
}

/**
 * Start a resumable docs-agent job and stream its events, reconnecting from the
 * last received offset if the connection drops or the tab returns to the
 * foreground. `url` is the start endpoint (POST -> { jobId }); the stream is
 * GET `${url}/${jobId}?from=<offset>`, backed by `@inbrowser/resumable`. Resolves
 * when the run is done, errors, or the caller aborts via `signal`.
 */
export async function streamAgent(
  url: string,
  body: unknown,
  handlers: AgentStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  // Phase 1: start the job.
  let jobId: string;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      // Surface the server's reason (429 busy, 413 too long, etc.).
      const detail = await res.text().catch(() => '');
      handlers.onError?.(detail.trim() || `Request failed (${res.status}).`);
      return;
    }
    const data = (await res.json()) as { jobId?: string };
    if (!data.jobId) {
      handlers.onError?.('The assistant did not start. Please try again.');
      return;
    }
    jobId = data.jobId;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return;
    handlers.onError?.(e instanceof Error ? e.message : String(e));
    return;
  }

  // Phase 2: stream with reconnect from the last received offset.
  let received = 0;
  let attempt = 0;
  let conn: AbortController | null = null;

  // When the tab returns to the foreground, cut the (possibly dead) socket so
  // we reconnect from `received` immediately.
  const onVisible = () => {
    if (document.visibilityState === 'visible') conn?.abort();
  };
  const onOuterAbort = () => conn?.abort();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    for (;;) {
      if (signal?.aborted) return;
      attempt++;
      if (attempt > MAX_ATTEMPTS) {
        handlers.onError?.('Lost the connection to the assistant.');
        return;
      }

      conn = new AbortController();
      let res: Response;
      try {
        res = await fetch(`${url}/${jobId}?from=${received}`, { signal: conn.signal });
      } catch {
        if (signal?.aborted) return;
        await delay(RECONNECT_MS);
        continue; // connect failed -> reconnect from `received`
      }
      if (res.status === 404) {
        handlers.onError?.('This conversation has expired.');
        return;
      }
      if (!res.ok || !res.body) {
        handlers.onError?.(`Stream failed (${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let stop = false;
      let sawDone = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl = buf.indexOf('\n\n');
          while (nl !== -1) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (line) {
              const payload = line.slice(6);
              if (payload === '[DONE]') {
                sawDone = true;
              } else {
                let ev: DocsAgentEvent | null = null;
                try {
                  ev = JSON.parse(payload) as DocsAgentEvent;
                } catch {
                  ev = null;
                }
                if (ev) {
                  received++; // only after a clean parse, so reconnect is exact
                  if (dispatch(ev, handlers)) stop = true;
                }
              }
            }
            if (stop || sawDone) break;
            nl = buf.indexOf('\n\n');
          }
          if (stop || sawDone) break;
        }
      } catch {
        // read error (network drop) -> fall through to reconnect
      } finally {
        await reader.cancel().catch(() => {});
      }

      if (stop || sawDone) return; // agent done/error, or job terminal
      if (signal?.aborted) return;
      // Stream ended without a terminal: reconnect from `received`.
      await delay(RECONNECT_MS);
    }
  } finally {
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisible);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
