import { installRuntimeServiceWorker } from './service-worker';

// This entry is compiled solely as the standalone runtime service worker.
const sw = self as unknown as ServiceWorkerGlobalScope;
installRuntimeServiceWorker();
// Updates remain waiting while old clients live. A new wire protocol must never
// take over their existing host/Worker graph through automatic activation.
sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});
