/**
 * SSE HTTP binding — serve a job subscription as Server-Sent Events.
 * Exported from the `@inbrowser/resumable` root (no `./http` subpath).
 *
 * The server half of resumable streaming, generic over the job's event type.
 * Pair it with the reconnecting consumer `createResumableClient` (also on
 * the root barrel).
 *
 * Wire format (relay <-> client channel):
 *   : stream-open\n\n            leading SSE comment; flushes buffering proxies
 *   data: <JSON event value>\n\n one line per event, in seq order from `from`
 *   data: [DONE]\n\n             only when the job reached a terminal status
 * A connection that closes WITHOUT `[DONE]` means the tail dropped; a resumable
 * client reconnects from the last offset it saw.
 */
import type { JobEvent } from './types.js';

/** First body byte that flushes response headers through buffering proxies. */
export const SSE_STREAM_OPEN = ': stream-open\n\n';

/** End-of-stream sentinel, emitted only when the job is terminal. */
export const SSE_DONE_LINE = 'data: [DONE]\n\n';

/** Serialize one value as an SSE `data:` line. */
export function encodeSseEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

export interface SseFromJobOpts {
  /**
   * Invoked when the consumer disconnects, so the caller can abort the
   * underlying subscription (e.g. its AbortController). Wire it to the same
   * signal passed to `engine.subscribe`.
   */
  onCancel?: () => void;
}

/**
 * Stream a job subscription as a Web-standard SSE `Response`. Sends each event's
 * value, a final `[DONE]` on terminal, and a leading stream-open comment.
 * Enqueue/close are guarded so a consumer that disconnects mid-stream never
 * throws "Controller is already closed".
 *
 * Typical use:
 *   const ctrl = new AbortController();
 *   request.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
 *   return sseFromJob(engine.subscribe(jobId, { from, signal: ctrl.signal }), {
 *     onCancel: () => ctrl.abort(),
 *   });
 */
export function sseFromJob<TEvent>(
  source: AsyncIterable<JobEvent<TEvent>>,
  opts: SseFromJobOpts = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by the consumer */
        }
      };
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true; // consumer went away mid-send
        }
      };
      send(SSE_STREAM_OPEN);
      try {
        for await (const evt of source) {
          if (closed) break;
          if (evt.kind === 'event') {
            send(encodeSseEvent(evt.value));
          } else if (evt.kind === 'terminal') {
            send(SSE_DONE_LINE);
            close();
            return;
          }
        }
        // Ended without a terminal marker (dropped tail): close without [DONE].
        close();
      } catch {
        close();
      }
    },
    cancel() {
      opts.onCancel?.();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
