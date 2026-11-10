import { installPreviewWebSocket } from './preview-socket-client';

// Per-origin previews: the bridge script the preview worker serves at
// /__inbrowser__/preview-socket.js and injects into HTML documents. The page is
// on its own origin, so every socket to its own host is the app's, whatever the
// path (Next's /_next/hmr, Vite's /?token=…). The preview worker adds the
// container and port of its binding.
installPreviewWebSocket((url) => ({ fields: {}, path: url.pathname }));
