import {
  PREVIEW_BRIDGE_PATH,
  PREVIEW_SOCKET_PATH,
  PREVIEW_WORKER_PATH,
  bridgeMessage,
  readBridgeMessage,
} from './preview-bridge-protocol';
import { PREVIEW_CLIENT_PATH, buildPreviewClientBundle } from './preview-client';
import { type CookieMirrorOp, type CookieRequest, pageCookieHeader } from './preview-cookies';
import { previewFetch } from './preview-fetch';
import { VERSION, record } from './protocol';
import { DEFAULT_RESOURCE_POLICY, type ResourcePolicy, policyOrDefault } from './resource-policy';

// The service worker of one preview origin (design §5(a)). It is built to
// dist/preview-origin/__inbrowser_preview_sw.js and served by the embedder at
// the root of every preview origin. It cannot reach the host page itself:
// `clients` and BroadcastChannel are same-origin only. The bridge document
// hands it one end of a MessageChannel bound by the host to one container and
// port, and every same-origin request goes over that port with the ordinary
// streamed transport (`previewFetch`, frames, windows, budgets).
//
// The browser may stop this worker at any time, and the port dies with it. The
// next request finds the bridge among this origin's window clients and asks it
// for a new port; the host reissues one, up to its bound.

const sw = self as unknown as ServiceWorkerGlobalScope;

/** src/preview-origin-socket.ts, bundled; scripts/build.mjs defines it. */
declare const __PREVIEW_SOCKET_SOURCE__: string;

interface Host {
  channel: MessagePort;
  containerId: string;
  port: number;
  policy: ResourcePolicy;
}

let host: Host | undefined;
let arrived: ((value: Host | undefined) => void) | undefined;
let recovering: Promise<Host | undefined> | undefined;

const unavailable = () =>
  new Response('Preview host unavailable', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  });

function isBridge(source: unknown): source is WindowClient {
  if (!record(source) || typeof source.url !== 'string') return false;
  try {
    const url = new URL(source.url);
    return url.origin === sw.location.origin && url.pathname === PREVIEW_BRIDGE_PATH;
  } catch {
    return false;
  }
}

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

/**
 * A page socket (src/preview-origin-socket.ts) goes to the host on this
 * worker's bridge port, bound to its container and port; the host checks the
 * rest. Without a host the page's end hears an error at once.
 */
function relaySocket(data: Record<string, unknown>, socket: MessagePort) {
  return connected().then((target) => {
    if (!target) {
      socket.postMessage({ version: VERSION, type: 'error' });
      socket.close();
      return;
    }
    target.channel.postMessage(
      {
        ...data,
        type: 'socket',
        version: VERSION,
        containerId: target.containerId,
        port: target.port,
      },
      [socket],
    );
  });
}

function relayPreviewClient(data: Record<string, unknown>, clientPort: MessagePort) {
  return connected().then((target) => {
    if (!target) {
      clientPort.close();
      return;
    }
    target.channel.postMessage(
      {
        ...data,
        type: 'preview-client',
        version: VERSION,
        containerId: target.containerId,
        port: target.port,
      },
      [clientPort],
    );
  });
}

sw.addEventListener('message', (event) => {
  if (
    record(event.data) &&
    event.data.type === 'socket' &&
    event.data.version === VERSION &&
    event.ports[0]
  ) {
    event.waitUntil(relaySocket(event.data, event.ports[0]));
    return;
  }
  if (
    record(event.data) &&
    event.data.type === 'preview-client' &&
    event.data.version === VERSION &&
    event.ports[0]
  ) {
    event.waitUntil(relayPreviewClient(event.data, event.ports[0]));
    return;
  }
  const message = readBridgeMessage(event.data);
  const channel = event.ports[0];
  if (!message || message.type !== 'port' || !channel || !isBridge(event.source)) return;
  const { containerId, port } = message.data;
  if (
    !message.versionMatch ||
    typeof containerId !== 'string' ||
    typeof port !== 'number' ||
    !Number.isInteger(port)
  ) {
    channel.postMessage(bridgeMessage('refused'));
    channel.close();
    return;
  }
  host?.channel.close();
  const next: Host = {
    channel,
    containerId,
    port,
    policy: policyOrDefault(message.data.resources),
  };
  host = next;
  mirroring = message.data.cookieMirror === true && 'cookieStore' in sw;
  channel.onmessage = (incoming: MessageEvent<unknown>) => {
    // The host tore the container down: forget this port so later requests
    // answer 503 instead of waiting on a page that will never reply.
    if (readBridgeMessage(incoming.data)?.type === 'closed' && host === next) {
      host = undefined;
      channel.close();
    }
  };
  channel.postMessage(bridgeMessage('ready'));
  arrived?.(next);
});

