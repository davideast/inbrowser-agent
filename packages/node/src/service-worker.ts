import { assetLocation } from './asset-location';
import { PREVIEW_CLIENT_PATH, buildPreviewClientBundle } from './preview-client';
import { previewFetch } from './preview-fetch';
import { VERSION, record } from './protocol';
import { DEFAULT_RESOURCE_POLICY, type ResourcePolicy, policyOrDefault } from './resource-policy';
let installed = false;

/** Host fetch handlers must leave these same-origin routes to the runtime. */
export function isRuntimeRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.origin === self.location.origin &&
    /^\/__(preview|modules)__\/([\w-]+)\/(\d+)(\/.*)$/.test(url.pathname)
  );
}

/** Install routing only; the host owns installation, activation and client claim. */
export function installRuntimeServiceWorker(): void {
  if (installed) return;
  installed = true;
  // This helper is invoked solely inside a ServiceWorkerGlobalScope.
  const sw = self as unknown as ServiceWorkerGlobalScope;
  // One service worker serves several containers, so each container's policy
  // lives in its owner record rather than in a realm-wide accessor.
  const owners = new Map<
    string,
    { clientId: string; assetBaseURL: string; policy: ResourcePolicy }
  >();
  const assetBase = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return;
    try {
      return assetLocation(value, sw.location.href).href;
    } catch {
      return;
    }
  };
  const resolveOwner = async (containerId: string) => {
    let owner = owners.get(containerId);
    // A service worker may restart between requests. Recover ownership from live hosts.
    if (!owner) {
      const clients = await sw.clients.matchAll({ type: 'window' });
      await Promise.all(
        clients
          .filter((c) => !new URL(c.url).pathname.startsWith('/__preview__/'))
          .map(
            (client) =>
              new Promise<void>((resolve) => {
                const channel = new MessageChannel();
                const timer = setTimeout(() => {
                  channel.port1.close();
                  resolve();
                }, DEFAULT_RESOURCE_POLICY.timers.previewDiscoverMs);
                channel.port1.onmessage = (discoverEvent) => {
                  const reply: unknown = discoverEvent.data;
                  const assetBaseURL = record(reply) ? assetBase(reply.assetBaseURL) : undefined;
                  if (
                    record(reply) &&
                    reply.version === VERSION &&
                    reply.containerId === containerId &&
                    assetBaseURL !== undefined
                  ) {
                    owner = {
                      clientId: client.id,
                      assetBaseURL,
                      policy: policyOrDefault(reply.resources),
                    };
                    owners.set(containerId, owner);
                  }
                  clearTimeout(timer);
                  channel.port1.close();
                  resolve();
                };
                client.postMessage({ type: 'discover', version: VERSION, containerId }, [
                  channel.port2,
                ]);
              }),
          ),
      );
    }
    const client = owner ? await sw.clients.get(owner.clientId) : undefined;
    return client && owner ? { owner, client } : undefined;
  };
  sw.addEventListener('message', (event) => {
    if (
      !record(event.data) ||
      typeof event.data.containerId !== 'string' ||
      !event.source ||
      !('id' in event.source)
    )
      return;
    if (event.data.type === 'register') {
      const assetBaseURL = assetBase(event.data.assetBaseURL);
      const ok = event.data.version === VERSION && assetBaseURL !== undefined;
      if (ok)
        owners.set(event.data.containerId, {
          clientId: event.source.id,
          assetBaseURL,
          policy: policyOrDefault(event.data.resources),
        });
      event.ports[0]?.postMessage({
        type: 'registered',
        version: VERSION,
        containerId: event.data.containerId,
        ok,
      });
      event.ports[0]?.close();
    }
    if (
      event.data.type === 'unregister' &&
      event.data.version === VERSION &&
      owners.get(event.data.containerId)?.clientId === event.source.id
    )
      owners.delete(event.data.containerId);
    if (event.data.type === 'socket' && event.data.version === VERSION && event.ports[0]) {
      const message = event.data;
      const containerId = event.data.containerId;
      const port = event.ports[0];
      event.waitUntil(
        (async () => {
          const resolved = await resolveOwner(containerId);
          if (resolved) resolved.client.postMessage(message, [port]);
          else {
            port.postMessage({ version: VERSION, type: 'error' });
            port.close();
          }
        })(),
      );
    }
    if (event.data.type === 'preview-client' && event.data.version === VERSION && event.ports[0]) {
      const message = event.data;
      const containerId = event.data.containerId;
      const port = event.ports[0];
      event.waitUntil(
        (async () => {
          const resolved = await resolveOwner(containerId);
          if (resolved) resolved.client.postMessage(message, [port]);
          else port.close();
        })(),
      );
    }
  });
  sw.addEventListener('fetch', (event) => {
    const request = event.request;
    if (!isRuntimeRequest(request)) return;
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/__(preview|modules)__\/([\w-]+)\/(\d+)(\/.*)$/);
    if (!match) return;
    event.respondWith(
      (async () => {
        const [, route, containerId, port, pathname] = match;
        const resolved = await resolveOwner(containerId);
        if (!resolved) return new Response('Container host unavailable', { status: 503 });
        const { owner, client } = resolved;
        const assetBaseURL = owner.assetBaseURL;
        const limits = owner.policy.preview;
        const deadlines = owner.policy.timers;
        if (route === 'preview' && pathname === PREVIEW_CLIENT_PATH) {
          return new Promise<Response>((resolve) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => {
              channel.port1.close();
              resolve(new Response('Preview client host timed out', { status: 504 }));
            }, deadlines.previewModuleRequestMs);
            channel.port1.onmessage = (replyEvent: MessageEvent<unknown>) => {
              clearTimeout(timer);
              channel.port1.close();
              const reply = replyEvent.data;
              if (!record(reply) || typeof reply.source !== 'string') {
                resolve(new Response('Preview client script unavailable', { status: 404 }));
                return;
              }
              resolve(
                new Response(
                  buildPreviewClientBundle(reply.source, { containerId, port: Number(port) }),
                  {
                    headers: {
                      'Content-Type': 'text/javascript; charset=utf-8',
                      'Cache-Control': 'no-store',
                      'Cross-Origin-Resource-Policy': 'same-origin',
                    },
                  },
                ),
              );
            };
            client.postMessage(
              {
                type: 'client-script',
                version: VERSION,
                containerId,
                port: Number(port),
              },
              [channel.port2],
            );
          });
        }
        if (route === 'modules') {
          return new Promise<Response>((resolve) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => {
              channel.port1.close();
              resolve(new Response('Module host timed out', { status: 504 }));
            }, deadlines.previewModuleRequestMs);
            channel.port1.onmessage = (event: MessageEvent<unknown>) => {
              clearTimeout(timer);
              channel.port1.close();
              const reply = event.data;
              if (
                !record(reply) ||
                typeof reply.source !== 'string' ||
                new TextEncoder().encode(reply.source).length > limits.moduleSourceBytes
              ) {
                resolve(new Response('Module unavailable', { status: 404 }));
                return;
              }
              resolve(
                new Response(reply.source, {
                  headers: {
                    'Content-Type': 'text/javascript',
                    'Cache-Control': 'no-store',
                    'Cross-Origin-Resource-Policy': 'same-origin',
                  },
                }),
              );
            };
            client.postMessage(
              {
                type: 'module',
                version: VERSION,
                containerId,
                pid: Number(port),
                url: url.pathname,
              },
              [channel.port2],
            );
          });
        }
        const clientId = owner.clientId;
        return previewFetch(request, {
          containerId,
          port: Number(port),
          url: pathname + url.search,
          assetBaseURL,
          policy: owner.policy,
          send: (message, transfer) => client.postMessage(message, transfer),
          alive: async () => (await sw.clients.get(clientId)) !== undefined,
        });
      })(),
    );
  });
}
