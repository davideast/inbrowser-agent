import { installPreviewWebSocket } from './preview-socket-client';

// Prefix mode: the bridge script injected into `/__preview__/<id>/<port>/`
// documents with `webSocket: true`, built to dist/preview-socket.js. It claims
// same-host sockets under a preview prefix and names the container and port.
installPreviewWebSocket((url) => {
  const match = url.pathname.match(/^\/__preview__\/([\w-]+)\/(\d+)(\/.*)$/);
  return match
    ? { fields: { containerId: match[1], port: Number(match[2]) }, path: match[3] }
    : undefined;
});
