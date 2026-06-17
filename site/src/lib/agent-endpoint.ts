import type { DocsAgentEvent } from './agent-types';

/**
 * Shared plumbing for the agent SSE endpoints (/api/ask, /api/chat):
 * a global concurrency cap and the streaming + error-sanitizing wrapper.
 * Each agent run fans out to several model calls; the endpoint may be
 * publicly reachable (e.g. via a tunnel), so this bounds abuse.
 */

export const MAX_QUERY_LEN = 600;
const MAX_CONCURRENT = 3;
let inFlight = 0;

/** True when the global concurrency cap is hit — caller should 429. */
export function tooBusy(): boolean {
  return inFlight >= MAX_CONCURRENT;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

/**
 * Run an agent event stream as an SSE Response. Wires request abort to
 * the run, sends a generic frame on error (real error logged server-side
 * so internals don't leak), and releases the concurrency slot when done.
 * Call `tooBusy()` and validate input BEFORE this.
 */
export function streamAgent(
  request: Request,
  run: (signal: AbortSignal) => AsyncIterable<DocsAgentEvent>,
  label: string,
): Response {
  inFlight++;
  const ctrl = new AbortController();
  request.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      try {
        for await (const ev of run(ctrl.signal)) {
          if (ev.type === 'error') {
            console.error(`[${label}] agent error:`, ev.message);
            send({ type: 'error', message: 'The assistant is unavailable. Please try again.' });
            break;
          }
          send(ev);
          if (ev.type === 'done') break;
        }
      } catch (e) {
        console.error(`[${label}] stream error:`, e);
        send({ type: 'error', message: 'The assistant is unavailable.' });
      } finally {
        inFlight--;
        controller.close();
      }
    },
    cancel() {
      ctrl.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
