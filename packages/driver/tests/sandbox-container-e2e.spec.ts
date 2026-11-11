import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http, { type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const driverDistDir = path.join(pkgRoot, 'dist');

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const WORKER_CSP = "worker-src 'self' blob:; object-src 'none'; base-uri 'none'";

function resolveNodeRuntimeDistDir(): string {
  const envDir = process.env['INBROWSER_NODE_DIST_DIR'];
  const candidates = [
    ...(envDir !== undefined && envDir.length > 0 ? [path.resolve(envDir)] : []),
    path.resolve(pkgRoot, '..', 'node', 'dist'),
  ];
  for (const dir of candidates) {
    if (
      existsSync(path.join(dir, 'runtime.js')) &&
      existsSync(path.join(dir, 'preview-origin', '__inbrowser_preview_sw.js'))
    ) {
      return dir;
    }
  }
  throw new Error(
    'Could not locate built @inbrowser/node dist directory; run bun run build:node or set INBROWSER_NODE_DIST_DIR.',
  );
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

function listenServer(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Expected TCP AddressInfo from HTTP server'));
        return;
      }
      resolve(addr.port);
    });
  });
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

async function serveStaticFile(
  rootDir: string,
  relPath: string,
  res: ServerResponse,
  status = 200,
): Promise<void> {
  const resolved = path.resolve(rootDir, `.${relPath.startsWith('/') ? relPath : `/${relPath}`}`);
  if (!resolved.startsWith(`${rootDir}${path.sep}`)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  try {
    const bytes = await readFile(resolved);
    const contentType = MIME_BY_EXT[path.extname(resolved)] ?? 'application/octet-stream';
    res.writeHead(status, { 'Content-Type': contentType }).end(bytes);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

interface ThreeOriginHarness {
  readonly hostOrigin: string;
  readonly sandboxOrigin: string;
  readonly previewPort: number;
  close(): Promise<void>;
}

async function startThreeOriginSandboxHarness(
  inbrowserNodeDist: string,
): Promise<ThreeOriginHarness> {
  const basePort = Number(process.env['DRIVER_TEST_PORT'] ?? '4700');
  const requestedHostPort = basePort + 1;
  const requestedSandboxPort = basePort + 2;
  const requestedPreviewPort = basePort + 3;

  const previewOriginRoot = path.join(inbrowserNodeDist, 'preview-origin');

  let boundHostPort = requestedHostPort;
  let boundSandboxPort = requestedSandboxPort;
  let boundPreviewPort = requestedPreviewPort;

  // Origin 1: Embedder Host (`http://127.0.0.1:<hostPort>`)
  const hostServer = http.createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-store');

    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (pathname === '/' || pathname === '/host') {
      const importMap = JSON.stringify({
        imports: {
          '@inbrowser/driver': '/driver/index.js',
          '@inbrowser/driver/tools': '/driver/tools.js',
          '@inbrowser/node': '/node/runtime.js',
        },
      });
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(
          [
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="utf-8">',
            '<title>Embedder Host</title>',
            `<script type="importmap">${importMap}</script>`,
            '</head>',
            '<body><div id="workspace"></div></body>',
            '</html>',
          ].join(''),
        );
      return;
    }

    if (pathname.startsWith('/driver/')) {
      await serveStaticFile(driverDistDir, pathname.slice('/driver'.length), res);
      return;
    }
    if (pathname.startsWith('/node/')) {
      await serveStaticFile(inbrowserNodeDist, pathname.slice('/node'.length), res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  });

  // Origin 2: Sandbox Host (`http://sandbox.localhost:<sandboxPort>`)
  const sandboxServer = http.createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'no-store');

    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (pathname === '/sandbox.html' || pathname === '/__inbrowser_sandbox__.html') {
      const allowedParents = [
        `http://127.0.0.1:${String(boundHostPort)}`,
        `http://localhost:${String(boundHostPort)}`,
      ];
      const sandboxHtml = [
        '<!doctype html>',
        '<meta charset="utf-8" />',
        '<script type="module">',
        "  import { installSandboxHost } from '/runtime.js';",
        '  installSandboxHost({',
        `    allowedParentOrigins: ${JSON.stringify(allowedParents)},`,
        '    bootOptions: {',
        '      preview: {',
        `        origin: 'http://{container}-{port}.localhost:${String(boundPreviewPort)}',`,
        "        embedderPolicy: 'require-corp',",
        '      },',
        '    },',
        '  });',
        '</script>',
      ].join('\n');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(sandboxHtml);
      return;
    }

    if (pathname === '/kernel.js' || pathname === '/process.js') {
      res.setHeader('Content-Security-Policy', WORKER_CSP);
    }

    await serveStaticFile(inbrowserNodeDist, pathname, res);
  });

  // Origin 3: Preview Origin (`http://<container>-<port>.localhost:<previewPort>`)
  const previewServer = http.createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'no-store');

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/__inbrowser_preview_sw.js') {
      await serveStaticFile(previewOriginRoot, '/__inbrowser_preview_sw.js', res, 200);
      return;
    }
    if (pathname === '/__inbrowser__/bridge.html') {
      await serveStaticFile(previewOriginRoot, '/__inbrowser__/bridge.html', res, 200);
      return;
    }
    await serveStaticFile(previewOriginRoot, '/__inbrowser__/unavailable.html', res, 503);
  });

  const hostSockets = trackSockets(hostServer);
  const sandboxSockets = trackSockets(sandboxServer);
  const previewSockets = trackSockets(previewServer);

  try {
    boundHostPort = await listenServer(hostServer, requestedHostPort, '127.0.0.1');
    boundSandboxPort = await listenServer(sandboxServer, requestedSandboxPort, '127.0.0.1');
    boundPreviewPort = await listenServer(previewServer, requestedPreviewPort, '127.0.0.1');
  } catch (err) {
    await Promise.all([
      closeServer(hostServer, hostSockets),
      closeServer(sandboxServer, sandboxSockets),
      closeServer(previewServer, previewSockets),
    ]);
    throw err;
  }

  return {
    hostOrigin: `http://127.0.0.1:${String(boundHostPort)}`,
    sandboxOrigin: `http://sandbox.localhost:${String(boundSandboxPort)}`,
    previewPort: boundPreviewPort,
    async close(): Promise<void> {
      await Promise.all([
        closeServer(hostServer, hostSockets),
        closeServer(sandboxServer, sandboxSockets),
        closeServer(previewServer, previewSockets),
      ]);
    },
  };
}

