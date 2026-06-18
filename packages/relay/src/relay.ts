/**
 * `createRelay` — wraps `@inbrowser/resumable`'s `JobEngine` with two
 * HTTP-shaped methods (`handleStart`, `handleStream`) and a provider
 * lookup table.
 *
 * The relay is **transport-agnostic** — it takes a Web-standard
 * `Request` and returns a Web-standard `Response`. Hono/Bun/Workers
 * plug in directly. The framework adapters at
 * `@inbrowser/relay/adapters/*` shim non-Web frameworks (Express,
 * Astro) without duplicating logic.
 */
import {
  type JobEngine,
  type JobStore,
  type Logger as ResumableLogger,
  type SweepSchedule,
  createJobEngine,
} from '@inbrowser/resumable';
import { sseFromJob } from '@inbrowser/resumable/http';
import type { InferenceEvent, InferenceProvider, NormalizedRequest } from './types.js';

/**
 * A server-managed API key for one provider. Either a static string
 * (resolved once at `createRelay` time — e.g. from an env var) or a
 * function called per request. The function form receives the parsed
 * `NormalizedRequest` plus the raw `Request`, so a host can derive the
 * key from auth headers, cookies, or a per-user store. It may return
 * the key synchronously or as a promise.
 */
export type ApiKeySource =
  | string
  | ((ctx: { req: NormalizedRequest; request: Request }) => string | Promise<string>);

export interface CreateRelayOpts {
  /** Backing `JobStore` for resumable inference jobs. */
  store: JobStore<InferenceEvent>;
  /**
   * Provider plug-in map, keyed by `NormalizedRequest.provider`.
   * Add new entries to support new upstream LLMs — no relay changes
   * required.
   */
  providers: Record<string, InferenceProvider>;
  /** Optional structured logger. Default is silent. */
  logger?: ResumableLogger;
  /**
   * Optional periodic sweep — passed through to the JobEngine. Use
   * when the store implements `sweepExpired` (memory, RTDB, Postgres);
   * stores with native backend TTL (Firestore, Redis) handle expiry
   * on their own and shouldn't pass this.
   */
  sweep?: SweepSchedule;
  /**
   * Per-provider server-managed API keys. When a provider is listed
   * here the relay resolves the key itself and overwrites whatever
   * the client sent — the browser never carries the key on the wire.
   * A client that nonetheless sends a non-empty `apiKey` for a
   * server-managed provider gets a 400 (so a forgotten BYOK field
   * can't silently leak to the wire). Providers NOT listed keep BYOK
   * semantics: the client supplies `apiKey` in the request body and
   * the relay 400s if it's missing.
   *
   * The function form gets the raw `Request`, so the key can be
   * derived from an `Authorization` header, a session cookie, or a
   * per-user store. See `plans/server-managed-api-keys.md`.
   */
  apiKeys?: Record<string, ApiKeySource>;
}

/**
 * Parameters the framework adapter pulls out of the URL and passes
 * to `handleStream`. The relay doesn't dictate URL shape — the
 * adapter parses `/api/inference/job/:id/stream?from=N` (or
 * whatever convention the host prefers) and forwards `jobId` + `from`.
 */
export interface StreamCtx {
  jobId: string;
  from?: number;
}

export interface Relay {
  handleStart(request: Request): Promise<Response>;
  handleStream(request: Request, ctx: StreamCtx): Promise<Response>;
  /** Direct access to the underlying engine — useful for tests and
   *  for hosts that want to invoke `engine.get(jobId)` directly. */
  readonly engine: JobEngine<InferenceEvent>;
  /** Close in-flight producers + stop the scheduled sweep. */
  stop(): Promise<void>;
}

const silentLogger: ResumableLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function createRelay(opts: CreateRelayOpts): Relay {
  const logger = opts.logger ?? silentLogger;
  const engine = createJobEngine<InferenceEvent>({
    store: opts.store,
    logger,
    ...(opts.sweep ? { sweep: opts.sweep } : {}),
  });

  async function handleStart(request: Request): Promise<Response> {
    let body: NormalizedRequest;
    try {
      body = (await request.json()) as NormalizedRequest;
    } catch (e) {
      return json(
        { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` },
        400,
      );
    }
    if (!body || typeof body !== 'object' || !body.provider) {
      return json({ error: 'provider is required' }, 400);
    }
    const provider = opts.providers[body.provider];
    if (!provider) {
      return json(
        {
          error: `unknown provider: ${body.provider}. Known: ${Object.keys(opts.providers).join(', ') || '(none)'}`,
        },
        400,
      );
    }

    // Resolve the API key. Two modes per provider:
    //  - server-managed: `opts.apiKeys[provider]` is set → the relay
    //    owns the key. A client that still sends a non-empty `apiKey`
    //    is rejected so a forgotten BYOK field can't silently leak to
    //    the wire.
    //  - BYOK (default): the client supplies `apiKey` in the body; a
    //    missing key is a 400.
    const keySource = opts.apiKeys?.[body.provider];
    if (keySource) {
      if (body.apiKey) {
        return json(
          { error: `apiKey not accepted: provider "${body.provider}" is server-managed` },
          400,
        );
      }
      try {
        body.apiKey =
          typeof keySource === 'string' ? keySource : await keySource({ req: body, request });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error('apiKey resolver failed', { provider: body.provider, error: message });
        return json({ error: `apiKey resolver failed: ${message}` }, 500);
      }
    } else if (!body.apiKey) {
      return json({ error: 'apiKey is required (or configure server-managed mode)' }, 400);
    }

    let jobId: string;
    try {
      const result = await engine.start(
        async function* () {
          // The signal passed to the producer ctx isn't surfaced via
          // NormalizedRequest — the engine's signal is internal. A
          // consumer who wants to cancel does it via the HTTP layer
          // (job delete) once that surface exists.
          for await (const evt of provider(body)) {
            yield evt;
          }
        },
        { data: { provider: body.provider, model: body.model } },
      );
      jobId = result.jobId;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error('job create failed', { error: message });
      return json({ error: `failed to create job: ${message}` }, 500);
    }
    logger.info('job started', { jobId, provider: body.provider, model: body.model });
    return json({ jobId }, 201);
  }

  async function handleStream(request: Request, ctx: StreamCtx): Promise<Response> {
    const { jobId } = ctx;
    if (!jobId) return new Response('missing job id', { status: 400 });

    // Existence check — return a real 404 status before committing to
    // a streaming Response.
    let initial;
    try {
      initial = await engine.get(jobId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error('stream store error', { jobId, error: message });
      return new Response(`job store error: ${message}`, { status: 502 });
    }
    if (!initial) {
      logger.info('stream 404', { jobId });
      return new Response('job not found', { status: 404 });
    }

    const from = ctx.from ?? readFromQuery(request);
    logger.info('stream connect', {
      jobId,
      from,
      jobStatus: initial.status,
      buffered: initial.events.length,
    });

    // The SSE encoding + guarded enqueue/close + reconnect contract live in
    // the generic transport; the relay just wires the subscription + abort.
    const subscribeAbort = new AbortController();
    request.signal?.addEventListener('abort', () => subscribeAbort.abort(), { once: true });

    return sseFromJob(engine.subscribe(jobId, { from, signal: subscribeAbort.signal }), {
      onCancel: () => {
        subscribeAbort.abort();
        logger.info('stream cancel', { jobId });
      },
    });
  }

  return {
    handleStart,
    handleStream,
    engine,
    stop: () => engine.stop(),
  };
}

function readFromQuery(request: Request): number {
  const url = new URL(request.url);
  const raw = url.searchParams.get('from');
  const n = Number.parseInt(raw ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
