import { sseFromJob } from '@inbrowser/resumable/http';
import type { APIRoute } from 'astro';
import { docsJobExists, subscribeDocsJob } from '../../../agent/docs-jobs';

// Stream a docs job's events as SSE from a seq offset, so the browser can
// reconnect and replay after a dropped connection or a backgrounded tab. The
// SSE encoding + guarded close live in the generic @inbrowser/resumable/http.
export const prerender = false;

export const GET: APIRoute = async ({ params, request, url }) => {
  const jobId = params.id;
  if (!jobId) return new Response('missing job id', { status: 400 });
  if (!(await docsJobExists(jobId))) return new Response('job not found', { status: 404 });

  const from = Math.max(0, Math.trunc(Number(url.searchParams.get('from')) || 0));
  const ctrl = new AbortController();
  request.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  return sseFromJob(subscribeDocsJob(jobId, from, ctrl.signal), { onCancel: () => ctrl.abort() });
};
