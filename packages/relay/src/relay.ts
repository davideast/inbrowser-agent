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
  createJobEngine,
  type JobEngine,
  type JobStore,
  type Logger as ResumableLogger,
  type SweepSchedule,
} from '@inbrowser/resumable';
import type {
  InferenceEvent,
  InferenceProvider,
  NormalizedRequest,
} from './types';
import { encodeSseEvent, SSE_DONE_LINE, SSE_STREAM_OPEN } from './sse';

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
    if (!body || typeof body !== 'object' || !body.provider || !body.apiKey) {
      return json({ error: 'provider and apiKey are required' }, 400);
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

  async function handleStream(
    request: Request,
    ctx: StreamCtx,
  ): Promise<Response> {
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

    const subscribeAbort = new AbortController();
    request.signal?.addEventListener(
      'abort',
      () => subscribeAbort.abort(),
      { once: true },
    );

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(SSE_STREAM_OPEN));
        let lastSeq = -1;
        try {
          for await (const evt of engine.subscribe(jobId, {
            from,
            signal: subscribeAbort.signal,
          })) {
            if (evt.kind === 'event') {
              controller.enqueue(encoder.encode(encodeSseEvent(evt.value)));
              lastSeq = evt.seq;
            } else if (evt.kind === 'terminal') {
              controller.enqueue(encoder.encode(SSE_DONE_LINE));
              logger.info('stream done', {
                jobId,
                delivered: lastSeq + 1,
                status: evt.status,
              });
              controller.close();
              return;
            }
          }
          // Subscribe ended without a terminal marker — the underlying
          // store's watch dropped. Close WITHOUT `[DONE]` so the
          // client reconnects from `lastSeq + 1`.
          logger.info('stream reopen needed', {
            jobId,
            delivered: lastSeq + 1,
          });
          controller.close();
        } catch (e) {
          if (subscribeAbort.signal.aborted) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
          logger.error('stream error', {
            jobId,
            delivered: lastSeq + 1,
            error: e instanceof Error ? e.message : String(e),
          });
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        subscribeAbort.abort();
        logger.info('stream cancel', { jobId });
      },
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
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
