import type { APIRoute } from 'astro';
import { docsJobExists, subscribeDocsJob } from '../../../agent/docs-jobs';

// Stream a docs job's events as SSE from a seq offset, so the browser can
// reconnect and replay after a dropped connection or a backgrounded tab.
export const prerender = false;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

export const GET: APIRoute = async ({ params, request, url }) => {
  const jobId = params.id;
  if (!jobId) return new Response('missing job id', { status: 400 });
  if (!(await docsJobExists(jobId))) return new Response('job not found', { status: 404 });

  const from = Math.max(0, Math.trunc(Number(url.searchParams.get('from')) || 0));

  const ctrl = new AbortController();
  request.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The consumer can disconnect at any time (reload, reconnect, abort),
      // which closes the controller out from under us. Guard enqueue/close so a
      // late event never throws "Controller is already closed".
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
      send(': stream-open\n\n'); // flush any proxy buffers
      try {
        for await (const ev of subscribeDocsJob(jobId, from, ctrl.signal)) {
          if (closed) break;
          if (ev.kind === 'event') {
            send(`data: ${JSON.stringify(ev.value)}\n\n`);
          } else if (ev.kind === 'terminal') {
            send('data: [DONE]\n\n'); // job reached terminal state
            close();
            return;
          }
        }
        // Subscribe ended without a terminal marker (aborted): close without
        // [DONE] so the client decides whether to reconnect.
        close();
      } catch (e) {
        console.error('[api/chat stream] error:', e);
        close();
      }
    },
    cancel() {
      ctrl.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
};
