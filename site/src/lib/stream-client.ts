import type { DocsAgentEvent, VisitedCard } from './agent-types';

export interface AgentStreamHandlers {
  onToken?(text: string): void;
  onTool?(name: string, detail: string): void;
  onVisited?(card: VisitedCard): void;
  onError?(message: string): void;
  onDone?(): void;
}

/**
 * POST a JSON body to an agent SSE endpoint and dispatch the streamed
 * events to handlers. Resolves when the stream ends (done/error/close).
 * Pass an AbortSignal to cancel. Shared by the keystone + chat.
 */
export async function streamAgent(
  url: string,
  body: unknown,
  handlers: AgentStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    // Surface the server's reason (e.g. 429 busy, 413 too long) instead
    // of a bare status code, so the UI can show something useful.
    const detail = await res.text().catch(() => '');
    handlers.onError?.(detail.trim() || `Request failed (${res.status}).`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const dispatch = (frame: string): boolean => {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return false;
    let ev: DocsAgentEvent;
    try {
      ev = JSON.parse(line.slice(6)) as DocsAgentEvent;
    } catch {
      return false; // tolerate a malformed frame
    }
    if (ev.type === 'token') handlers.onToken?.(ev.text);
    else if (ev.type === 'tool') handlers.onTool?.(ev.name, ev.detail);
    else if (ev.type === 'visited') handlers.onVisited?.(ev.card);
    else if (ev.type === 'error') {
      handlers.onError?.(ev.message);
      return true;
    } else if (ev.type === 'done') {
      handlers.onDone?.();
      return true;
    }
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf('\n\n');
    while (nl !== -1) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      if (dispatch(frame)) {
        await reader.cancel();
        return;
      }
      nl = buf.indexOf('\n\n');
    }
  }
  // Process a final frame not terminated by a blank line.
  if (buf.trim()) dispatch(buf);
}
