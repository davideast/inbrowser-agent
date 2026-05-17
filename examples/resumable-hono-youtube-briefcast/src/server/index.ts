import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createJobEngine, type JobStore } from '@inbrowser/resumable';
import { createMemoryJobStore } from '@inbrowser/resumable/memory';
import {
  createRtdbJobStore,
  serviceAccountTokenProvider,
  type TokenProvider,
} from '@inbrowser/resumable/rtdb';
import type { BriefcastEvent } from '../shared/types';
import { createBriefcastApp } from './app';
import { createFileAudioStore } from './audio-store';
import { createBriefcastRunner } from './briefcast-runner';
import { createGeminiBriefcastServices } from './gemini';
import {
  createMemoryBriefcastIndexStore,
  createRtdbBriefcastIndexStore,
  type BriefcastIndexStore,
} from './index-store';

const port = Number(process.env.BRIEFCAST_PORT ?? 8787);
const rtdbUrl = process.env.RTDB_URL;
const geminiApiKey = process.env.GEMINI_API_KEY;
const serviceAccountFile = process.env.SERVICE_ACCOUNT_FILE;
const textModel = process.env.GEMINI_TEXT_MODEL ?? 'gemini-3.1-flash-lite';
const ttsModel = process.env.GEMINI_TTS_MODEL ?? 'gemini-3.1-flash-tts-preview';
const ttsVoice = process.env.GEMINI_TTS_VOICE ?? 'Kore';
const audioStore = createFileAudioStore(
  resolve(import.meta.dir, '../../.data/audio'),
);
const stores = await createStores({
  rtdbUrl,
  serviceAccountFile,
  defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
});

const engine = createJobEngine<BriefcastEvent>({
  store: stores.jobStore,
  sweep: {
    intervalMs: 60 * 60 * 1000,
  },
});

const runBriefcast = geminiApiKey
  ? createBriefcastRunner(
      createGeminiBriefcastServices({
        apiKey: geminiApiKey,
        textModel,
        ttsModel,
        ttsVoice,
        audioStore,
      }),
    )
  : createMissingGeminiRunner();

const app = createBriefcastApp({
  engine,
  audioStore,
  indexStore: stores.indexStore,
  runBriefcast,
  runtime: {
    storeMode: stores.mode,
    durable: stores.mode === 'rtdb',
    fallbackReason: stores.fallbackReason,
    geminiConfigured: Boolean(geminiApiKey),
  },
});

serve({ fetch: app.fetch, port });
console.log(
  `YouTube Briefcast API listening on http://localhost:${port} ` +
    `(${stores.mode} store${stores.fallbackReason ? ', RTDB fallback active' : ''}` +
    `${geminiApiKey ? '' : ', GEMINI_API_KEY missing'})`,
);
if (stores.fallbackReason) console.warn(stores.fallbackReason);

async function createStores(opts: {
  rtdbUrl?: string;
  serviceAccountFile?: string;
  defaultTtlMs: number;
}): Promise<{
  mode: 'memory' | 'rtdb';
  jobStore: JobStore<BriefcastEvent>;
  indexStore: BriefcastIndexStore;
  fallbackReason?: string;
}> {
  const requested = process.env.BRIEFCAST_STORE?.trim().toLowerCase();
  if (requested && requested !== 'memory' && requested !== 'rtdb') {
    throw new Error('BRIEFCAST_STORE must be "memory" or "rtdb"');
  }

  const hasRtdbConfig = Boolean(opts.rtdbUrl && opts.serviceAccountFile);
  const mode: 'memory' | 'rtdb' =
    requested === 'memory' || requested === 'rtdb'
      ? requested
      : hasRtdbConfig
        ? 'rtdb'
        : 'memory';

  if (mode === 'memory') {
    if (!requested && !hasRtdbConfig) {
      console.warn(
        'Using in-memory briefcast storage. Set BRIEFCAST_STORE=rtdb, ' +
          'RTDB_URL, and SERVICE_ACCOUNT_FILE for durable RTDB-backed jobs.',
      );
    }
    return createMemoryStores(opts.defaultTtlMs);
  }

  if (!opts.rtdbUrl || !opts.serviceAccountFile) {
    throw new Error(
      'BRIEFCAST_STORE=rtdb requires RTDB_URL and SERVICE_ACCOUNT_FILE',
    );
  }

  const auth = serviceAccountTokenProvider({ keyFile: opts.serviceAccountFile });
  try {
    await probeRtdb(opts.rtdbUrl, auth);
  } catch (e) {
    if (!shouldFallbackFromRtdb(requested)) throw e;
    const reason =
      'RTDB is configured but unavailable, so the example fell back to ' +
      `in-memory storage. Set BRIEFCAST_RTDB_FALLBACK=off to fail fast. ${errorMessage(e)}`;
    return createMemoryStores(opts.defaultTtlMs, reason);
  }

  return {
    mode,
    jobStore: createRtdbJobStore<BriefcastEvent>({
      url: opts.rtdbUrl,
      auth,
      rootPath: 'briefcast_jobs',
      defaultTtlMs: opts.defaultTtlMs,
      onWarn: (message, fields) => {
        console.warn(message, fields);
      },
    }),
    indexStore: createRtdbBriefcastIndexStore({
      url: opts.rtdbUrl,
      auth,
      rootPath: 'briefcast_index',
    }),
  };
}

function createMemoryStores(
  defaultTtlMs: number,
  fallbackReason?: string,
): {
  mode: 'memory';
  jobStore: JobStore<BriefcastEvent>;
  indexStore: BriefcastIndexStore;
  fallbackReason?: string;
} {
  return {
    mode: 'memory',
    jobStore: createMemoryJobStore<BriefcastEvent>({ defaultTtlMs }),
    indexStore: createMemoryBriefcastIndexStore(),
    fallbackReason,
  };
}

async function probeRtdb(url: string, auth: TokenProvider): Promise<void> {
  const token = await auth.getToken();
  const res = await fetch(`${trimRight(url)}/.json?shallow=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `RTDB probe failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
}

function shouldFallbackFromRtdb(requested: string | undefined): boolean {
  const raw = process.env.BRIEFCAST_RTDB_FALLBACK?.trim().toLowerCase();
  if (raw) return raw !== 'off' && raw !== 'false' && raw !== '0';
  return requested !== 'rtdb';
}

function trimRight(value: string): string {
  return value.replace(/\/+$/, '');
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function createMissingGeminiRunner(): (
  jobId: string,
  url: string,
) => AsyncGenerator<BriefcastEvent> {
  return async function* runMissingGemini(jobId, url) {
    yield { kind: 'accepted', jobId, url, createdAt: Date.now() };
    yield {
      kind: 'error',
      message:
        'Missing GEMINI_API_KEY. Add it to the example .env file to generate a real briefcast.',
    };
  };
}
