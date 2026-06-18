import { createResumableClient, installBrowserLifecycle } from '@inbrowser/resumable/client';
import type { DocsAgentEvent, VisitedCard } from './agent-types';

export interface AgentStreamHandlers {
  onToken?(text: string): void;
  onTool?(name: string, detail: string): void;
  onVisited?(card: VisitedCard): void;
  onError?(message: string): void;
  onDone?(): void;
}

/**
 * Start a resumable docs-agent job and dispatch its events to handlers. The
 * durable job, offset replay, reconnect-on-drop, and tab-visibility cut all
 * live in `@inbrowser/resumable/client` — this is just the docs-agent event
 * mapping. `url` is the start endpoint (POST -> { jobId }); the stream is
 * GET `${url}/${jobId}?from=<offset>`. Resolves when the run is done, errors,
 * or the caller aborts via `signal`.
 */
export async function streamAgent(
  url: string,
  body: unknown,
  handlers: AgentStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const client = createResumableClient<DocsAgentEvent>({
    startUrl: url,
    streamUrl: (jobId, from) => `${url}/${jobId}?from=${from}`,
    installLifecycle: installBrowserLifecycle(),
  });

  for await (const msg of client.stream(body, signal)) {
    if (msg.type === 'error') {
      handlers.onError?.(msg.message);
      return;
    }
    const ev = msg.event;
    if (ev.type === 'token') handlers.onToken?.(ev.text);
    else if (ev.type === 'tool') handlers.onTool?.(ev.name, ev.detail);
    else if (ev.type === 'visited') handlers.onVisited?.(ev.card);
    else if (ev.type === 'error') {
      handlers.onError?.(ev.message);
      return;
    } else if (ev.type === 'done') {
      handlers.onDone?.();
      return;
    }
  }
  // The job reached its terminal [DONE] without an explicit done event.
  handlers.onDone?.();
}
