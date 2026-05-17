import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * Express adapter — shims `(req, res)` ⇄ Web `Request`/`Response` so
 * the relay's Web-standard handlers can run unchanged inside an
 * Express app (or any Express-compatible server: Cloud Functions
 * Gen 2 via `@google-cloud/functions-framework`, etc.).
 *
 * Critical correctness detail: `res.flushHeaders()` runs BEFORE we
 * pipe the body. Without it, Node holds the response headers until
 * the first body byte; the relay emits a leading `: stream-open\n\n`
 * comment specifically to BE that first byte for upstream proxies
 * (Cloud Run, Hosting), but the Node layer itself also benefits from
 * the explicit flush so the client's `fetch()` sees `200 OK` before
 * the slow first model token.
 *
 * Wire-up:
 *
 *   import express from 'express';
 *   import { createRelay } from '@inbrowser/relay';
 *   import { createExpressHandlers } from '@inbrowser/relay/adapters/express';
 *
 *   const relay = createRelay({ store, providers });
 *   const { start, stream } = createExpressHandlers(relay);
 *
 *   const app = express();
 *   app.use(express.json());
 *   app.post('/api/inference/job',           start);
 *   app.get('/api/inference/job/:id/stream', stream);
 */
import { Readable } from 'node:stream';
import type { Relay } from '../relay';

/**
 * Minimal request shape — matches both `express.Request` and
 * `functions-framework`'s augmented `IncomingMessage`. Declared
 * narrowly so we don't take a hard dependency on either's types.
 */
type ExLikeReq = IncomingMessage & {
  body?: unknown;
  rawBody?: Buffer;
  params?: Record<string, string | undefined>;
};

type ExLikeRes = ServerResponse & {
  flushHeaders?: () => void;
};

type ExLikeHandler = (req: ExLikeReq, res: ExLikeRes) => Promise<void> | void;

export interface ExpressHandlers {
  start: ExLikeHandler;
  stream: ExLikeHandler;
}

export interface CreateExpressHandlersOpts {
  /**
   * Name of the express route parameter holding the job id. Default
   * `id`, matching `/api/inference/job/:id/stream`.
   */
  jobIdParam?: string;
  /**
   * When true, the adapter sets permissive CORS headers on every
   * response (and handles `OPTIONS` preflights). Useful when the
   * client is cross-origin — e.g. talking to a Cloud Run function
   * directly, bypassing a Firebase Hosting rewrite that would buffer
   * the SSE stream end-to-end (proven in PR #327). Default false.
   */
  cors?: boolean;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '3600',
};

export function createExpressHandlers(
  relay: Relay,
  opts: CreateExpressHandlersOpts = {},
): ExpressHandlers {
  const jobIdParam = opts.jobIdParam ?? 'id';
  const cors = opts.cors ?? false;

  function applyCors(res: ExLikeRes): void {
    if (!cors) return;
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  }

  async function dispatch(
    req: ExLikeReq,
    res: ExLikeRes,
    build: () => Promise<Response>,
  ): Promise<void> {
    if (cors && (req.method ?? '').toUpperCase() === 'OPTIONS') {
      res.statusCode = 204;
      applyCors(res);
      res.end();
      return;
    }
    try {
      const response = await build();
      res.statusCode = response.status;
      applyCors(res);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (!response.body) {
        res.end(await response.text());
        return;
      }
      // Flush status + headers NOW. The SSE body's first byte is the
      // ": stream-open\n\n" comment that defeats upstream-proxy header
      // buffering; this flush makes Node itself send headers eagerly
      // so the client's fetch() doesn't sit on "no response yet."
      res.flushHeaders?.();
      Readable.fromWeb(
        response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
      ).pipe(res);
    } catch (e) {
      res.statusCode = 500;
      applyCors(res);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  return {
    start: (req, res) => dispatch(req, res, () => relay.handleStart(toRequest(req))),
    stream: (req, res) => {
      const jobId = req.params?.[jobIdParam] ?? '';
      return dispatch(req, res, () => relay.handleStream(toRequest(req), { jobId }));
    },
  };
}

/**
 * Build a Web `Request` from an Express/Functions-Framework `(req)`.
 * Functions Framework pre-parses JSON into `req.body`; Express does
 * the same with `express.json()`. We re-serialize because the relay's
 * `handleStart` reads `request.json()` from the Web stream.
 */
function toRequest(req: ExLikeReq): Request {
  const host = req.headers.host ?? 'localhost';
  const proto =
    typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto']
      : 'http';
  const url = new URL(req.url ?? '/', `${proto}://${host}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, String(value));
    }
  }
  // Hand the relay a body it can JSON-parse. For GETs we omit body.
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.rawBody) {
      // bun-types and lib.dom disagree about which TypedArray variants
      // satisfy BodyInit; the runtime accepts Buffer just fine, so we
      // cast through `unknown` to bypass the cosmetic type mismatch.
      init.body = req.rawBody as unknown as BodyInit;
    } else if (req.body !== undefined) {
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }
  }
  return new Request(url, init);
}
