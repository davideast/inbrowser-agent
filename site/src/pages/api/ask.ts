import type { APIRoute } from 'astro';
import { askDocs } from '../../agent/docs-agent';
import { MAX_QUERY_LEN, streamAgent, tooBusy } from '../../lib/agent-endpoint';

// On-demand (server) route — single-question keystone path.
export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: { q?: unknown };
  try {
    body = (await request.json()) as { q?: unknown };
  } catch {
    return new Response('invalid JSON body', { status: 400 });
  }

  const q = typeof body.q === 'string' ? body.q.trim() : '';
  if (!q) return new Response('missing "q"', { status: 400 });
  if (q.length > MAX_QUERY_LEN) {
    return new Response(`query too long (max ${MAX_QUERY_LEN} chars)`, { status: 413 });
  }
  if (tooBusy()) return new Response('busy — too many concurrent requests', { status: 429 });

  return streamAgent(request, (signal) => askDocs(q, signal), 'api/ask');
};