/** The live host port, recovering one through the bridge when this worker restarted. */
function connected(): Promise<Host | undefined> {
  if (host) return Promise.resolve(host);
  recovering ??= (async () => {
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const bridges = clients.filter(isBridge);
    if (!bridges.length) return undefined;
    const wait = new Promise<Host | undefined>((resolve) => {
      const timer = setTimeout(
        () => resolve(undefined),
        DEFAULT_RESOURCE_POLICY.timers.previewDiscoverMs,
      );
      arrived = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
    for (const bridge of bridges) bridge.postMessage(bridgeMessage('need-port'));
    return wait;
  })().finally(() => {
    recovering = undefined;
    arrived = undefined;
  });
  return recovering;
}

// Cookie mirror (decision 4). The host's jar is the source of truth; script-visible
// guest cookies are replayed into this origin's store through the Cookie Store API
// so page script sees them in document.cookie, and cookies page script wrote are
// read back for each request. The bridge reports whether a framed document on this
// origin can use cookies at all (not when the host is cross-site and the frame is
// a third party); if not, or on the first Cookie Store failure, the mirror is off
// until the next port and the jar works alone.
const MIRROR_MS = 1000;
let mirroring = false;

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Cookie Store timed out')), MIRROR_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function mirrorCookies(ops: CookieMirrorOp[]): Promise<void> {
  for (const op of ops) {
    if (!mirroring) return;
    try {
      if (op.op === 'set')
        await bounded(
          sw.cookieStore.set({
            name: op.name,
            value: op.value,
            path: op.path,
            expires: op.expires,
            sameSite: op.sameSite,
          }),
        );
      else await bounded(sw.cookieStore.delete({ name: op.name, path: op.path }));
    } catch {
      mirroring = false;
    }
  }
}

/**
 * The Cookie header page script's cookies form for `request`, when the mirror
 * works. The worker's `getAll()` answers for its scope URL (`/`); Chromium 145
 * refuses a `url` option naming a request path ("URL must be within Service
 * Worker scope"). `pageCookieHeader` applies path and SameSite as the jar does.
 */
async function pageCookies(request: CookieRequest): Promise<string | undefined> {
  if (!mirroring) return;
  try {
    const cookies: readonly unknown[] = await bounded(sw.cookieStore.getAll());
    return pageCookieHeader(cookies, request);
  } catch {
    mirroring = false;
    return;
  }
}

/**
 * A navigation into the preview started by anything but this origin's own
 * documents is cross-site for SameSite. The fetch event does not name the
 * initiator: Chromium's `clientId` on a navigation is the navigated frame's
 * current document even when the host page set the frame's `src`. The referrer
 * does carry the initiator's origin under every policy but `no-referrer`; a
 * navigation without one counts as cross-site, the conservative reading.
 * Subresource requests reach this worker only from its own clients.
 */
function crossSite(request: Request): boolean {
  if (request.mode !== 'navigate') return false;
  try {
    return new URL(request.referrer).origin !== sw.location.origin;
  } catch {
    return true;
  }
}

/** True while the host page answers on the current port. */
function alive(): Promise<boolean> {
  const current = host;
  if (!current) return Promise.resolve(false);
  return new Promise((resolve) => {
    const reply = new MessageChannel();
    const timer = setTimeout(() => {
      reply.port1.close();
      resolve(false);
    }, current.policy.timers.previewStreamIdleMs);
    reply.port1.onmessage = () => {
      clearTimeout(timer);
      reply.port1.close();
      resolve(true);
    };
    current.channel.postMessage(bridgeMessage('alive'), [reply.port2]);
  });
}

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Other origins, and this origin's own bridge and worker files, are the network's.
  if (url.origin !== sw.location.origin) return;
  if (url.pathname === PREVIEW_BRIDGE_PATH || url.pathname === PREVIEW_WORKER_PATH) return;
  if (url.pathname === PREVIEW_SOCKET_PATH) {
    event.respondWith(
      new Response(__PREVIEW_SOCKET_SOURCE__, {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        },
      }),
    );
    return;
  }
  if (url.pathname === PREVIEW_CLIENT_PATH) {
    event.respondWith(
      (async () => {
        const target = await connected();
        if (!target) return unavailable();
        return new Promise<Response>((resolve) => {
          const reply = new MessageChannel();
          const timer = setTimeout(() => {
            reply.port1.close();
            resolve(
              new Response('Preview client host timed out', {
                status: 504,
                headers: {
                  'Content-Type': 'text/plain; charset=utf-8',
                  'Cross-Origin-Resource-Policy': 'cross-origin',
                  'Cross-Origin-Embedder-Policy': 'require-corp',
                },
              }),
            );
          }, target.policy.timers.previewModuleRequestMs);
          reply.port1.onmessage = (msg: MessageEvent<unknown>) => {
            clearTimeout(timer);
            reply.port1.close();
            const data = msg.data;
            if (!record(data) || typeof data.source !== 'string') {
              resolve(
                new Response('Preview client script unavailable', {
                  status: 404,
                  headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cross-Origin-Resource-Policy': 'cross-origin',
                    'Cross-Origin-Embedder-Policy': 'require-corp',
                  },
                }),
              );
              return;
            }
            resolve(
              new Response(buildPreviewClientBundle(data.source), {
                headers: {
                  'Content-Type': 'text/javascript; charset=utf-8',
                  'Cache-Control': 'no-store',
                  'Cross-Origin-Resource-Policy': 'cross-origin',
                  'Cross-Origin-Embedder-Policy': 'require-corp',
                },
              }),
            );
          };
          target.channel.postMessage(
            {
              type: 'client-script',
              version: VERSION,
              containerId: target.containerId,
              port: target.port,
            },
            [reply.port2],
          );
        });
      })(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      if (request.signal.aborted) return Response.error();
      const target = await connected();
      if (!target) return unavailable();
      if (request.signal.aborted) return Response.error();
      const context: CookieRequest = {
        path: url.pathname,
        crossSite: crossSite(request),
        navigation: request.mode === 'navigate',
        method: request.method,
      };
      const cookie = await pageCookies(context);
      if (request.signal.aborted) return Response.error();
      return previewFetch(request, {
        containerId: target.containerId,
        port: target.port,
        url: url.pathname + url.search,
        // The injected bridge script resolves against this: PREVIEW_SOCKET_PATH.
        assetBaseURL: sw.location.origin + '/__inbrowser__/',
        policy: target.policy,
        mode: 'origin',
        cookieContext: {
          crossSite: context.crossSite,
          navigation: context.navigation,
          ...(cookie ? { cookie } : {}),
        },
        mirrorCookies,
        send: (message, transfer) => target.channel.postMessage(message, transfer),
        alive,
      });
    })(),
  );
});
