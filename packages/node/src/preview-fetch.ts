import { PREVIEW_CLIENT_PATH } from './preview-client';
import type { CookieMirrorOp } from './preview-cookies';
import { HeadInjector } from './preview-inject';
import { rewritePreviewLocation } from './preview-location';
import { FrameSender, type PreviewFrame, WindowMeter, readFrame } from './preview-stream';
import { VERSION, errorRecord, fault, reviveError } from './protocol';
import type { ResourcePolicy } from './resource-policy';

// The service-worker end of one streamed preview exchange. It turns a fetch
// event into frames for the owning host page and the guest's frames into a
// Response whose body is a ReadableStream, so the browser sees the status and
// headers when the guest flushes them and each chunk as the guest writes it.
//
// Bounds held in this realm, per exchange:
//   - request: one chunk read from the browser (its size is the browser's
//     choice) plus at most `preview.requestWindowBytes` posted and not yet
//     credited by the guest;
//   - response: at most `preview.responseWindowBytes` received and not yet
//     taken by the browser's reader, plus the bounded prefix the head
//     injector may hold.

export interface PreviewTarget {
  containerId: string;
  port: number;
  /** Path and query as the guest sees them. */
  url: string;
  assetBaseURL: string;
  policy: ResourcePolicy;
  /** Posts to the host page that owns the container. */
  send(message: Record<string, unknown>, transfer: Transferable[]): void;
  /** False once that page is gone. */
  alive(): Promise<boolean>;
  /**
   * 'prefix' (default): the root worker serves `/__preview__/<id>/<port>/` on
   * the host origin. 'origin': a preview origin's own worker serves it, so a
   * root-relative `Location` is already correct and the response must be
   * embeddable cross-origin under the host's COEP.
   */
  mode?: 'prefix' | 'origin';
  /**
   * Origin mode: what the host's cookie jar needs about this request - its
   * SameSite context and the Cookie header page script's cookies would form.
   */
  cookieContext?: { crossSite: boolean; navigation: boolean; cookie?: string };
  /**
   * Origin mode: replays guest cookie changes into the page-visible store
   * before the page sees the response.
   */
  mirrorCookies?(ops: CookieMirrorOp[]): Promise<void>;
}

type Read = ReadableStreamReadResult<Uint8Array>;
/** The encodings the preview decodes (DecompressionStream), offered to the guest. */
export const ACCEPT_ENCODING = 'gzip, deflate';

function isEventStreamAccept(accept: string | null): boolean {
  return accept !== null && /\btext\/event-stream\b/i.test(accept);
}

/** The head injector as a stream stage, for a body decoded before injection. */
function injectStream(injector: HeadInjector): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      for (const part of injector.write(chunk)) controller.enqueue(part);
    },
    flush(controller) {
      for (const part of injector.end()) controller.enqueue(part);
    },
  });
}
const tick = () => new Promise<undefined>((resolve) => setTimeout(resolve, 0));
const ignore = () => {};

