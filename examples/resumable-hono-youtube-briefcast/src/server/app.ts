import type { JobEngine, JobEvent } from '@inbrowser/resumable';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { reduceBriefcastEvents, titleFromUrl } from '../shared/reducer';
import type {
  BriefcastEvent,
  BriefcastHealthResponse,
  BriefcastIndexEntry,
  BriefcastListResponse,
  BriefcastSnapshotResponse,
  BriefcastStartResponse,
} from '../shared/types';
import type { AudioStore } from './audio-store';
import type { BriefcastIndexStore } from './index-store';

export interface BriefcastAppDeps {
  engine: Pick<JobEngine<BriefcastEvent>, 'start' | 'subscribe' | 'get'>;
  indexStore: BriefcastIndexStore;
  audioStore: AudioStore;
  runBriefcast: (jobId: string, url: string) => AsyncIterable<BriefcastEvent>;
  runtime?: Omit<BriefcastHealthResponse, 'ok'>;
  now?: () => number;
}

export function createBriefcastApp(deps: BriefcastAppDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      storeMode: deps.runtime?.storeMode ?? 'memory',
      durable: deps.runtime?.durable ?? false,
      fallbackReason: deps.runtime?.fallbackReason,
      geminiConfigured: deps.runtime?.geminiConfigured ?? false,
    } satisfies BriefcastHealthResponse),
  );

  app.get('/api/briefcasts', async (c) => {
    try {
      const items = await deps.indexStore.list();
      return c.json({ items } satisfies BriefcastListResponse);
    } catch (e) {
      return c.json({ error: setupError('Briefcast index unavailable', e) }, 503);
    }
  });

  app.post('/api/briefcasts', async (c) => {
    let body: { url?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Expected JSON body' }, 400);
    }

    if (typeof body.url !== 'string' || !isYouTubeUrl(body.url)) {
      return c.json({ error: 'Expected a YouTube URL' }, 400);
    }

    const url = body.url.trim();
    const createdAt = now();
    let jobId: string;
    try {
      const started = await deps.engine.start(
        async function* ({ jobId }) {
          try {
            for await (const event of deps.runBriefcast(jobId, url)) {
              await deps.indexStore.applyEvent(jobId, event);
              yield event;
            }
          } catch (e) {
            const event: BriefcastEvent = {
              kind: 'error',
              message: e instanceof Error ? e.message : String(e),
            };
            await deps.indexStore.applyEvent(jobId, event);
            yield event;
          }
        },
        { data: { url }, ttlMs: 24 * 60 * 60 * 1000 },
      );
      jobId = started.jobId;
    } catch (e) {
      return c.json({ error: setupError('Briefcast job store unavailable', e) }, 503);
    }

    const entry: BriefcastIndexEntry = {
      jobId,
      url,
      title: titleFromUrl(url),
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
    };
    try {
      await deps.indexStore.upsert(entry);
      const snap = await deps.engine.get(jobId);
      for (const event of snap?.events ?? []) {
        await deps.indexStore.applyEvent(jobId, event);
      }
    } catch (e) {
      return c.json({ error: setupError('Briefcast index unavailable', e) }, 503);
    }
    return c.json({ jobId } satisfies BriefcastStartResponse, 201);
  });

  app.get('/api/briefcasts/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    let snap;
    try {
      snap = await deps.engine.get(jobId);
    } catch (e) {
      return c.json({ error: setupError('Briefcast job store unavailable', e) }, 503);
    }
    if (!snap) return c.json({ error: 'Briefcast not found' }, 404);
    let index: BriefcastIndexEntry | null;
    try {
      index = await deps.indexStore.get(jobId);
    } catch (e) {
      return c.json({ error: setupError('Briefcast index unavailable', e) }, 503);
    }
    const briefcast = reduceBriefcastEvents(jobId, snap.events, {
      index,
      terminalStatus: snap.status,
      terminalReason: snap.reason ?? undefined,
    });
    return c.json({ briefcast } satisfies BriefcastSnapshotResponse);
  });

  app.get('/api/briefcasts/:jobId/stream', async (c) => {
    const jobId = c.req.param('jobId');
    let snap;
    try {
      snap = await deps.engine.get(jobId);
    } catch (e) {
      return c.json({ error: setupError('Briefcast job store unavailable', e) }, 503);
    }
    if (!snap) return c.json({ error: 'Briefcast not found' }, 404);
    const from = parseFrom(c.req.query('from'));

    return streamSSE(c, async (stream) => {
      for await (const item of deps.engine.subscribe(jobId, { from })) {
        if (item.kind === 'event') {
          await stream.writeSSE({
            id: String(item.seq),
            data: JSON.stringify(item.value),
          });
        } else {
          await writeTerminal(stream, item);
          break;
        }
      }
    });
  });

  app.get('/audio/:jobId/:file', async (c) => {
    const jobId = c.req.param('jobId');
    const file = c.req.param('file');
    if (!/^(?:\d+|combined)\.wav$/.test(file)) return c.text('not found', 404);
    const bytes = await deps.audioStore.readFile(jobId, file);
    if (!bytes) return c.text('not found', 404);
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });

  return app;
}

function parseFrom(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      url.hostname === 'youtu.be' ||
      url.hostname.endsWith('.youtube.com') ||
      url.hostname === 'youtube.com'
    );
  } catch {
    return false;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function setupError(prefix: string, e: unknown): string {
  const message = errorMessage(e);
  if (isRtdbNotFound(message)) {
    return [
      prefix,
      'RTDB returned 404 Not Found.',
      'Check RTDB_URL and confirm the Realtime Database exists.',
      'A missing job path normally returns null, not a REST 404.',
      `Raw error: ${message}`,
    ].join(' ');
  }
  return `${prefix}: ${message}`;
}

function isRtdbNotFound(message: string): boolean {
  return /rtdb .* failed \(404\)|RTDB index 404/i.test(message);
}

async function writeTerminal(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  _item: Extract<JobEvent<BriefcastEvent>, { kind: 'terminal' }>,
): Promise<void> {
  await stream.writeSSE({ data: '[DONE]' });
}
