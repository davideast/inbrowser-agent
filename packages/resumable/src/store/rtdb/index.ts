/**
 * Firebase Realtime Database — production `JobStore` implementation.
 * Backed by RTDB REST + SSE for tailing. Built directly from the
 * implementation proven against Cloud Run in PR #327 (see
 * `plans/sw-inference-backgrounding-recovery.md`).
 *
 * Layout under `{rootPath}/{jobId}`:
 *   - `status`, `reason`, `createdAt`, `updatedAt`, `finishedAt`,
 *     `expiresAt`, `data` (JSON object)
 *   - `events/{seq}` — each event is a JSON *string* (stringified so
 *     RTDB's type coercion can't reshape the value). `seq` is the
 *     subscriber's resume offset.
 *
 * `sweepExpired` uses RTDB's indexed query
 * `orderBy="expiresAt"&endAt={now}` and requires a server-side index
 * declared in `database.rules.json`:
 *
 *   {
 *     "rules": {
 *       "{rootPath}": { ".indexOn": ["expiresAt"] }
 *     }
 *   }
 *
 * Without the index, sweep falls back to a full scan and logs a
 * warning (so a misconfigured deploy still works correctness-wise,
 * just less efficiently).
 */
import type { JobMeta, JobSnapshot, TerminalStatus } from '../../types.js';
import type {
  JobStore,
  SweepOpts,
  SweepResult,
} from '../contract.js';
import { defaultGenerateId, type IdGenerator } from '../../ids.js';
import type { TokenProvider } from './auth.js';
import { createRtdbClient } from './rest.js';

export interface CreateRtdbJobStoreOpts {
  /** RTDB base URL, e.g. 'https://my-db.firebaseio.com'. */
  url: string;
  /** Auth provider for the RTDB REST API. */
  auth: TokenProvider;
  /**
   * Path prefix for jobs. Default `resumable_jobs`. The LLM relay
   * historically uses `inference_jobs` — pass that here to preserve
   * compatibility with existing data.
   */
  rootPath?: string;
  /** Default TTL applied to jobs without their own `ttlMs`. */
  defaultTtlMs?: number;
  /** Inject the clock for tests. Default `Date.now`. */
  now?: () => number;
  /** Override the id generator. Default `crypto.randomUUID()`. */
  generateId?: IdGenerator;
  /**
   * Optional warn callback for non-fatal issues (e.g. sweep falling
   * back to scan because `.indexOn` isn't deployed). Default no-op.
   */
  onWarn?: (msg: string, fields?: Record<string, unknown>) => void;
}

interface RawJob {
  status?: 'running' | TerminalStatus;
  reason?: string | null;
  data?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  finishedAt?: number | null;
  expiresAt?: number | null;
  /** RTDB returns contiguous 0..n integer keys as an array, gaps as
   *  an object — `eventEntries` handles both. */
  events?: unknown;
}

