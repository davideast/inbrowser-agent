import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type HarnessRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface HarnessServerOptions {
  readonly hostPort?: number;
  readonly framePort?: number;
  readonly frameTitle?: string;
  readonly frameBodyHtml?: string;
  readonly hostRoutes?: Readonly<Record<string, HarnessRouteHandler>>;
  readonly frameRoutes?: Readonly<Record<string, HarnessRouteHandler>>;
}

export interface HarnessServer {
  readonly hostOrigin: string;
  readonly frameOrigin: string;
  readonly hostPort: number;
  readonly framePort: number;
  close(): Promise<void>;
}

const distDir = path.resolve('dist');

function escapeInlineScript(source: string): string {
  return source.replaceAll('</script', '<\\/script');
}

export function renderPreloadedHtmlDocument(options: {
  readonly title: string;
  readonly bodyHtml: string;
  readonly preloadSource?: string;
}): string {
  const preloadTag =
    options.preloadSource === undefined
      ? ''
      : `<script>${escapeInlineScript(options.preloadSource)}</script>`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${options.title}</title>`,
    preloadTag,
    '</head>',
    `<body>${options.bodyHtml}</body>`,
    '</html>',
  ].join('');
}

export async function loadPreloadSource(): Promise<string> {
  const preloadUrl = pathToFileURL(path.join(distDir, 'preload.js')).href;
  const mod: unknown = await import(preloadUrl);
  if (
    typeof mod !== 'object' ||
    mod === null ||
    !('DRIVER_PRELOAD_SOURCE' in mod) ||
    typeof mod.DRIVER_PRELOAD_SOURCE !== 'string'
  ) {
    throw new Error('dist/preload.js did not export string DRIVER_PRELOAD_SOURCE');
  }
  return mod.DRIVER_PRELOAD_SOURCE;
}

async function serveDistAsset(fileName: string, res: ServerResponse): Promise<void> {
  try {
    const content = await readFile(path.join(distDir, fileName), 'utf8');
    const contentType = fileName.endsWith('.map')
      ? 'application/json; charset=utf-8'
      : 'text/javascript; charset=utf-8';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Asset not found: ${fileName}`);
  }
}

function listenServer(server: Server, port: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const onListening = (): void => {
      server.off('error', reject);
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Expected TCP AddressInfo from HTTP server'));
        return;
      }
      resolve(addr.port);
    };
    if (host !== undefined) {
      server.listen(port, host, onListening);
    } else {
      server.listen(port, onListening);
    }
  });
}

function trackSockets(server: Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });
  return sockets;
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.closeIdleConnections();
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close(() => {
      resolve();
    });
  });
}

export async function startHarnessServer(
  options: HarnessServerOptions = {},
): Promise<HarnessServer> {
  const defaultHostPort = Number(process.env['DRIVER_TEST_PORT'] ?? '4700');
  const requestedHostPort = options.hostPort ?? defaultHostPort;
  const requestedFramePort =
    options.framePort ??
    (options.hostPort !== undefined
      ? options.hostPort === 0
        ? 0
        : options.hostPort + 1
      : Number(process.env['DRIVER_FRAME_PORT'] ?? String(defaultHostPort + 1)));

  const preloadSource = await loadPreloadSource();
  const frameTitle = options.frameTitle ?? 'Timeline Player Preview';
  const frameBodyHtml =
    options.frameBodyHtml ??
    '<main aria-label="player"><button type="button">Play</button><ul aria-label="items"><li>Track 1</li></ul></main>';

  const hostServer = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const customRoute = options.hostRoutes?.[pathname];
    if (customRoute !== undefined) {
      await customRoute(req, res);
      return;
    }

    if (pathname === '/driver/index.js') {
      await serveDistAsset('index.js', res);
      return;
    }
    if (pathname === '/driver/index.js.map') {
      await serveDistAsset('index.js.map', res);
      return;
    }
    if (pathname === '/driver/tools.js') {
      await serveDistAsset('tools.js', res);
      return;
    }
    if (pathname === '/driver/tools.js.map') {
      await serveDistAsset('tools.js.map', res);
      return;
    }
    if (pathname === '/' || pathname === '/host') {
      const importMap = JSON.stringify({
        imports: {
          '@inbrowser/driver': '/driver/index.js',
          '@inbrowser/driver/tools': '/driver/tools.js',
        },
      });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Driver Host Workspace</title><script type="importmap">${importMap}</script></head><body><div id="workspace"></div></body></html>`,
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  const frameServer = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const customRoute = options.frameRoutes?.[pathname];
    if (customRoute !== undefined) {
      await customRoute(req, res);
      return;
    }

    if (pathname === '/' || pathname === '/frame') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        renderPreloadedHtmlDocument({
          title: frameTitle,
          bodyHtml: frameBodyHtml,
          preloadSource,
        }),
      );
      return;
    }

    if (pathname === '/frame-uninstrumented') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        renderPreloadedHtmlDocument({
          title: 'Uninstrumented Frame',
          bodyHtml: '<main><p>No preload injected</p></main>',
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Frame route not found');
  });

  const hostSockets = trackSockets(hostServer);
  const frameSockets = trackSockets(frameServer);

  let boundHostPort = 0;
  let boundFramePort = 0;
  try {
    boundHostPort = await listenServer(hostServer, requestedHostPort, '127.0.0.1');
    boundFramePort = await listenServer(frameServer, requestedFramePort);
  } catch (err) {
    await Promise.all([
      closeServer(hostServer, hostSockets),
      closeServer(frameServer, frameSockets),
    ]);
    throw err;
  }

  return {
    hostOrigin: `http://127.0.0.1:${boundHostPort}`,
    frameOrigin: `http://localhost:${boundFramePort}`,
    hostPort: boundHostPort,
    framePort: boundFramePort,
    async close(): Promise<void> {
      await Promise.all([
        closeServer(hostServer, hostSockets),
        closeServer(frameServer, frameSockets),
      ]);
    },
  };
}
