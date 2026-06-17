import type { APIRoute } from 'astro';
import { type TurnMessage, runDocsAgent } from '../../agent/docs-agent';
import { MAX_QUERY_LEN, streamAgent, tooBusy } from '../../lib/agent-endpoint';

// On-demand (server) route — multi-turn chat path.
export const prerender = false;

const MAX_MESSAGES = 40;
// Prior turns are client-controlled and fed into the model prompt, so
// bound each message and the total — not just the latest turn.
const MAX_MESSAGE_LEN = 8000;
const MAX_TOTAL_LEN = 48000;

export const POST: APIRoute = async ({ request }) => {
  let body: { messages?: unknown };
  try {
    body = (await request.json()) as { messages?: unknown };
  } catch {
    return new Response('invalid JSON body', { status: 400 });
  }

  const raw = Array.isArray(body.messages) ? body.messages : null;
  if (!raw || raw.length === 0) return new Response('missing "messages"', { status: 400 });
  if (raw.length > MAX_MESSAGES) return new Response('too many messages', { status: 413 });

  const messages: TurnMessage[] = [];
  let total = 0;
  for (const m of raw) {
    const role = (m as { role?: unknown }).role;
    const text = (m as { text?: unknown }).text;
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string') {
      return new Response('invalid message shape', { status: 400 });
    }
    if (text.length > MAX_MESSAGE_LEN) return new Response('message too long', { status: 413 });
    total += text.length;
    if (total > MAX_TOTAL_LEN) return new Response('conversation too long', { status: 413 });
    messages.push({ role, text });
  }

  const latest = messages[messages.length - 1];
  if (latest.role !== 'user' || !latest.text.trim()) {
    return new Response('last message must be a non-empty user turn', { status: 400 });
  }
  if (latest.text.length > MAX_QUERY_LEN) {
    return new Response(`message too long (max ${MAX_QUERY_LEN} chars)`, { status: 413 });
  }
  if (tooBusy()) return new Response('busy — too many concurrent requests', { status: 429 });

  return streamAgent(request, (signal) => runDocsAgent(messages, signal), 'api/chat');
};