export function createRtdbJobStore<TEvent>(
  opts: CreateRtdbJobStoreOpts,
): JobStore<TEvent> {
  const client = createRtdbClient({ url: opts.url, auth: opts.auth });
  const rootPath = opts.rootPath ?? 'resumable_jobs';
  const now = opts.now ?? Date.now;
  const generateId = opts.generateId ?? defaultGenerateId;
  const defaultTtlMs = opts.defaultTtlMs;
  const warn = opts.onWarn ?? (() => {});

  function jobPath(id: string): string {
    return `${rootPath}/${id}`;
  }

  function snapshotFromRaw(id: string, raw: RawJob | null): JobSnapshot<TEvent> | null {
    if (!raw || !raw.status) return null;
    return {
      id,
      status: raw.status,
      reason: raw.reason ?? null,
      events: normalizeEvents<TEvent>(raw.events),
      data: raw.data ?? {},
      createdAt: raw.createdAt ?? 0,
      updatedAt: raw.updatedAt ?? 0,
      finishedAt: raw.finishedAt ?? null,
      expiresAt: raw.expiresAt ?? null,
    };
  }

  return {
    async create(meta: JobMeta): Promise<{ jobId: string }> {
      const id = generateId();
      const t = now();
      const ttlMs = meta.ttlMs ?? defaultTtlMs;
      await client.put(jobPath(id), {
        status: 'running',
        reason: null,
        data: meta.data ?? {},
        ...(typeof ttlMs === 'number' ? { ttlMs } : {}),
        createdAt: t,
        updatedAt: t,
        finishedAt: null,
        expiresAt: null,
      });
      return { jobId: id };
    },

    async append(jobId: string, seq: number, event: TEvent): Promise<void> {
      // Store events as JSON strings — RTDB drops empty objects /
      // `undefined` keys silently and reshapes arrays/objects, so a
      // stringified opaque value is the only way to round-trip
      // arbitrary `TEvent` shapes losslessly.
      await client.put(`${jobPath(jobId)}/events/${seq}`, JSON.stringify(event));
      await client.patch(jobPath(jobId), { updatedAt: now() });
    },

    async finish(
      jobId: string,
      status: TerminalStatus,
      reason?: string,
    ): Promise<void> {
      // Read the current job to compute expiresAt from ttlMs we
      // stashed at create() (the contract doesn't carry the TTL
      // through to finish(), and re-passing it would be a foot-gun).
      const raw = await client.get<RawJob & { ttlMs?: number }>(jobPath(jobId));
      const finishedAt = now();
      const ttlMs = raw?.ttlMs ?? defaultTtlMs;
      const expiresAt = typeof ttlMs === 'number' ? finishedAt + ttlMs : null;
      await client.patch(jobPath(jobId), {
        status,
        reason: reason ?? null,
        finishedAt,
        expiresAt,
        updatedAt: finishedAt,
      });
    },

    async snapshot(jobId: string): Promise<JobSnapshot<TEvent> | null> {
      const raw = await client.get<RawJob>(jobPath(jobId));
      return snapshotFromRaw(jobId, raw);
    },

    async *watch(
      jobId: string,
      streamOpts?: { from?: number; signal?: AbortSignal },
    ): AsyncIterable<JobSnapshot<TEvent>> {
      const signal = streamOpts?.signal ?? new AbortController().signal;
      // Local mirror — applied to from RTDB's `put`/`patch` deltas.
      // RTDB delivers the full node first, then incremental deltas.
      let status: 'running' | TerminalStatus = 'running';
      let reason: string | null = null;
      let createdAt = 0;
      let updatedAt = 0;
      let finishedAt: number | null = null;
      let expiresAt: number | null = null;
      let data: Record<string, unknown> = {};
      const events = new Map<number, TEvent>();
      let jobExists = false;

      const buildSnapshot = (): JobSnapshot<TEvent> => ({
        id: jobId,
        status,
        reason,
        events: [...events.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, e]) => e),
        data: { ...data },
        createdAt,
        updatedAt,
        finishedAt,
        expiresAt,
      });

      const applyNode = (node: (RawJob & { ttlMs?: number }) | null): void => {
        if (!node) {
          jobExists = false;
          return;
        }
        jobExists = true;
        if (node.status) status = node.status;
        if (node.reason !== undefined) reason = node.reason ?? null;
        if (node.data !== undefined) data = node.data;
        if (node.createdAt) createdAt = node.createdAt;
        if (node.updatedAt) updatedAt = node.updatedAt;
        if (node.finishedAt !== undefined) finishedAt = node.finishedAt;
        if (node.expiresAt !== undefined) expiresAt = node.expiresAt;
        for (const [seq, event] of eventEntries<TEvent>(node.events)) {
          events.set(seq, event);
        }
      };

      for await (const ev of client.streamEvents(jobPath(jobId), signal)) {
        if (ev.event === 'keep-alive') continue;
        if (ev.event === 'cancel' || ev.event === 'auth_revoked') return;
        if (ev.event !== 'put' && ev.event !== 'patch') continue;

        const path = ev.path ?? '/';
        if (path === '/') {
          applyNode(ev.data as (RawJob & { ttlMs?: number }) | null);
          if (!jobExists) return; // job deleted out from under us
        } else if (path === '/events') {
          applyNode({ events: ev.data });
        } else if (path.startsWith('/events/')) {
          const seq = Number(path.slice('/events/'.length));
          if (Number.isFinite(seq) && typeof ev.data === 'string') {
            events.set(seq, JSON.parse(ev.data) as TEvent);
          }
        } else if (path === '/status' && typeof ev.data === 'string') {
          status = ev.data as 'running' | TerminalStatus;
        } else if (path === '/reason') {
          reason = typeof ev.data === 'string' ? ev.data : null;
        } else if (path === '/finishedAt') {
          finishedAt = typeof ev.data === 'number' ? ev.data : null;
        } else if (path === '/expiresAt') {
          expiresAt = typeof ev.data === 'number' ? ev.data : null;
        } else if (path === '/updatedAt' && typeof ev.data === 'number') {
          updatedAt = ev.data;
        }

        yield buildSnapshot();
      }
    },

    async delete(jobId: string): Promise<void> {
      // Delete events first then the root — a racing watcher sees an
      // empty events tree + terminal status in the same snapshot and
      // closes cleanly.
      await client.delete(`${jobPath(jobId)}/events`);
      await client.delete(jobPath(jobId));
    },

    async sweepExpired(sweepOpts: SweepOpts): Promise<SweepResult> {
      const t0 = now();
      const filter = new Set<TerminalStatus>(
        sweepOpts.statusFilter ?? ['done', 'error', 'cancelled'],
      );
      const batchSize = sweepOpts.batchSize ?? 200;

      let candidates: Record<string, RawJob> | null;
      try {
        // Indexed query — fast path when `.indexOn: ["expiresAt"]`
        // is declared in `database.rules.json`.
        candidates = await client.get<Record<string, RawJob>>(rootPath, {
          orderBy: '"expiresAt"',
          endAt: String(sweepOpts.olderThan),
        });
      } catch (e) {
        // Most likely a missing-index error. Fall back to a full
        // scan + client-side filter so the deploy still functions.
        warn('sweep falling back to full scan — missing .indexOn?', {
          error: e instanceof Error ? e.message : String(e),
          rootPath,
        });
        candidates = await client.get<Record<string, RawJob>>(rootPath);
      }

      let scanned = 0;
      let deleted = 0;
      if (candidates) {
        for (const [id, raw] of Object.entries(candidates)) {
          if (deleted >= batchSize) break;
          scanned++;
          if (!raw || raw.status === 'running') continue;
          if (!raw.status || !filter.has(raw.status)) continue;
          if (
            typeof raw.expiresAt !== 'number' ||
            raw.expiresAt > sweepOpts.olderThan
          ) {
            continue;
          }
          await client.delete(`${rootPath}/${id}/events`);
          await client.delete(`${rootPath}/${id}`);
          deleted++;
        }
      }
      return { scanned, deleted, durationMs: now() - t0 };
    },
  };
}

/** RTDB hands back `events` as an array (contiguous integer keys) or
 *  an object (gaps); each value is a stringified `TEvent`. */
function eventEntries<TEvent>(raw: unknown): Array<[number, TEvent]> {
  if (!raw) return [];
  const pairs: Array<[number, unknown]> = Array.isArray(raw)
    ? raw.map((value, index) => [index, value] as [number, unknown])
    : Object.entries(raw as Record<string, unknown>).map(
        ([key, value]) => [Number(key), value] as [number, unknown],
      );
  return pairs
    .filter(([seq, value]) => Number.isFinite(seq) && typeof value === 'string')
    .map(
      ([seq, value]) =>
        [seq, JSON.parse(value as string) as TEvent] as [number, TEvent],
    )
    .sort((a, b) => a[0] - b[0]);
}

function normalizeEvents<TEvent>(raw: unknown): TEvent[] {
  return eventEntries<TEvent>(raw).map(([, event]) => event);
}

export type { TokenProvider } from './auth.js';
export {
  staticTokenProvider,
  serviceAccountTokenProvider,
  type ServiceAccountTokenProviderOpts,
} from './auth.js';