const GUEST_MULTI_PAGE_SERVER_CJS = `
const http = require('node:http');

const indexPageHtml = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Synth Inspector</title></head>',
  '<body>',
  '  <main aria-label="synth-rack">',
  '    <h1>Synth Inspector</h1>',
  '    <label for="patch-name">Patch Name</label>',
  '    <input id="patch-name" type="text" value="Init Patch" />',
  '    <label for="wave-mode">Wave Mode</label>',
  '    <select id="wave-mode">',
  '      <option value="sine">Sine</option>',
  '      <option value="saw">Sawtooth</option>',
  '    </select>',
  '    <button id="apply-btn" type="button">Apply Patch</button>',
  '    <button id="diag-btn" type="button">Trigger Console Error</button>',
  '    <output id="apply-status">Pending</output>',
  '    <canvas id="scope-canvas" aria-label="Waveform Scope" width="220" height="80"></canvas>',
  '    <nav aria-label="views">',
  '      <a id="page2-link" href="/page2">Open Arrangement Page</a>',
  '    </nav>',
  '  </main>',
  '  <script>',
  '    const canvas = document.getElementById("scope-canvas");',
  '    const ctx = canvas.getContext("2d");',
  '    let tick = 0;',
  '    function paintScope(color) {',
  '      if (!ctx) return;',
  '      tick += 1;',
  '      ctx.fillStyle = "#0f172a";',
  '      ctx.fillRect(0, 0, canvas.width, canvas.height);',
  '      ctx.fillStyle = color;',
  '      ctx.fillRect(12 + (tick % 40), 16, 120, 44);',
  '    }',
  '    paintScope("#38bdf8");',
  '    document.getElementById("apply-btn").addEventListener("click", () => {',
  '      const name = document.getElementById("patch-name").value;',
  '      const wave = document.getElementById("wave-mode").value;',
  '      document.getElementById("apply-status").textContent = "Applied: " + name + " [" + wave + "]";',
  '      paintScope("#22c55e");',
  '    });',
  '    document.getElementById("diag-btn").addEventListener("click", () => {',
  '      console.error("guest-synth-overdrive-warning");',
  '    });',
  '  <\\/script>',
  '</body>',
  '</html>',
].join('\\n');

const secondPageHtml = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Arrangement View</title></head>',
  '<body>',
  '  <main aria-label="arrangement">',
  '    <h1>Arrangement View</h1>',
  '    <button id="bounce-btn" type="button">Bounce Arrangement</button>',
  '    <output id="bounce-status">Ready to bounce</output>',
  '  </main>',
  '  <script>',
  '    document.getElementById("bounce-btn").addEventListener("click", () => {',
  '      document.getElementById("bounce-status").textContent = "Bounced 8 bars";',
  '    });',
  '  <\\/script>',
  '</body>',
  '</html>',
].join('\\n');

http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexPageHtml);
    return;
  }
  if (pathname === '/page2') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(secondPageHtml);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}).listen(3000, () => {
  console.log('GUEST_SERVER_LISTENING');
});
`;

