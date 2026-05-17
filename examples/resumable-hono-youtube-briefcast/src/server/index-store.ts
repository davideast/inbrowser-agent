import type { TokenProvider } from '@inbrowser/resumable/rtdb';
import type { BriefcastEvent, BriefcastIndexEntry } from '../shared/types';
import { applyEventToIndex } from '../shared/reducer';

export interface BriefcastIndexStore {
  list(): Promise<BriefcastIndexEntry[]>;
  get(jobId: string): Promise<BriefcastIndexEntry | null>;
  upsert(entry: BriefcastIndexEntry): Promise<void>;
  applyEvent(jobId: string, event: BriefcastEvent): Promise<void>;
}

export function createMemoryBriefcastIndexStore(): BriefcastIndexStore {
  const entries = new Map<string, BriefcastIndexEntry>();

  return {
    async list() {
      return [...entries.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(jobId) {
      return entries.get(jobId) ?? null;
    },
    async upsert(entry) {
      entries.set(entry.jobId, { ...entry });
    },
    async applyEvent(jobId, event) {
      const current = entries.get(jobId);
      if (!current) return;
      entries.set(jobId, applyEventToIndex(current, event));
    },
  };
}

export function createRtdbBriefcastIndexStore(opts: {
  url: string;
  auth: TokenProvider;
  rootPath?: string;
}): BriefcastIndexStore {
  const rootPath = trimSlashes(opts.rootPath ?? 'briefcast_index');

  async function request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T | null> {
    const token = await opts.auth.getToken();
    const url = `${trimRight(opts.url)}/${trimSlashes(path)}.json`;
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      throw new Error(`RTDB index ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return (await res.json()) as T | null;
  }

  return {
    async list() {
      const raw = await request<Record<string, BriefcastIndexEntry>>(rootPath);
      return Object.values(raw ?? {}).sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(jobId) {
      return request<BriefcastIndexEntry>(`${rootPath}/${jobId}`);
    },
    async upsert(entry) {
      await request(`${rootPath}/${entry.jobId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
    },
    async applyEvent(jobId, event) {
      const current = await this.get(jobId);
      if (!current) return;
      await this.upsert(applyEventToIndex(current, event));
    },
  };
}

function trimRight(value: string): string {
  return value.replace(/\/+$/, '');
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}
