import {
  PREVIEW_BRIDGE_PATH,
  PREVIEW_WORKER_PATH,
  bridgeMessage,
  readBridgeMessage,
} from './preview-bridge-protocol';
import { record } from './protocol';

// The script of the hidden bridge document, inlined into
// dist/preview-origin/__inbrowser__/bridge.html at build time. It runs on a
// preview origin inside the host page's iframe. It registers the origin's
// service worker, waits for control, and passes ports between the host page
// and that worker. It talks only to its parent, and only at the host origin
// the host named in the bridge URL, so a port is never posted to anyone else.

const hostOrigin = (() => {
  const value = new URLSearchParams(location.search).get('host');
  try {
    return value && new URL(value).origin === value ? value : undefined;
  } catch {
    return undefined;
  }
})();

const toHost = (message: Record<string, unknown>) => {
  if (hostOrigin) parent.postMessage(message, hostOrigin);
};

let registration: ServiceWorkerRegistration | undefined;

// Whether a document on this origin, framed by the host page, can use cookies:
// not when the host is cross-site and the browser treats the frame as a third
// party. The preview document is framed the same way, so the preview worker
// mirrors guest cookies into the page-visible store only when this is true.
const PROBE = '__inbrowser_cookie_probe';
const documentCookies = (() => {
  try {
    document.cookie = PROBE + '=1; path=' + PREVIEW_BRIDGE_PATH;
    const works = document.cookie.split('; ').includes(PROBE + '=1');
    document.cookie = PROBE + '=; path=' + PREVIEW_BRIDGE_PATH + '; max-age=0';
    return works;
  } catch {
    return false;
  }
})();

/** Removes the cookies the preview worker mirrored, when this document can reach them. */
async function clearCookies(): Promise<void> {
  if (!documentCookies || !('cookieStore' in window)) return;
  const store = window.cookieStore;
  // getAll() from this document lists the cookies whose path covers the bridge
  // path; the origin is per container, so others die with it.
  for (const cookie of await store.getAll()) {
    const path: unknown = Reflect.get(cookie, 'path');
    if (cookie.name)
      await store.delete({ name: cookie.name, path: typeof path === 'string' ? path : '/' });
  }
}

if (hostOrigin && parent !== window) {
  addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== parent || event.origin !== hostOrigin) return;
    const message = readBridgeMessage(event.data);
    if (!message) return;
    if (message.type === 'port' && event.ports[0])
      navigator.serviceWorker.controller?.postMessage(event.data, [event.ports[0]]);
    if (message.type === 'close')
      void clearCookies()
        .catch(() => undefined)
        .then(() => registration?.unregister() ?? false)
        .catch(() => false)
        .then(() => toHost(bridgeMessage('closed')));
  });
  void (async () => {
    try {
      registration = await navigator.serviceWorker.register(PREVIEW_WORKER_PATH, { scope: '/' });
      // The worker claims clients on activation; wait until it controls this document.
      while (!navigator.serviceWorker.controller)
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
        );
      // A restarted worker asks for a new port through this document.
      navigator.serviceWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (record(event.data) && readBridgeMessage(event.data)?.type === 'need-port')
          toHost(bridgeMessage('need-port', { documentCookies }));
      });
      navigator.serviceWorker.startMessages();
      toHost(bridgeMessage('need-port', { documentCookies }));
    } catch (error) {
      toHost(
        bridgeMessage('failed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  })();
}