interface SandboxRuntimeModule {
  readonly SandboxContainer: {
    boot(url: string): Promise<{
      readonly id: string;
      readonly origin: string;
      mount(files: Record<string, string>): Promise<void>;
      spawn(
        command: string,
        argv: string[],
      ): Promise<{
        readonly stdoutText: string;
        readonly stderrText: string;
      }>;
      preview(
        port: number,
        options?: {
          readonly requestPath?: 'strip' | 'preserve';
          readonly webSocket?: boolean;
          readonly clientScript?: string;
        },
      ): Promise<string>;
      onPreviewClient(port: number, listener: (clientPort: MessagePort) => void): () => void;
      dispose(): Promise<void>;
    }>;
  };
}

test.describe('3-origin SandboxContainer E2E', () => {
  test('drives an isolated 3-origin SandboxContainer guest HTTP app end-to-end through connectContainerPreview and createDriverTools across observe, batched act, silent WebP/WebM capture, cross-origin full-page navigation, and leak-free disposal', async ({
    page,
  }) => {
    const inbrowserNodeDist = resolveNodeRuntimeDistDir();
    const harness = await startThreeOriginSandboxHarness(inbrowserNodeDist);

    const trackedWorkers = new Set<unknown>();
    page.on('worker', (worker) => {
      trackedWorkers.add(worker);
      worker.on('close', () => {
        trackedWorkers.delete(worker);
      });
    });

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const e2eResult = await page.evaluate(
        async ({ sandboxOrigin, serverSource }) => {
          const { connectContainerPreview, isActResult, isCaptureResult, isObservationSnapshot } =
            await import('@inbrowser/driver');
          const { createDriverTools } = await import('@inbrowser/driver/tools');

          const runtimeSpecifier = '@inbrowser/node';
          // Invariant: importmap maps '@inbrowser/node' to built @inbrowser/node dist/runtime.js
          const { SandboxContainer } = (await import(runtimeSpecifier)) as SandboxRuntimeModule;

          const workspace = document.getElementById('workspace');
          if (!workspace) {
            throw new Error('Missing #workspace container');
          }

          const framesBeforeBoot = document.querySelectorAll('iframe').length;
          const sandbox = await SandboxContainer.boot(`${sandboxOrigin}/sandbox.html`);

          try {
            await sandbox.mount({ '/server.cjs': serverSource });
            const serverProc = await sandbox.spawn('node', ['/server.cjs']);

            const listenDeadline = Date.now() + 8_000;
            while (!serverProc.stdoutText.includes('GUEST_SERVER_LISTENING')) {
              if (Date.now() > listenDeadline) {
                throw new Error(
                  `Guest server failed to listen within deadline. stderr=${serverProc.stderrText}`,
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }

            const previewIframe = document.createElement('iframe');
            previewIframe.style.width = '640px';
            previewIframe.style.height = '420px';
            workspace.appendChild(previewIframe);

            try {
              const { previewUrl, driver } = await connectContainerPreview(sandbox, 3000, {
                iframe: previewIframe,
              });

              try {
                const embedderOrigin = location.origin;
                const sbOrigin = sandbox.origin;
                const previewOrigin = new URL(previewUrl).origin;

                const tools = createDriverTools(driver);
                const uiObserve = tools.find((t) => t.name === 'ui_observe');
                const uiAct = tools.find((t) => t.name === 'ui_act');
                const uiCapture = tools.find((t) => t.name === 'ui_capture');
                if (!uiObserve || !uiAct || !uiCapture) {
                  throw new Error('Expected ui_observe, ui_act, and ui_capture tools');
                }

                // Turn 1: Observe initial cross-origin guest preview
                const obs1 = await uiObserve.execute({});
                if (!obs1.ok || !isObservationSnapshot(obs1.data)) {
                  throw new Error(`Turn 1 ui_observe failed: ${obs1.summary}`);
                }
                const snap1 = obs1.data;

                const flatNodes1: Array<{
                  role: string;
                  name: string;
                  ref?: string;
                  canvasNonBlank?: boolean;
                }> = [];
                const walk1 = (nodes: typeof snap1.elements): void => {
                  for (const n of nodes) {
                    flatNodes1.push({
                      role: n.role,
                      name: n.name,
                      ...(n.ref !== undefined ? { ref: n.ref } : {}),
                      ...(n.canvas !== undefined ? { canvasNonBlank: n.canvas.nonBlank } : {}),
                    });
                    if (n.children) walk1(n.children);
                  }
                };
                walk1(snap1.elements);

                const patchRef = flatNodes1.find(
                  (n) => n.role === 'textbox' && n.name === 'Patch Name',
                )?.ref;
                const waveRef = flatNodes1.find(
                  (n) => n.role === 'combobox' && n.name === 'Wave Mode',
                )?.ref;
                const applyRef = flatNodes1.find(
                  (n) => n.role === 'button' && n.name === 'Apply Patch',
                )?.ref;
                const diagRef = flatNodes1.find(
                  (n) => n.role === 'button' && n.name === 'Trigger Console Error',
                )?.ref;
                const navLinkRef = flatNodes1.find(
                  (n) => n.role === 'link' && n.name === 'Open Arrangement Page',
                )?.ref;
                if (!patchRef || !waveRef || !applyRef || !diagRef || !navLinkRef) {
                  throw new Error('Missing expected interactive refs on Synth Inspector');
                }

                // Turn 2: Batched ui_act updating form controls + triggering console.error diagnostic
                const act1 = await uiAct.execute({
                  rev: snap1.rev,
                  steps: [
                    { kind: 'fill', target: patchRef, value: 'Warm Lead' },
                    { kind: 'select', target: waveRef, value: 'Sawtooth' },
                    { kind: 'click', target: applyRef },
                    { kind: 'click', target: diagRef },
                  ],
                });
                if (!act1.ok || !isActResult(act1.data)) {
                  throw new Error(`Turn 2 ui_act failed: ${act1.summary}`);
                }
                const act1Data = act1.data;

                // Capture: WebP screenshot + WebM recording across an active UI mutation
                const shotRes = await uiCapture.execute({
                  mode: 'screenshot',
                  format: 'webp',
                });
                if (!shotRes.ok || !isCaptureResult(shotRes.data)) {
                  throw new Error(`Screenshot ui_capture failed: ${shotRes.summary}`);
                }
                const shotData = shotRes.data;
                const webpSignature =
                  shotData.bytes.byteLength >= 12
                    ? String.fromCharCode(
                        shotData.bytes[0] ?? 0,
                        shotData.bytes[1] ?? 0,
                        shotData.bytes[2] ?? 0,
                        shotData.bytes[3] ?? 0,
                      ) +
                      ':' +
                      String.fromCharCode(
                        shotData.bytes[8] ?? 0,
                        shotData.bytes[9] ?? 0,
                        shotData.bytes[10] ?? 0,
                        shotData.bytes[11] ?? 0,
                      )
                    : '';

                const recStartRes = await uiCapture.execute({ mode: 'start_recording' });
                if (!recStartRes.ok) {
                  throw new Error(`start_recording failed: ${recStartRes.summary}`);
                }

                const actDuringRec = await uiAct.execute({
                  rev: act1Data.rev,
                  steps: [
                    { kind: 'fill', target: patchRef, value: 'Recorded Lead' },
                    { kind: 'click', target: applyRef },
                  ],
                });
                if (!actDuringRec.ok || !isActResult(actDuringRec.data)) {
                  throw new Error(`ui_act during recording failed: ${actDuringRec.summary}`);
                }
                await new Promise((resolve) => setTimeout(resolve, 160));

                const recStopRes = await uiCapture.execute({ mode: 'stop_recording' });
                if (!recStopRes.ok || !isCaptureResult(recStopRes.data)) {
                  throw new Error(`stop_recording failed: ${recStopRes.summary}`);
                }
                const recData = recStopRes.data;

                // Cross-origin full-page navigation continuity (/ -> /page2)
                const navActRes = await uiAct.execute({
                  rev: actDuringRec.data.rev,
                  steps: [{ kind: 'click', target: navLinkRef }],
                });
                if (!navActRes.ok || !isActResult(navActRes.data)) {
                  throw new Error(`Cross-origin navigation ui_act failed: ${navActRes.summary}`);
                }

                const obsPage2 = await uiObserve.execute({});
                if (!obsPage2.ok || !isObservationSnapshot(obsPage2.data)) {
                  throw new Error(`Post-navigation ui_observe failed: ${obsPage2.summary}`);
                }

                const bounceAct = await uiAct.execute({
                  rev: obsPage2.data.rev,
                  steps: [
                    { kind: 'click', target: { role: 'button', name: 'Bounce Arrangement' } },
                  ],
                });
                if (!bounceAct.ok || !isActResult(bounceAct.data)) {
                  throw new Error(`Page 2 ui_act failed: ${bounceAct.summary}`);
                }

                // Programmatic navigate step back to '/' inside cross-origin preview
                const returnHomeAct = await uiAct.execute({
                  rev: bounceAct.data.rev,
                  steps: [{ kind: 'navigate', url: '/' }],
                });
                if (!returnHomeAct.ok || !isActResult(returnHomeAct.data)) {
                  throw new Error(`Programmatic navigate ui_act failed: ${returnHomeAct.summary}`);
                }

                return {
                  embedderOrigin,
                  sandboxOrigin: sbOrigin,
                  previewOrigin,
                  containerId: sandbox.id,
                  previewUrl,
                  obs1Summary: obs1.summary,
                  canvasNode: flatNodes1.find((n) => n.name === 'Waveform Scope') ?? null,
                  act1Summary: act1.summary,
                  act1FullReset: act1Data.diff.fullReset,
                  act1Completed: act1Data.completedSteps,
                  act1ConsoleErrors: act1Data.diagnostics.consoleErrors,
                  shotMimeType: shotData.mimeType,
                  shotModeUsed: shotData.modeUsed,
                  shotWidth: shotData.width,
                  shotHeight: shotData.height,
                  shotByteLength: shotData.bytes.byteLength,
                  webpSignature,
                  recMimeType: recData.mimeType,
                  recByteLength: recData.bytes.byteLength,
                  navActUrl: navActRes.data.url,
                  navActFullReset: navActRes.data.diff.fullReset,
                  page2Url: obsPage2.data.url,
                  page2Title: obsPage2.data.title,
                  page2Summary: obsPage2.summary,
                  bounceSummary: bounceAct.summary,
                  returnHomeTitle: returnHomeAct.data.title,
                  returnHomePathname: new URL(returnHomeAct.data.url).pathname,
                  framesBeforeBoot,
                };
              } finally {
                driver.dispose();
              }
            } finally {
              previewIframe.remove();
            }
          } finally {
            await sandbox.dispose();
          }
        },
        {
          sandboxOrigin: harness.sandboxOrigin,
          serverSource: GUEST_MULTI_PAGE_SERVER_CJS,
        },
      );

      // 1. Verify three mutually distinct origins
      const distinctOrigins = new Set([
        e2eResult.embedderOrigin,
        e2eResult.sandboxOrigin,
        e2eResult.previewOrigin,
      ]);
      expect(distinctOrigins.size).toBe(3);
      expect(e2eResult.embedderOrigin).toBe(harness.hostOrigin);
      expect(e2eResult.sandboxOrigin).toBe(harness.sandboxOrigin);
      expect(e2eResult.previewOrigin).toBe(
        `http://${e2eResult.containerId}-3000.localhost:${String(harness.previewPort)}`,
      );

      // 2. Turn 1 observation: heading, refs, and non-blank canvas
      expect(e2eResult.obs1Summary).toContain('Synth Inspector');
      expect(e2eResult.obs1Summary).toContain('Waveform Scope');
      expect(e2eResult.obs1Summary).toContain('nonBlank=true');
      expect(e2eResult.canvasNode?.canvasNonBlank).toBe(true);

      // 3. Turn 2 batched ui_act: localized diff (fullReset: false) + consoleErrors diagnostic
      expect(e2eResult.act1Completed).toBe(4);
      expect(e2eResult.act1FullReset).toBe(false);
      expect(e2eResult.act1Summary).toContain('Applied: Warm Lead [saw]');
      expect(e2eResult.act1ConsoleErrors).toContain('guest-synth-overdrive-warning');

      // 4. Silent WebP screenshot + WebM video recording
      expect(e2eResult.shotMimeType).toBe('image/webp');
      expect(e2eResult.shotModeUsed).toBe('silent');
      expect(e2eResult.shotWidth).toBeGreaterThan(0);
      expect(e2eResult.shotHeight).toBeGreaterThan(0);
      expect(e2eResult.shotByteLength).toBeGreaterThan(64);
      expect(e2eResult.webpSignature).toBe('RIFF:WEBP');

      expect(e2eResult.recMimeType).toBe('video/webm');
      expect(e2eResult.recByteLength).toBeGreaterThan(64);

      // 5. Cross-origin full-page navigation continuity (/ -> /page2)
      expect(e2eResult.navActFullReset).toBe(true);
      expect(new URL(e2eResult.navActUrl).pathname).toBe('/page2');
      expect(new URL(e2eResult.page2Url).pathname).toBe('/page2');
      expect(e2eResult.page2Title).toBe('Arrangement View');
      expect(e2eResult.page2Summary).toContain('Arrangement View');
      expect(e2eResult.bounceSummary).toContain('Bounced 8 bars');
      expect(e2eResult.returnHomePathname).toBe('/');
      expect(e2eResult.returnHomeTitle).toBe('Synth Inspector');

      // 6. Clean disposal: zero leaked iframes, workers, or uncaught page errors
      const framesAfterDispose = await page.evaluate(
        () => document.querySelectorAll('iframe').length,
      );
      expect(framesAfterDispose).toBe(e2eResult.framesBeforeBoot);
      await expect.poll(() => trackedWorkers.size).toBe(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