export async function previewFetch(request: Request, target: PreviewTarget): Promise<Response> {
  if (request.signal.aborted) return Response.error();
  const limits = target.policy.preview;
  const timers = target.policy.timers;
  const overflow = () => new Response('Request exceeds 1 MiB', { status: 413 });

  // Learn the shape of the request body without waiting for a slow one. A body
  // the browser already holds in memory (bytes, text, URL-encoded forms) is
  // delivered as one chunk whose reads settle before the next task, so its
  // length is known and the guest gets a Content-Length, as it would over a
  // socket. Anything still arriving after a task - a ReadableStream, a Blob, a
  // file-backed form - is dispatched at once as a body of unknown length.
  const reader = request.body?.getReader();
  let pending: Promise<Read> | undefined;
  let first: Uint8Array | undefined;
  let bodyLength: number | null = 0;
  if (reader) {
    pending = reader.read();
    const head = await Promise.race([pending, tick()]);
    if (!head) bodyLength = null;
    else if (head.done) pending = undefined;
    else {
      first = head.value;
      pending = reader.read();
      const tail = await Promise.race([pending, tick()]);
      bodyLength = tail?.done ? first.length : null;
      if (tail?.done) pending = undefined;
    }
  }
  if (request.signal.aborted) {
    pending?.catch(ignore);
    reader?.cancel().catch(ignore);
    return Response.error();
  }
  if (bodyLength !== null && bodyLength > limits.requestBodyBytes) {
    pending?.catch(ignore);
    reader?.cancel().catch(ignore);
    return overflow();
  }

  return new Promise<Response>((resolve) => {
    const channel = new MessageChannel();
    const port = channel.port1;
    const post = (frame: PreviewFrame, transfer: Transferable[] = []) =>
      port.postMessage({ version: VERSION, ...frame }, transfer);
    let closed = false;
    let responded = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let injector: HeadInjector | undefined;
    let headTimer: ReturnType<typeof setTimeout> | undefined;

    const uploads = new FrameSender(limits.requestWindowBytes, (bytes) => {
      post({ type: 'data', bytes }, [bytes.buffer]);
      awaitHead();
    });
    const inbound = new WindowMeter(limits.responseWindowBytes);
    const queue: Array<{ bytes: Uint8Array; credit: number }> = [];
    let wanted = false;
    let delivering = false;
    let ended = false;
    let received = 0;

    // The page that owns the container cannot tell the service worker that it
    // closed. Poll for it, and tell a live host that this reader still exists.
    const liveness = setInterval(
      () => {
        void target.alive().then((alive) => {
          if (closed) return;
          if (alive) post({ type: 'ping' });
          else
            fail(
              () => new Response('Container host unavailable', { status: 503 }),
              fault('EPIPE', 'Container host unavailable'),
            );
        }, ignore);
      },
      Math.max(1, Math.min(5000, Math.floor(timers.previewStreamIdleMs / 3))),
    );
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(headTimer);
      clearInterval(liveness);
      uploads.close();
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
      request.signal.removeEventListener('abort', aborted);
      // Whatever of the request is unread is no longer wanted by anyone.
      pending?.catch(ignore);
      reader?.cancel().catch(ignore);
    };
    /**
     * Ends the exchange early. Before the head the browser gets `response`;
     * after it the status is already delivered, so the body stream errors.
     */
    function fail(response: () => Response, error?: Error, notify = true) {
      if (closed) return;
      if (notify) post({ type: 'abort', ...(error ? { error: errorRecord(error) } : {}) });
      if (!responded) {
        responded = true;
        resolve(response());
      } else {
        try {
          controller?.error(error ?? new TypeError('Preview response aborted'));
        } catch {
          // The browser already cancelled or finished reading this stream.
        }
      }
      cleanup();
    }
    const invalid = (error?: Error) =>
      fail(() => new Response('Invalid guest reply', { status: 502 }), error);
    function aborted() {
      fail(() => Response.error());
    }
    /** Restarts the wait for a response head; request progress counts as activity. */
    function awaitHead() {
      clearTimeout(headTimer);
      if (responded || closed) return;
      headTimer = setTimeout(
        () => fail(() => new Response('Guest request timed out', { status: 504 })),
        timers.previewGuestRequestMs,
      );
    }

    const upload = async () => {
      let uploaded = 0;
      try {
        let chunk = first;
        for (;;) {
          if (chunk === undefined) {
            if (!pending || !reader) break;
            const read = await pending;
            if (closed) return;
            if (read.done) break;
            chunk = read.value;
            pending = reader.read();
          }
          uploaded += chunk.length;
          if (uploaded > limits.requestBodyBytes) {
            fail(
              overflow,
              fault('E2BIG', 'Preview request body exceeds its budget', {
                limit: limits.requestBodyBytes,
                actual: uploaded,
              }),
            );
            return;
          }
          // Resolves once the last frame of this chunk is inside the window,
          // so a guest that stops reading stops this loop reading the browser.
          const sending = chunk;
          await new Promise<void>((sent) => uploads.send(sending, sent));
          if (closed) return;
          chunk = undefined;
        }
        post({ type: 'end' });
        awaitHead();
      } catch {
        // The page aborted or errored its own request body.
        fail(() => Response.error());
      }
    };

    const credit = (bytes: number) => {
      if (closed || bytes < 1 || !inbound.remove(bytes)) return;
      post({ type: 'credit', bytes });
    };
    /** Hands queued chunks to the browser, one per outstanding read. */
    const deliver = () => {
      if (delivering || !controller) return;
      delivering = true;
      while (wanted && queue.length && !closed) {
        const item = queue.shift()!;
        wanted = false;
        // May call pull() again before returning, which sets `wanted`.
        controller.enqueue(item.bytes);
        credit(item.credit);
      }
      delivering = false;
      if (ended && !queue.length && !closed) {
        controller.close();
        cleanup();
      }
    };
    const receive = (bytes: Uint8Array) => {
      received += bytes.length;
      if (received > limits.responseBytes) {
        invalid(
          fault('E2BIG', 'Preview response exceeds its budget', {
            limit: limits.responseBytes,
            actual: received,
          }),
        );
        return;
      }
      // A response that cannot have a body: nothing reads it, so return the credit.
      if (!controller) return credit(bytes.length);
      const parts = injector ? injector.write(bytes) : [bytes];
      // Held by the injector, inside its own bound.
      if (!parts.length) return credit(bytes.length);
      parts.forEach((part, index) =>
        queue.push({ bytes: part, credit: index === parts.length - 1 ? bytes.length : 0 }),
      );
      deliver();
    };
    const head = (frame: Extract<PreviewFrame, { type: 'head' }>) => {
      clearTimeout(headTimer);
      if (frame.status < 200 || frame.status > 599) return invalid();
      try {
        const headers = new Headers();
        // The single place a guest head becomes a browser response: keep a
        // root-relative Location inside the preview prefix.
        const guestHeaders =
          target.mode === 'origin'
            ? frame.headers
            : rewritePreviewLocation(frame.headers, target.containerId, target.port);
        for (const [name, value] of Object.entries(guestHeaders)) {
          if (name === 'connection') continue;
          for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
        }
        headers.set(
          'Cross-Origin-Resource-Policy',
          target.mode === 'origin' ? 'cross-origin' : 'same-origin',
        );
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        const bodyless = [204, 205, 304].includes(frame.status) || request.method === 'HEAD';
        // Chromium does not decode a worker-built Response by its Content-Encoding,
        // so a body in an encoding this realm offered (ACCEPT_ENCODING) is decoded
        // here and the page gets identity bytes. Anything else passes as sent.
        const encoding = headers.get('content-encoding')?.trim().toLowerCase();
        const decode: CompressionFormat | undefined =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? 'gzip'
            : encoding === 'deflate'
              ? 'deflate'
              : undefined;
        if (decode) {
          headers.delete('content-encoding');
          headers.delete('content-length');
        }
        let inject: HeadInjector | undefined;
        if (
          !bodyless &&
          (frame.previewSocket === true || frame.previewClient === true) &&
          // Origin mode has the bridge on by default, so it injects only into
          // documents: an app's fetch() of an HTML fragment stays byte-exact.
          (target.mode !== 'origin' || request.mode === 'navigate') &&
          frame.status === 200 &&
          headers.get('content-type')?.split(';')[0].trim() === 'text/html'
        ) {
          const scripts: string[] = [];
          if (frame.previewSocket === true) {
            scripts.push(
              '<script src="' +
                new URL('preview-socket.js', target.assetBaseURL).href.replaceAll('&', '&amp;') +
                '"></script>',
            );
          }
          if (frame.previewClient === true) {
            const clientScriptUrl =
              target.mode === 'origin'
                ? new URL('preview-client.js', target.assetBaseURL).href
                : `/__preview__/${encodeURIComponent(target.containerId)}/${target.port}${PREVIEW_CLIENT_PATH}`;
            scripts.push(
              '<script src="' + clientScriptUrl.replaceAll('&', '&amp;') + '"></script>',
            );
          }
          inject = new HeadInjector(scripts.join(''));
          // The inserted script changes the length the guest declared.
          headers.delete('content-length');
          // Without decoding, inject as frames arrive; otherwise after decoding.
          if (!decode) injector = inject;
        }
        const raw = bodyless
          ? null
          : new ReadableStream<Uint8Array>(
              {
                start(stream) {
                  controller = stream;
                },
                pull() {
                  wanted = true;
                  deliver();
                },
                cancel() {
                  // The reader cancelled, the page aborted, or it navigated away.
                  fail(() => Response.error());
                },
              },
              // No queue of its own: a chunk leaves the window only when the
              // browser asks for one.
              { highWaterMark: 0 },
            );
        let body: ReadableStream<Uint8Array> | null = raw;
        if (raw && decode) {
          // DecompressionStream reads any BufferSource and yields Uint8Array chunks;
          // the frames it is given are Uint8Array, so the narrower pair type holds.
          body = raw.pipeThrough(
            new DecompressionStream(decode) as unknown as ReadableWritablePair<
              Uint8Array,
              Uint8Array
            >,
          );
          if (inject) body = body.pipeThrough(injectStream(inject));
        }
        const response = new Response(body, { status: frame.status, headers });
        responded = true;
        // The page reads document.cookie as of the response, as with a network
        // Set-Cookie; body frames queue inside the window meanwhile.
        if (frame.cookies && target.mirrorCookies)
          void target.mirrorCookies(frame.cookies).then(
            () => resolve(response),
            () => resolve(response),
          );
        else resolve(response);
      } catch {
        controller = undefined;
        invalid();
      }
    };

    port.onmessage = (event: MessageEvent<unknown>) => {
      const frame = readFrame(event.data);
      if (frame?.type === 'credit' && uploads.credit(frame.bytes)) return awaitHead();
      if (frame?.type === 'head' && !responded) return head(frame);
      if (frame?.type === 'data' && responded && !ended && inbound.add(frame.bytes.length))
        return receive(frame.bytes);
      if (frame?.type === 'end' && responded && !ended) {
        ended = true;
        if (injector) for (const part of injector.end()) queue.push({ bytes: part, credit: 0 });
        if (controller) deliver();
        else cleanup();
        return;
      }
      if (frame?.type === 'abort')
        return fail(
          () => Response.error(),
          frame.error ? reviveError({ ...frame.error }) : undefined,
          false,
        );
      invalid(fault('EPROTO', 'Invalid preview response frame'));
    };
    port.onmessageerror = () => invalid(fault('EPROTO', 'Invalid preview response frame'));
    request.signal.addEventListener('abort', aborted);

    target.send(
      {
        type: 'http',
        version: VERSION,
        containerId: target.containerId,
        port: target.port,
        method: request.method,
        url: target.url,
        headers: {
          ...Object.fromEntries(request.headers),
          // A fetch event does not show the Accept-Encoding of fetch() or
          // navigation requests, so offer the guest what the head handler
          // above can decode. A browser sends identity with Range (compressed
          // bytes do not line up with byte ranges) and with EventSource
          // (`Accept: text/event-stream`, so compression middleware never
          // buffers small SSE frames in a deflate window): forward the
          // request's own value when the event carries one (media elements
          // send `identity;q=1, *;q=0`), else identity.
          'accept-encoding':
            request.headers.has('range') || isEventStreamAccept(request.headers.get('accept'))
              ? (request.headers.get('accept-encoding') ?? 'identity')
              : ACCEPT_ENCODING,
          ...(target.cookieContext?.cookie ? { cookie: target.cookieContext.cookie } : {}),
        },
        bodyLength,
        ...(target.cookieContext
          ? {
              crossSite: target.cookieContext.crossSite,
              navigation: target.cookieContext.navigation,
            }
          : {}),
      },
      [channel.port2],
    );
    awaitHead();
    if (bodyLength !== 0) void upload();
  });
}
