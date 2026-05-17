import { describe, expect, it } from 'bun:test';
import { createJobEngine } from '@inbrowser/resumable';
import { createMemoryJobStore } from '@inbrowser/resumable/memory';
import { createBriefcastApp } from '../src/server/app';
import { createMemoryBriefcastIndexStore } from '../src/server/index-store';
import type { AudioStore } from '../src/server/audio-store';
import type { BriefcastEvent } from '../src/shared/types';

const audioStore: AudioStore = {
  save: async (_jobId, index) => `/audio/job/${index}.wav`,
  saveFile: async (_jobId, fileName) => `/audio/job/${fileName}`,
  read: async () => new Uint8Array([1, 2, 3]),
  readFile: async () => new Uint8Array([1, 2, 3]),
};

describe('briefcast app', () => {
  it('GET /api/health reports storage durability', async () => {
    const app = makeApp(async function* () {}, {
      runtime: {
        storeMode: 'memory',
        durable: false,
        geminiConfigured: true,
        fallbackReason: 'RTDB probe failed',
      },
    });

    const res = await app.request('/api/health');
    const body = (await res.json()) as {
      durable: boolean;
      fallbackReason?: string;
      storeMode: string;
    };

    expect(body.storeMode).toBe('memory');
    expect(body.durable).toBe(false);
    expect(body.fallbackReason).toBe('RTDB probe failed');
  });

  it('POST /api/briefcasts creates an index entry and returns a job id', async () => {
    const app = makeApp(async function* (jobId, url) {
      yield { kind: 'accepted', jobId, url, createdAt: 100 };
      yield { kind: 'ready', jobId, audioSegmentCount: 0, elapsedMs: 1 };
    });

    const res = await app.request('/api/briefcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://youtube.com/watch?v=abc' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBeTruthy();

    await waitForJob(app, body.jobId);
    const list = (await (await app.request('/api/briefcasts')).json()) as {
      items: Array<{ jobId: string; status: string }>;
    };
    expect(list.items[0]).toMatchObject({ jobId: body.jobId, status: 'ready' });
  });

  it('stream endpoint replays from from=N', async () => {
    const app = makeApp(async function* (jobId, url) {
      yield { kind: 'accepted', jobId, url, createdAt: 100 };
      yield { kind: 'writeup_chunk', chunk: 'one' };
      yield { kind: 'writeup_chunk', chunk: 'two' };
      yield { kind: 'ready', jobId, audioSegmentCount: 0, elapsedMs: 1 };
    });

    const start = await app.request('/api/briefcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://youtube.com/watch?v=abc' }),
    });
    const { jobId } = (await start.json()) as { jobId: string };
    await waitForJob(app, jobId);

    const stream = await app.request(`/api/briefcasts/${jobId}/stream?from=2`);
    const events = parseSse(await stream.text());
    expect(events.map((event) => event.kind)).toEqual(['writeup_chunk', 'ready']);
  });

  it('audio route serves generated WAV bytes', async () => {
    const app = makeApp(async function* () {});
    const res = await app.request('/audio/job/0.wav');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/wav');

    const combined = await app.request('/audio/job/combined.wav');
    expect(combined.status).toBe(200);
    expect(combined.headers.get('content-type')).toContain('audio/wav');
  });

  it('GET /api/briefcasts explains index setup failures', async () => {
    const app = makeApp(async function* () {}, {
      indexStore: {
        ...createMemoryBriefcastIndexStore(),
        list: async () => {
          throw new Error('missing RTDB credentials');
        },
      },
    });

    const res = await app.request('/api/briefcasts');
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(503);
    expect(body.error).toContain('Briefcast index unavailable');
    expect(body.error).toContain('missing RTDB credentials');
  });
});

function makeApp(
  runBriefcast: (jobId: string, url: string) => AsyncIterable<BriefcastEvent>,
  opts: {
    indexStore?: ReturnType<typeof createMemoryBriefcastIndexStore>;
    runtime?: Parameters<typeof createBriefcastApp>[0]['runtime'];
  } = {},
) {
  const engine = createJobEngine<BriefcastEvent>({
    store: createMemoryJobStore<BriefcastEvent>(),
  });
  return createBriefcastApp({
    engine,
    audioStore,
    indexStore: opts.indexStore ?? createMemoryBriefcastIndexStore(),
    runBriefcast,
    runtime: opts.runtime,
    now: () => 100,
  });
}

async function waitForJob(app: ReturnType<typeof makeApp>, jobId: string) {
  for (let i = 0; i < 20; i++) {
    const res = await app.request(`/api/briefcasts/${jobId}`);
    const body = (await res.json()) as {
      briefcast: { terminalStatus: string };
    };
    if (body.briefcast.terminalStatus !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parseSse(text: string): BriefcastEvent[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as BriefcastEvent);
}
