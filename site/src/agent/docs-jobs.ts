import { createJobEngine } from '@inbrowser/resumable';
import { createMemoryJobStore } from '@inbrowser/resumable/memory';
import type { DocsAgentEvent } from '../lib/agent-types';
import { type TurnMessage, runDocsAgent } from './docs-agent';

/**
 * The docs chat runs as a durable `@inbrowser/resumable` job. The agent's event
 * stream is appended to an in-memory store keyed by jobId, so a dropped
 * connection or a backgrounded tab can reconnect and replay from its offset
 * instead of losing the answer. Jobs stay replayable for a short window after
 * the answer finishes (post-terminal TTL).
 */
const JOB_TTL_MS = 10 * 60_000;
const MAX_CONCURRENT = 3;
let inFlight = 0;

const engine = createJobEngine<DocsAgentEvent>({
  store: createMemoryJobStore<DocsAgentEvent>({ defaultTtlMs: JOB_TTL_MS }),
});

/** True when the global concurrency cap is hit; the caller should 429. */
export function docsTooBusy(): boolean {
  return inFlight >= MAX_CONCURRENT;
}

/** Start a docs-agent run as a resumable job; resolves with its id once the job
 *  exists (the producer then drives in the background). */
export async function startDocsJob(messages: TurnMessage[]): Promise<string> {
  inFlight++;
  const { jobId } = await engine.start(async function* (ctx) {
    try {
      for await (const ev of runDocsAgent(messages, ctx.signal)) {
        // Sanitize agent errors before they are stored/replayed: log the real
        // reason server-side, surface a generic message to the client.
        if (ev.type === 'error') {
          console.error('[api/chat] agent error:', ev.message);
          yield { type: 'error', message: 'The assistant is unavailable. Please try again.' };
        } else {
          yield ev;
        }
      }
    } finally {
      inFlight--;
    }
  });
  return jobId;
}

/** Whether a job still exists (running, or terminal within its TTL). */
export async function docsJobExists(jobId: string): Promise<boolean> {
  return (await engine.get(jobId)) !== null;
}

/** Subscribe to a job's events from a seq offset (replay then live). */
export function subscribeDocsJob(jobId: string, from: number, signal: AbortSignal) {
  return engine.subscribe(jobId, { from, signal });
}
