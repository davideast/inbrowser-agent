/**
 * RTDB REST client — pure `fetch`, no `firebase-admin`. The verbs
 * (get/put/patch/delete) and the SSE stream parser are factored out
 * so the job-store layer can compose them without knowing about
 * auth or URL shapes.
 *
 * Built directly from the implementation proven against Cloud Run in
 * PR #327 (see `plans/sw-inference-backgrounding-recovery.md`). The
 * one tweak: this version is parameterized on a `TokenProvider` and
 * a `baseUrl` so it works for any RTDB instance, not just the
 * playground's hardcoded one.
 */
import type { TokenProvider } from './auth.js';

export interface RtdbClientConfig {
  /** RTDB base URL, e.g. 'https://my-db.firebaseio.com'. No trailing slash. */
  url: string;
  auth: TokenProvider;
}

export interface RtdbClient {
  get<T>(path: string, query?: Record<string, string>): Promise<T | null>;
  put(path: string, data: unknown): Promise<void>;
  patch(path: string, data: Record<string, unknown>): Promise<void>;
  delete(path: string): Promise<void>;
  streamEvents(path: string, signal: AbortSignal): AsyncGenerator<RtdbStreamEvent>;
}

export interface RtdbStreamEvent {
  /** 'put' | 'patch' | 'keep-alive' | 'cancel' | 'auth_revoked'. */
  event: string;
  /** Path relative to the streamed node, e.g. '/' or '/events/3'. */
  path?: string;
  data?: unknown;
}

export function createRtdbClient(config: RtdbClientConfig): RtdbClient {
  const base = config.url.replace(/\/+$/, '');

  function pathUrl(path: string, query?: Record<string, string>): string {
    const clean = path.replace(/^\/+/, '');
    const qs = query
      ? '&' +
        Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&')
      : '';
    return `${base}/${clean}.json?${qs.slice(1)}`;
  }

  async function authHeader(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await config.auth.getToken()}` };
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = await authHeader();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(pathUrl(path, query), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(
        `rtdb ${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    return res;
  }

  return {
    async get<T>(path: string, query?: Record<string, string>): Promise<T | null> {
      const res = await request('GET', path, undefined, query);
      return (await res.json()) as T | null;
    },

    async put(path: string, data: unknown): Promise<void> {
      await request('PUT', path, data);
    },

    async patch(path: string, data: Record<string, unknown>): Promise<void> {
      await request('PATCH', path, data);
    },

    async delete(path: string): Promise<void> {
      await request('DELETE', path);
    },

    async *streamEvents(
      path: string,
      signal: AbortSignal,
    ): AsyncGenerator<RtdbStreamEvent> {
      const headers = { ...(await authHeader()), Accept: 'text/event-stream' };
      const res = await fetch(pathUrl(path), { headers, signal });
      if (!res.ok || !res.body) {
        throw new Error(`rtdb stream ${path} failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let eventName = '';
            let dataStr = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (!eventName) continue;
            let parsed: unknown = null;
            try {
              parsed = dataStr ? JSON.parse(dataStr) : null;
            } catch {
              parsed = null;
            }
            const wrapped =
              parsed !== null && typeof parsed === 'object' && 'path' in parsed;
            yield {
              event: eventName,
              path: wrapped
                ? (parsed as { path?: string }).path
                : undefined,
              data: wrapped ? (parsed as { data?: unknown }).data : parsed,
            };
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
