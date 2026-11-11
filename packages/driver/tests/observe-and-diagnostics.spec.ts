import { Readable } from 'node:stream';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { startHarnessServer } from './fixtures/harness-server.js';

test.describe('in-frame observation, self-healing refs, and diagnostics', () => {
  test('drains per-turn diagnostics deltas across console, page/resource errors, fetch/XHR failures, and shadow compile overlays despite guest prototype tampering', async ({
    page,
  }) => {
    const forwardedConsoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        forwardedConsoleErrors.push(msg.text());
      }
    });

    const harness = await startHarnessServer({
      frameTitle: 'Diagnostics Sandbox',
      frameRoutes: {
        '/api/broken': async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          const echoed = Buffer.concat(chunks).toString('utf8');
          res.writeHead(503, 'Service Unavailable', {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Received-Body': echoed,
          });
          res.end(JSON.stringify({ error: 'backend unavailable' }));
        },
        '/api/stream-ok': (_req, res) => {
          res.writeHead(200, 'OK', {
            'Content-Type': 'text/plain; charset=utf-8',
          });
          Readable.from(['chunk-a:', 'chunk-b']).pipe(res);
        },
        '/api/items/7': (_req, res) => {
          res.writeHead(404, 'Not Found', {
            'Content-Type': 'text/plain; charset=utf-8',
          });
          res.end('missing item');
        },
        '/missing-asset.png': (_req, res) => {
          res.writeHead(404, 'Not Found', {
            'Content-Type': 'image/png',
          });
          res.end();
        },
      },
      frameBodyHtml: `
        <main aria-label="player">
          <button type="button" id="trigger-next">Next</button>
        </main>
        <script>
          window.__bootReady = (async () => {
            // 1. Console error (must pass through to native console.error as well)
            console.error('boot failure', { code: 42 });

            // 2. Uncaught error + unhandled rejection + resource load error
            setTimeout(() => {
              throw new Error('uncaught boom');
            }, 0);
            Promise.reject(new Error('rejected task'));

            await new Promise((resolve) => {
              const img = document.createElement('img');
              img.alt = 'broken preview';
              img.addEventListener('error', () => resolve(), { once: true });
              img.src = '/missing-asset.png';
              document.body.appendChild(img);
            });

            // 3. Streaming 200 fetch (must NOT record failure and must preserve ReadableStream body)
            const streamRes = await fetch('/api/stream-ok');
            const reader = streamRes.body.getReader();
            let streamedText = '';
            const decoder = new TextDecoder();
            while (true) {
              const step = await reader.read();
              if (step.done) break;
              streamedText += decoder.decode(step.value, { stream: true });
            }
            window.__streamedText = streamedText;

            // 4. Failing HTTP 503 fetch + network error status: 0 + failing HTTP 404 XHR
            const failRes = await fetch('/api/broken', {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain' },
              body: 'payload-ok',
            });
            window.__echoedHeader = failRes.headers.get('x-received-body');

            try {
              await fetch('http://127.0.0.1:1/offline-check');
            } catch {
              // Expected network error
            }

            // Client-aborted fetch (e.g. React StrictMode cleanup) must reject without polluting networkFailures
            try {
              const abortCtrl = new AbortController();
              const abortedPromise = fetch('/api/stream-ok', { signal: abortCtrl.signal });
              abortCtrl.abort();
              await abortedPromise;
            } catch {
              // Expected AbortError
            }

            await new Promise((resolve) => {
              const xhr = new XMLHttpRequest();
              xhr.open('DELETE', '/api/items/7');
              xhr.addEventListener('loadend', () => resolve(), { once: true });
              xhr.send();
            });

            // 5. Mount vite-error-overlay with open Shadow DOM + internal <style>
            const viteOverlay = document.createElement('vite-error-overlay');
            const shadow = viteOverlay.attachShadow({ mode: 'open' });
            shadow.innerHTML =
              '<style>:host { position: fixed; inset: 0; }</style>' +
              '<div class="window"><pre class="message">[plugin:vite] Unexpected token (14:2)</pre></div>';
            document.body.appendChild(viteOverlay);

            await new Promise((resolve) => setTimeout(resolve, 25));

            // 6. Tamper with browser prototypes after preload initialization
            Function.prototype.call = () => {
              throw new Error('tampered Function.prototype.call');
            };
            Object.defineProperty(Element.prototype, 'shadowRoot', {
              get() {
                return null;
              },
            });
            Element.prototype.getBoundingClientRect = () => {
              throw new Error('tampered getBoundingClientRect');
            };
            Element.prototype.getAttribute = () => {
              throw new Error('tampered getAttribute');
            };
            window.getComputedStyle = () => {
              throw new Error('tampered getComputedStyle');
            };
            MessagePort.prototype.postMessage = () => {
              throw new Error('tampered postMessage');
            };

            document.getElementById('trigger-next').addEventListener('click', () => {
              const existingNext = document.querySelector('nextjs-portal');
              if (existingNext) {
                existingNext.remove();
                return;
              }
              viteOverlay.remove();
              const portal = document.createElement('nextjs-portal');
              const portalShadow = portal.attachShadow({ mode: 'open' });
              portalShadow.innerHTML =
                '<div data-nextjs-dialog="true">Unhandled Runtime Error: ReferenceError: clip is not defined</div>';
              document.body.appendChild(portal);
              console.error('turn-two error');
            });
          })();
        </script>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const report = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.width = '960';
        iframe.height = '540';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);
        await new Promise<void>((resolve) => {
          iframe.addEventListener('load', () => resolve(), { once: true });
        });

        const driver = await connectIframe(iframe);
        // Wait briefly for guest __bootReady async tasks in cross-origin frame
        await new Promise((resolve) => setTimeout(resolve, 120));

        const snap1 = await driver.observe();
        const snap2 = await driver.observe();
        driver.dispose();
        return { snap1, snap2 };
      }, harness.frameOrigin);

      const frame = page.frames().find((f) => f.url().startsWith(harness.frameOrigin));
      expect(frame).toBeDefined();
      await frame!.locator('#trigger-next').dispatchEvent('click');

      const turnThreeAndFour = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const iframe = document.querySelector('iframe');
        if (!(iframe instanceof HTMLIFrameElement)) throw new Error('Missing iframe');
        const driver = await connectIframe(iframe);
        const snap3 = await driver.observe();
        await new Promise((resolve) => setTimeout(resolve, 10));
        driver.dispose();
        return { snap3, frameOrigin };
      }, harness.frameOrigin);

      await frame!.locator('#trigger-next').dispatchEvent('click');
      const clearedSnap = await page.evaluate(async () => {
        const { connectIframe } = await import('@inbrowser/driver');
        const iframe = document.querySelector('iframe');
        if (!(iframe instanceof HTMLIFrameElement)) throw new Error('Missing iframe');
        const driver = await connectIframe(iframe);
        const snap4 = await driver.observe();
        driver.dispose();
        return snap4;
      });

      expect(report.snap1.rev).toBe(1);
      expect(report.snap1.title).toBe('Diagnostics Sandbox');
      expect(report.snap1.url).toBe(`${harness.frameOrigin}/frame`);
      expect(report.snap1.viewport).toEqual({ width: 960, height: 540 });

      // Compile overlay pierced open ShadowRoot and stripped <style> rules
      expect(report.snap1.diagnostics.compileOverlay).toContain(
        '[plugin:vite] Unexpected token (14:2)',
      );
      expect(report.snap1.diagnostics.compileOverlay).not.toContain('position: fixed');

      // Console error recorded AND passed through to real console.error
      expect(
        report.snap1.diagnostics.consoleErrors.some(
          (msg) => msg.includes('boot failure') && msg.includes('42'),
        ),
      ).toBe(true);
      expect(forwardedConsoleErrors.some((msg) => msg.includes('boot failure'))).toBe(true);

      // Page errors: uncaught ErrorEvent, resource load failure, and unhandledrejection
      expect(report.snap1.diagnostics.pageErrors.some((msg) => msg.includes('uncaught boom'))).toBe(
        true,
      );
      expect(
        report.snap1.diagnostics.pageErrors.some((msg) => msg.includes('missing-asset.png')),
      ).toBe(true);
      expect(report.snap1.diagnostics.pageErrors.some((msg) => msg.includes('rejected task'))).toBe(
        true,
      );

      // Network failures: 503 fetch, status 0 fetch error, 404 XHR; 200 stream excluded
      const net = report.snap1.diagnostics.networkFailures;
      expect(
        net.some(
          (entry) =>
            entry.method === 'POST' &&
            entry.url.includes('/api/broken') &&
            entry.status === 503 &&
            entry.statusText === 'Service Unavailable',
        ),
      ).toBe(true);
      expect(
        net.some(
          (entry) =>
            entry.method === 'GET' && entry.url.includes('offline-check') && entry.status === 0,
        ),
      ).toBe(true);
      expect(
        net.some(
          (entry) =>
            entry.method === 'DELETE' && entry.url.includes('/api/items/7') && entry.status === 404,
        ),
      ).toBe(true);
      expect(net.some((entry) => entry.url.includes('/api/stream-ok'))).toBe(false);

      // Second observe drains empty event deltas while compileOverlay remains live until removed
      expect(report.snap2.rev).toBe(2);
      expect(report.snap2.diagnostics.consoleErrors).toEqual([]);
      expect(report.snap2.diagnostics.pageErrors).toEqual([]);
      expect(report.snap2.diagnostics.networkFailures).toEqual([]);
      expect(report.snap2.diagnostics.compileOverlay).toContain(
        '[plugin:vite] Unexpected token (14:2)',
      );

      expect(turnThreeAndFour.snap3.diagnostics.compileOverlay).toContain(
        'Unhandled Runtime Error: ReferenceError: clip is not defined',
      );
      expect(
        turnThreeAndFour.snap3.diagnostics.consoleErrors.some((msg) =>
          msg.includes('turn-two error'),
        ),
      ).toBe(true);
      expect(clearedSnap.diagnostics.compileOverlay).toBeNull();
      expect(clearedSnap.diagnostics.consoleErrors).toEqual([]);

      // Also verify streaming body and request headers/body survived fetch wrapping intact
      const guestCheck = await frame!.evaluate(() => ({
        streamedText: Reflect.get(window, '__streamedText'),
        echoedHeader: Reflect.get(window, '__echoedHeader'),
      }));
      expect(guestCheck).toEqual({
        streamedText: 'chunk-a:chunk-b',
        echoedHeader: 'payload-ok',
      });
    } finally {
      await harness.close();
    }
  });

  test('observes rich ARIA hierarchy, open Shadow DOM slots, media/canvas telemetry, hidden/overlay exclusions, and includeAllText toggle', async ({
    page,
  }) => {
    // Minimal 1x1 PNG served from hostOrigin WITHOUT CORS headers so drawing it inside frameOrigin taints a 2D canvas.
    const oneByOnePng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    const harness = await startHarnessServer({
      frameTitle: 'Studio Media Workspace',
      hostRoutes: {
        '/opaque-pixel.png': (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
          });
          res.end(oneByOnePng);
        },
      },
      frameRoutes: {
        '/corrupt.mp4': (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-store',
          });
          res.end(Buffer.from('not-a-valid-mp4-container'));
        },
      },
      frameBodyHtml: `
        <header><h1>Timeline Editor</h1></header>
        <nav aria-label="Primary"><a href="#tracks">Tracks</a></nav>
        <main aria-label="Workspace">
          <div class="pure-layout-wrapper">
            <p>Decorative body paragraph omitted by default</p>
            <ul aria-label="Static Notes">
              <li>First note</li>
              <li>Second note</li>
            </ul>
            <div role="status">Ready to edit</div>
            <div role="alert">Low disk cache</div>

            <form aria-label="Clip Properties">
              <label for="clip-name">Clip Name</label>
              <input id="clip-name" type="text" value="Opening Scene" />

              <label>
                Description
                <textarea disabled>Locked notes</textarea>
              </label>

              <input type="text" placeholder="Search markers" />
              <input type="number" title="Frame Rate" min="24" max="60" value="30" />
              <input type="range" aria-label="Scrubber" min="0" max="120" step="0.5" value="37.5" />

              <label><input type="checkbox" checked /> Snap to Grid</label>
              <button type="button" role="switch" aria-checked="true">Auto Ripple</button>
              <label><input type="radio" name="quality" checked /> High</label>

              <label for="codec-select">Codec</label>
              <select id="codec-select">
                <option value="h264">H.264</option>
                <option value="vp9" selected>VP9</option>
              </select>

              <span id="ext-export-lbl" hidden>Export Render</span>
              <button type="button" aria-labelledby="ext-export-lbl" disabled>Go</button>
            </form>

            <div id="shadow-mount"></div>

            <section aria-label="Preview Stage">
              <video aria-label="Program Monitor" width="640" height="360"></video>
              <video id="broken-video" aria-label="Corrupt Feed" src="/corrupt.mp4" width="320" height="180"></video>
              <audio aria-label="Voiceover Stem"></audio>

              <canvas id="blank-canvas" aria-label="Untouched Layer" width="200" height="80"></canvas>
              <canvas id="drawn-canvas" aria-label="Waveform" width="240" height="60"></canvas>
              <canvas id="tainted-canvas" aria-label="External Overlay" width="160" height="90"></canvas>
              <canvas id="webgl-canvas" aria-label="Shader Stage" width="320" height="180"></canvas>
            </section>
          </div>

          <dialog open aria-label="Shortcuts">
            <div role="tablist">
              <button type="button" role="tab">General</button>
            </div>
            <div role="menu">
              <button type="button" role="menuitem">Reset Defaults</button>
            </div>
          </dialog>

          <dialog aria-label="Closed Modal">
            <button type="button">Should Not Appear</button>
          </dialog>
        </main>
        <footer><span>v1.0</span></footer>

        <div data-inbrowser-driver-ui="overlay">
          <button type="button">Driver Cursor Secret</button>
        </div>
        <div hidden><button type="button">Hidden Attr Secret</button></div>
        <div aria-hidden="true"><button type="button">Aria Hidden Secret</button></div>
        <div style="display: none"><button type="button">Display None Secret</button></div>
        <div style="visibility: hidden"><button type="button">Visibility Hidden Secret</button></div>

        <script>
          window.__mediaSetupDone = (async () => {
            // Open Shadow DOM custom element with <slot>
            class TransportBar extends HTMLElement {
              constructor() {
                super();
                const sr = this.attachShadow({ mode: 'open' });
                sr.innerHTML =
                  '<div role="toolbar" aria-label="Transport">' +
                  '<button type="button">Play</button>' +
                  '<slot></slot>' +
                  '</div>';
              }
            }
            customElements.define('x-transport-bar', TransportBar);
            const mount = document.getElementById('shadow-mount');
            mount.innerHTML = '<x-transport-bar><button type="button">Loop</button></x-transport-bar>';

            // Draw onto 2D canvas
            const drawn = document.getElementById('drawn-canvas');
            const ctx2d = drawn.getContext('2d');
            ctx2d.fillStyle = '#22cc88';
            ctx2d.fillRect(20, 10, 100, 30);

            // Taint 2D canvas with cross-origin hostOrigin image
            const hostPort = Number(location.port) - 1;
            const tainted = document.getElementById('tainted-canvas');
            const taintedCtx = tainted.getContext('2d');
            await new Promise((resolve) => {
              const img = new Image();
              img.onload = () => {
                taintedCtx.drawImage(img, 0, 0, 16, 16);
                resolve();
              };
              img.onerror = () => resolve();
              img.src = 'http://127.0.0.1:' + hostPort + '/opaque-pixel.png';
            });

            // Initialize WebGL canvas
            const webglCanvas = document.getElementById('webgl-canvas');
            const gl = webglCanvas.getContext('webgl') || webglCanvas.getContext('webgl2');
            if (gl) {
              gl.clearColor(0.1, 0.3, 0.7, 1.0);
              gl.clear(gl.COLOR_BUFFER_BIT);
            }

            // Wait for corrupt video error state
            const brokenVideo = document.getElementById('broken-video');
            if (!brokenVideo.error) {
              await new Promise((resolve) => {
                brokenVideo.addEventListener('error', () => resolve(), { once: true });
                setTimeout(resolve, 400);
              });
            }
          })();
        </script>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const result = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.width = '1280';
        iframe.height = '800';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);
        await new Promise<void>((resolve) => {
          iframe.addEventListener('load', () => resolve(), { once: true });
        });

        const driver = await connectIframe(iframe);
        await new Promise((resolve) => setTimeout(resolve, 150));

        const compactSnap = await driver.observe();
        const fullTextSnap = await driver.observe({ includeAllText: true });
        driver.dispose();
        return { compactSnap, fullTextSnap };
      }, harness.frameOrigin);

      type NodeLike = (typeof result.compactSnap.elements)[number];
      function flattenNodes(nodes: readonly NodeLike[]): NodeLike[] {
        const acc: NodeLike[] = [];
        for (const node of nodes) {
          acc.push(node);
          if (node.children !== undefined) {
            acc.push(...flattenNodes(node.children));
          }
        }
        return acc;
      }

      const compactFlat = flattenNodes(result.compactSnap.elements);
      const fullFlat = flattenNodes(result.fullTextSnap.elements);

      // 1. Exclusions: driver UI, hidden, aria-hidden, display:none, visibility:hidden, closed dialog
      const allCompactNames = compactFlat.map((n) => n.name);
      expect(allCompactNames).not.toContain('Driver Cursor Secret');
      expect(allCompactNames).not.toContain('Hidden Attr Secret');
      expect(allCompactNames).not.toContain('Aria Hidden Secret');
      expect(allCompactNames).not.toContain('Display None Secret');
      expect(allCompactNames).not.toContain('Visibility Hidden Secret');
      expect(allCompactNames).not.toContain('Should Not Appear');

      // 2. Landmarks, headings, status, alerts
      expect(compactFlat.some((n) => n.role === 'banner')).toBe(true);
      expect(compactFlat.some((n) => n.role === 'heading' && n.name === 'Timeline Editor')).toBe(
        true,
      );
      expect(
        compactFlat.some((n) => n.role === 'navigation' && n.name === 'Primary' && Boolean(n.ref)),
      ).toBe(true);
      expect(
        compactFlat.some((n) => n.role === 'main' && n.name === 'Workspace' && Boolean(n.ref)),
      ).toBe(true);
      expect(compactFlat.some((n) => n.role === 'contentinfo')).toBe(true);
      expect(compactFlat.some((n) => n.role === 'status' && n.name === 'Ready to edit')).toBe(true);
      expect(compactFlat.some((n) => n.role === 'alert' && n.name === 'Low disk cache')).toBe(true);
      expect(
        compactFlat.some((n) => n.role === 'dialog' && n.name === 'Shortcuts' && Boolean(n.ref)),
      ).toBe(true);

      // 3. Interactive controls, accessible names, and states
      expect(compactFlat.find((n) => n.role === 'textbox' && n.name === 'Clip Name')).toMatchObject(
        {
          value: 'Opening Scene',
          disabled: false,
        },
      );
      expect(
        compactFlat.find((n) => n.role === 'textbox' && n.name === 'Description'),
      ).toMatchObject({
        value: 'Locked notes',
        disabled: true,
      });
      expect(
        compactFlat.find((n) => n.role === 'textbox' && n.name === 'Search markers'),
      ).toMatchObject({
        value: '',
        disabled: false,
      });
      expect(
        compactFlat.find((n) => n.role === 'spinbutton' && n.name === 'Frame Rate'),
      ).toMatchObject({
        value: '30',
        min: 24,
        max: 60,
        disabled: false,
      });
      expect(compactFlat.find((n) => n.role === 'slider' && n.name === 'Scrubber')).toMatchObject({
        value: '37.5',
        min: 0,
        max: 120,
        disabled: false,
      });
      expect(
        compactFlat.find((n) => n.role === 'checkbox' && n.name === 'Snap to Grid'),
      ).toMatchObject({
        checked: true,
        disabled: false,
      });
      expect(
        compactFlat.find((n) => n.role === 'switch' && n.name === 'Auto Ripple'),
      ).toMatchObject({
        checked: true,
        disabled: false,
      });
      expect(compactFlat.find((n) => n.role === 'radio' && n.name === 'High')).toMatchObject({
        checked: true,
        disabled: false,
      });
      expect(compactFlat.find((n) => n.role === 'combobox' && n.name === 'Codec')).toMatchObject({
        value: 'vp9',
        expanded: false,
        disabled: false,
      });
      // aria-labelledby resolves even when referenced label node is [hidden] per W3C AccName!
      expect(
        compactFlat.find((n) => n.role === 'button' && n.name === 'Export Render'),
      ).toMatchObject({
        disabled: true,
      });
      expect(
        compactFlat.some((n) => n.role === 'tab' && n.name === 'General' && Boolean(n.ref)),
      ).toBe(true);
      expect(
        compactFlat.some(
          (n) => n.role === 'menuitem' && n.name === 'Reset Defaults' && Boolean(n.ref),
        ),
      ).toBe(true);

      // 4. Open Shadow DOM toolbar + slotted <button>Loop</button>
      const transportToolbar = compactFlat.find(
        (n) => n.role === 'toolbar' && n.name === 'Transport',
      );
      expect(transportToolbar).toBeDefined();
      const toolbarFlat = flattenNodes([transportToolbar!]);
      expect(
        toolbarFlat.some((n) => n.role === 'button' && n.name === 'Play' && Boolean(n.ref)),
      ).toBe(true);
      expect(
        toolbarFlat.some((n) => n.role === 'button' && n.name === 'Loop' && Boolean(n.ref)),
      ).toBe(true);

      // 5. Media & Canvas telemetry (including zero-box <audio> without controls)
      const progVideo = compactFlat.find((n) => n.role === 'video' && n.name === 'Program Monitor');
      expect(progVideo?.ref).toMatch(/^e\d+$/);
      expect(progVideo?.media).toEqual({
        kind: 'video',
        paused: true,
        currentTime: 0,
        duration: null,
        width: 640,
        height: 360,
        ready: false,
        error: null,
      });

      const corruptVideo = compactFlat.find((n) => n.role === 'video' && n.name === 'Corrupt Feed');
      expect(corruptVideo?.media?.error).not.toBeNull();

      const voiceAudio = compactFlat.find((n) => n.role === 'audio' && n.name === 'Voiceover Stem');
      expect(voiceAudio?.ref).toMatch(/^e\d+$/);
      expect(voiceAudio?.media).toEqual({
        kind: 'audio',
        paused: true,
        currentTime: 0,
        duration: null,
        width: 0,
        height: 0,
        ready: false,
        error: null,
      });

      expect(
        compactFlat.find((n) => n.role === 'canvas' && n.name === 'Untouched Layer')?.canvas,
      ).toEqual({
        width: 200,
        height: 80,
        nonBlank: false,
      });
      expect(compactFlat.find((n) => n.role === 'canvas' && n.name === 'Waveform')?.canvas).toEqual(
        {
          width: 240,
          height: 60,
          nonBlank: true,
        },
      );
      expect(
        compactFlat.find((n) => n.role === 'canvas' && n.name === 'External Overlay')?.canvas,
      ).toEqual({
        width: 160,
        height: 90,
        nonBlank: true,
      });
      expect(
        compactFlat.find((n) => n.role === 'canvas' && n.name === 'Shader Stage')?.canvas,
      ).toEqual({
        width: 320,
        height: 180,
        nonBlank: true,
      });

      // Confirm untouched #blank-canvas was NOT locked to 2d context by observe()
      const frame = page.frames().find((f) => f.url().startsWith(harness.frameOrigin));
      const canStillAcquireWebgl = await frame!.evaluate(() => {
        const blank = document.getElementById('blank-canvas');
        if (!(blank instanceof HTMLCanvasElement)) return false;
        return blank.getContext('webgl') !== null || blank.getContext('webgl2') !== null;
      });
      expect(canStillAcquireWebgl).toBe(true);

      // 6. includeAllText: false omits decorative paragraph & static list items; true includes them
      expect(compactFlat.some((n) => n.name.includes('Decorative body paragraph omitted'))).toBe(
        false,
      );
      expect(compactFlat.some((n) => n.role === 'listitem' && n.name === 'First note')).toBe(false);

      expect(fullFlat.some((n) => n.name.includes('Decorative body paragraph omitted'))).toBe(true);
      expect(fullFlat.some((n) => n.role === 'list' && n.name === 'Static Notes')).toBe(true);
      expect(fullFlat.some((n) => n.role === 'listitem' && n.name === 'First note')).toBe(true);
      expect(
        compactFlat.some(
          (n) => n.role === 'option' && n.name === 'VP9' && n.value === 'vp9' && n.checked === true,
        ),
      ).toBe(true);
    } finally {
      await harness.close();
    }
  });

  test('reuses stable [ref=eN] across snapshots, resolves scoped subtrees, self-heals unambiguous remounts, and fails safe on ambiguous duplicates', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Self-Healing Workspace',
      frameBodyHtml: `
        <nav aria-label="Sidebar">
          <a href="#overview">Overview</a>
        </nav>
        <main aria-label="Editor">
          <div id="mount-root">
            <section id="inspector-card" aria-label="Inspector">
              <button type="button" id="save-btn">Save Changes</button>
              <button type="button" id="delete-btn">Delete Clip</button>
              <button type="button" id="archive-btn">Archive</button>
            </section>
          </div>
          <div id="shadow-toolbar-host"></div>
        </main>
        <script>
          const host = document.getElementById('shadow-toolbar-host');
          const sr = host.attachShadow({ mode: 'open' });
          sr.innerHTML =
            '<div role="toolbar" aria-label="Transport">' +
            '<button type="button">Play</button>' +
            '<button type="button">Stop</button>' +
            '</div>';

          window.__remountUnambiguous = () => {
            const mount = document.getElementById('mount-root');
            // Replace DOM subtree completely (simulating React key remount / Vite HMR)
            mount.innerHTML =
              '<section id="inspector-card" aria-label="Inspector">' +
              '<button type="button" id="save-btn-v2">Save Changes</button>' +
              '<button type="button" id="delete-btn-v2">Delete Clip</button>' +
              '</section>';
          };

          window.__remountAmbiguousDelete = () => {
            const mount = document.getElementById('mount-root');
            mount.innerHTML =
              '<section id="inspector-card" aria-label="Inspector">' +
              '<button type="button" id="save-btn-v3">Save Changes</button>' +
              '<button type="button" class="dup-del">Delete Clip</button>' +
              '<button type="button" class="dup-del">Delete Clip</button>' +
              '</section>';
          };
        </script>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const initial = await page.evaluate(async (frameOrigin) => {
        const { connectIframe, DriverError } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);
        await new Promise<void>((resolve) => {
          iframe.addEventListener('load', () => resolve(), { once: true });
        });

        const driver = await connectIframe(iframe);
        const snap1 = await driver.observe();
        const snap2 = await driver.observe();

        // Scope by role:name inside open Shadow DOM ('toolbar:Transport')
        const transportScoped = await driver.observe({ scope: 'toolbar:Transport' });
        // Scope by landmark role ('navigation')
        const navScoped = await driver.observe({ scope: 'navigation' });
        // Scope by CSS selector ('#inspector-card')
        const cssScoped = await driver.observe({ scope: '#inspector-card' });

        let missingScopeError: { code: string; candidateCount: number } | null = null;
        try {
          await driver.observe({ scope: 'toolbar:NonExistent' });
        } catch (err) {
          if (err instanceof DriverError) {
            missingScopeError = {
              code: err.code,
              candidateCount: err.candidates?.length ?? 0,
            };
          }
        }

        driver.dispose();
        return {
          snap1,
          snap2,
          transportScoped,
          navScoped,
          cssScoped,
          missingScopeError,
        };
      }, harness.frameOrigin);

      expect(initial.snap1.rev).toBe(1);
      expect(initial.snap2.rev).toBe(2);

      type NodeLike = (typeof initial.snap1.elements)[number];
      function flatten(nodes: readonly NodeLike[]): NodeLike[] {
        const out: NodeLike[] = [];
        for (const n of nodes) {
          out.push(n);
          if (n.children !== undefined) out.push(...flatten(n.children));
        }
        return out;
      }

      const flat1 = flatten(initial.snap1.elements);
      const flat2 = flatten(initial.snap2.elements);

      const inspectorRef1 = flat1.find((n) => n.role === 'region' && n.name === 'Inspector')?.ref;
      const saveRef1 = flat1.find((n) => n.role === 'button' && n.name === 'Save Changes')?.ref;
      const deleteRef1 = flat1.find((n) => n.role === 'button' && n.name === 'Delete Clip')?.ref;
      const archiveRef1 = flat1.find((n) => n.role === 'button' && n.name === 'Archive')?.ref;

      expect(inspectorRef1).toMatch(/^e\d+$/);
      expect(saveRef1).toMatch(/^e\d+$/);
      expect(deleteRef1).toMatch(/^e\d+$/);
      expect(archiveRef1).toMatch(/^e\d+$/);

      // Connected elements keep identical RefId across consecutive snapshots
      expect(flat2.find((n) => n.role === 'region' && n.name === 'Inspector')?.ref).toBe(
        inspectorRef1,
      );
      expect(flat2.find((n) => n.role === 'button' && n.name === 'Save Changes')?.ref).toBe(
        saveRef1,
      );

      // Scoped observations return only the targeted subtree
      expect(initial.transportScoped.elements).toHaveLength(1);
      expect(initial.transportScoped.elements[0]?.role).toBe('toolbar');
      expect(initial.transportScoped.elements[0]?.name).toBe('Transport');
      expect(flatten(initial.transportScoped.elements).some((n) => n.name === 'Save Changes')).toBe(
        false,
      );

      expect(initial.navScoped.elements).toHaveLength(1);
      expect(initial.navScoped.elements[0]?.role).toBe('navigation');

      expect(initial.cssScoped.elements).toHaveLength(1);
      expect(initial.cssScoped.elements[0]?.name).toBe('Inspector');

      expect(initial.missingScopeError).toEqual({
        code: 'DRIVER_TARGET_NOT_FOUND',
        candidateCount: expect.any(Number),
      });
      expect(initial.missingScopeError!.candidateCount).toBeGreaterThan(0);

      // Trigger React-style unmount/remount (detaching original Save, Delete, Inspector, and removing Archive)
      const frame = page.frames().find((f) => f.url().startsWith(harness.frameOrigin));
      expect(frame).toBeDefined();
      await frame!.evaluate(() => {
        const remount: unknown = Reflect.get(window, '__remountUnambiguous');
        if (typeof remount !== 'function') throw new Error('Missing __remountUnambiguous');
        remount();
      });

      const afterRemount = await page.evaluate(
        async ({ saveRef, archiveRef, inspectorRef }) => {
          const { connectIframe, DriverError } = await import('@inbrowser/driver');
          const iframe = document.querySelector('iframe');
          if (!(iframe instanceof HTMLIFrameElement)) throw new Error('Missing iframe');
          const driver = await connectIframe(iframe);

          // Self-heals detached Save button & Inspector region via semantic fingerprint!
          const healedSaveScope = await driver.observe({ scope: saveRef });
          const healedInspectorScope = await driver.observe({ scope: inspectorRef });

          // Removed Archive button fails with DRIVER_TARGET_NOT_FOUND + nearest candidates
          let archiveOutcome: { code: string; candidates: unknown[] } | null = null;
          try {
            await driver.observe({ scope: archiveRef });
          } catch (err) {
            if (err instanceof DriverError) {
              archiveOutcome = {
                code: err.code,
                candidates: [...(err.candidates ?? [])],
              };
            }
          }

          driver.dispose();
          return { healedSaveScope, healedInspectorScope, archiveOutcome };
        },
        {
          saveRef: saveRef1!,
          archiveRef: archiveRef1!,
          inspectorRef: inspectorRef1!,
        },
      );

      expect(afterRemount.healedSaveScope.elements).toEqual([
        {
          role: 'button',
          name: 'Save Changes',
          ref: saveRef1,
        },
      ]);
      expect(afterRemount.healedInspectorScope.elements[0]?.ref).toBe(inspectorRef1);
      expect(afterRemount.archiveOutcome?.code).toBe('DRIVER_TARGET_NOT_FOUND');
      expect(afterRemount.archiveOutcome?.candidates.length).toBeGreaterThan(0);

      // Now trigger ambiguous remount where TWO identical "Delete Clip" buttons appear in the same landmark
      await frame!.evaluate(() => {
        const remount: unknown = Reflect.get(window, '__remountAmbiguousDelete');
        if (typeof remount !== 'function') throw new Error('Missing __remountAmbiguousDelete');
        remount();
      });

      const ambiguousOutcome = await page.evaluate(async (deleteRef) => {
        const { connectIframe, DriverError } = await import('@inbrowser/driver');
        const iframe = document.querySelector('iframe');
        if (!(iframe instanceof HTMLIFrameElement)) throw new Error('Missing iframe');
        const driver = await connectIframe(iframe);
        try {
          await driver.observe({ scope: deleteRef });
          return { code: 'NO_ERROR', candidateCount: 0 };
        } catch (err) {
          if (err instanceof DriverError) {
            return {
              code: err.code,
              candidateCount: err.candidates?.length ?? 0,
            };
          }
          throw err;
        } finally {
          driver.dispose();
        }
      }, deleteRef1!);

      expect(ambiguousOutcome).toEqual({
        code: 'DRIVER_TARGET_AMBIGUOUS',
        candidateCount: 2,
      });
    } finally {
      await harness.close();
    }
  });

  test('resolves role/nth and deepest-element text TargetSpecs in real Chromium DOM including Shadow roots', async ({
    page,
  }) => {
    const bundle = await build({
      entryPoints: ['src/preload/ref-registry.ts'],
      bundle: true,
      format: 'iife',
      globalName: '__RefRegistryTest',
      platform: 'browser',
      target: 'es2022',
      write: false,
    });
    const scriptContent = bundle.outputFiles[0]?.text ?? '';

    const harness = await startHarnessServer();
    try {
      await page.goto(`${harness.hostOrigin}/host`);
      await page.setContent(`
        <main aria-label="Timeline">
          <div class="card">
            <button type="button" id="first-remove">Remove</button>
            <button type="button" id="second-remove">Remove</button>
            <button type="button" id="save-draft">Save Draft</button>
            <p id="hint-copy">Drag playhead to scrub</p>
          </div>
          <div id="shadow-box"></div>
        </main>
        <script>
          const host = document.getElementById('shadow-box');
          const sr = host.attachShadow({ mode: 'open' });
          sr.innerHTML = '<button type="button" id="shadow-export">Export Audio</button>';
        </script>
      `);
      await page.addScriptTag({ content: scriptContent });

      const check = await page.evaluate(() => {
        const rawApi: unknown = Reflect.get(window, '__RefRegistryTest');
        if (typeof rawApi !== 'object' || rawApi === null) {
          throw new Error('Missing __RefRegistryTest');
        }
        const resolveFn: unknown = Reflect.get(rawApi, 'resolveTarget');
        if (typeof resolveFn !== 'function') {
          throw new Error('Missing __RefRegistryTest.resolveTarget');
        }
        const callResolve = (spec: unknown): Element => {
          const el: unknown = resolveFn(spec);
          if (!(el instanceof Element)) {
            throw new Error('Expected Element from resolveTarget');
          }
          return el;
        };

        const nthMatchId = callResolve({ role: 'button', name: 'Remove', nth: 1 }).id;
        const textButtonTag = callResolve({ text: 'Save Draft' }).id;
        const textParagraphId = callResolve({ text: 'playhead' }).id;
        const shadowBtnId = callResolve({ role: 'button', name: 'Export Audio' }).id;

        let ambiguousRoleCode = 'NONE';
        try {
          callResolve({ role: 'button', name: 'Remove' });
        } catch (err) {
          ambiguousRoleCode =
            typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'ERR';
        }

        let exactTextMismatchCode = 'NONE';
        try {
          callResolve({ text: 'Save', exact: true });
        } catch (err) {
          exactTextMismatchCode =
            typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'ERR';
        }

        return {
          nthMatchId,
          textButtonTag,
          textParagraphId,
          shadowBtnId,
          ambiguousRoleCode,
          exactTextMismatchCode,
        };
      });

      expect(check).toEqual({
        nthMatchId: 'second-remove',
        textButtonTag: 'save-draft',
        textParagraphId: 'hint-copy',
        shadowBtnId: 'shadow-export',
        ambiguousRoleCode: 'DRIVER_TARGET_AMBIGUOUS',
        exactTextMismatchCode: 'DRIVER_TARGET_NOT_FOUND',
      });
    } finally {
      await harness.close();
    }
  });

  test('surfaces data-driver and data-driver-intent annotations, promotes cursor:pointer row boundaries once, and resolves { driver, nth } targets in act and observe', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Driver Annotations & Pointer Rows',
      frameBodyHtml: [
        '<style>',
        '  body { margin: 0; padding: 12px; font: 14px/20px sans-serif; }',
        '  .issue-row, .legacy-row { padding: 8px 12px; margin-bottom: 6px; cursor: pointer; background: #1e293b; color: #f8fafc; }',
        '  textarea { display: block; width: 280px; height: 80px; margin-top: 8px; }',
        '</style>',
        '<div id="inspector" data-driver="inspector.panel" data-driver-intent="Lists active validation issues">',
        '  <div id="issue-0" class="issue-row" data-driver="inspector.issue" data-driver-intent="Selects issue and scrolls editor to line">',
        '    <span>L4:12</span> <span>Undefined token</span>',
        '  </div>',
        '  <div id="issue-1" class="issue-row" data-driver="inspector.issue" data-driver-intent="Selects issue and scrolls editor to line">',
        '    <span>L9:03</span> <span>Contrast ratio warning</span>',
        '  </div>',
        '  <div id="legacy-clickable" class="legacy-row">',
        '    <span class="loc">L14:8</span> <span class="label">Unannotated row</span>',
        '  </div>',
        '</div>',
        '<textarea id="source-editor" aria-label="Document source" data-driver="editor.source" data-driver-description="Edits raw markdown and re-runs validation">initial</textarea>',
        '<output id="selection-status">idle</output>',
        '<script>',
        '  const out = document.getElementById("selection-status");',
        '  const events = [];',
        '  document.getElementById("issue-0").addEventListener("click", () => { events.push("issue-0"); out.textContent = events.join(","); });',
        '  document.getElementById("issue-1").addEventListener("click", () => { events.push("issue-1"); out.textContent = events.join(","); });',
        '  document.getElementById("legacy-clickable").addEventListener("click", () => { events.push("legacy"); out.textContent = events.join(","); });',
        '</script>',
      ].join('\n'),
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const report = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 480px; height: 360px; border: 0; display: block;';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);
        try {
          const full = await driver.observe();
          const scoped = await driver.observe({ scope: '[data-driver="inspector.panel"]' });

          type FlatItem = {
            role: string;
            name: string;
            hasRef: boolean;
            ref?: `e${number}`;
            driverId?: string;
            intent?: string;
            value?: string;
          };
          const flatten = (nodes: typeof full.elements, acc: FlatItem[] = []): FlatItem[] => {
            for (const n of nodes) {
              acc.push({
                role: n.role,
                name: n.name,
                hasRef: n.ref !== undefined,
                ...(n.ref !== undefined ? { ref: n.ref } : {}),
                ...(n.driverId !== undefined ? { driverId: n.driverId } : {}),
                ...(n.intent !== undefined ? { intent: n.intent } : {}),
                ...(n.value !== undefined ? { value: n.value } : {}),
              });
              if (n.children) flatten(n.children, acc);
            }
            return acc;
          };

          const flatFull = flatten(full.elements);
          const legacyMatches = flatFull.filter((n) => n.name.includes('Unannotated row'));
          const legacyRef = legacyMatches[0]?.ref;

          const ambiguousAct = await driver.act({
            rev: scoped.rev,
            steps: [{ kind: 'click', target: { driver: 'inspector.issue' } }],
          });

          const actRes = await driver.act({
            rev: ambiguousAct.rev,
            steps: [
              { kind: 'click', target: { driver: 'inspector.issue', nth: 1 } },
              ...(legacyRef ? [{ kind: 'click' as const, target: legacyRef }] : []),
              { kind: 'fill', target: { driver: 'editor.source' }, value: 'updated markdown' },
            ],
          });

          const after = flatten(await driver.observe().then((s) => s.elements));
          return {
            flatFull,
            scopedRootDriver: scoped.elements[0]?.driverId,
            legacyMatchCount: legacyMatches.length,
            ambiguousError: ambiguousAct.error ?? '',
            completedSteps: actRes.completedSteps,
            interruptedReason: actRes.interruptedReason ?? null,
            afterEditorValue: after.find((n) => n.driverId === 'editor.source')?.value,
            afterStatus: after.find((n) => n.role === 'status')?.name,
          };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      expect(report.scopedRootDriver).toBe('inspector.panel');
      expect(report.ambiguousError).toContain('DRIVER_TARGET_AMBIGUOUS');
      expect(report.flatFull).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'region',
            driverId: 'inspector.panel',
            intent: 'Lists active validation issues',
            hasRef: true,
          }),
          expect.objectContaining({
            role: 'button',
            name: 'L4:12 Undefined token',
            driverId: 'inspector.issue',
            intent: 'Selects issue and scrolls editor to line',
            hasRef: true,
          }),
          expect.objectContaining({
            role: 'button',
            name: 'L9:03 Contrast ratio warning',
            driverId: 'inspector.issue',
            intent: 'Selects issue and scrolls editor to line',
            hasRef: true,
          }),
          expect.objectContaining({
            role: 'button',
            name: 'L14:8 Unannotated row',
            hasRef: true,
          }),
          expect.objectContaining({
            role: 'textbox',
            name: 'Document source',
            driverId: 'editor.source',
            intent: 'Edits raw markdown and re-runs validation',
            hasRef: true,
            value: 'initial',
          }),
        ]),
      );
      // Child <span> inside cursor:pointer row must NOT be promoted as a duplicate button
      expect(report.legacyMatchCount).toBe(1);
      expect(report.completedSteps).toBe(3);
      expect(report.interruptedReason).toBeNull();
      expect(report.afterEditorValue).toBe('updated markdown');
      expect(report.afterStatus).toBe('issue-1,legacy');
    } finally {
      await harness.close();
    }
  });

  test('supports prefix-only driver:<prefix> scopes, unlabelled section/list data-driver landmarks, slash tokens, and rejects malformed data-driver values', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Prefix Driver Scopes & Semantic Containers',
      frameBodyHtml: [
        '<div id="plain-composer-wrapper">',
        '  <input id="comp-in" aria-label="Prompt" data-driver="composer.input" value="" />',
        '  <button id="comp-btn" type="button" data-driver="composer.submit">Send</button>',
        '</div>',
        '<section id="card" data-driver="workspace.card">',
        '  <a id="slash-link" data-driver="nav/home">Overview</a>',
        '  <button id="bad-drv" type="button" data-driver="invalid space!">Ignored Attr</button>',
        '</section>',
        '<ul id="todo-list" data-driver="checklist.list">',
        '  <li id="row-0" data-driver="checklist.row">Draft outline</li>',
        '  <li id="row-1" data-driver="checklist.row">Publish build</li>',
        '</ul>',
        '<output id="log">ready</output>',
        '<script>',
        '  const log = document.getElementById("log");',
        '  const seen = [];',
        '  document.getElementById("comp-btn").addEventListener("click", () => { seen.push("send:" + document.getElementById("comp-in").value); log.textContent = seen.join("|"); });',
        '  document.getElementById("row-1").addEventListener("click", () => { seen.push("row-1"); log.textContent = seen.join("|"); });',
        '</script>',
      ].join('\n'),
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const out = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const { createDriverTools } = await import('@inbrowser/driver/tools');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 480px; height: 360px; border: 0; display: block;';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);
        try {
          const tools = createDriverTools(driver);
          const obsTool = tools.find((t) => t.name === 'ui_observe')!;
          const prefixRes = await obsTool.execute({ scope: 'driver:composer' });
          const snap = await driver.observe();

          type Item = { role: string; name: string; hasRef: boolean; driverId?: string };
          const flat: Item[] = [];
          const walk = (nodes: typeof snap.elements): void => {
            for (const n of nodes) {
              flat.push({
                role: n.role,
                name: n.name,
                hasRef: n.ref !== undefined,
                ...(n.driverId !== undefined ? { driverId: n.driverId } : {}),
              });
              if (n.children) walk(n.children);
            }
          };
          walk(snap.elements);

          const actRes = await driver.act({
            rev: snap.rev,
            steps: [
              { kind: 'fill', target: { driver: 'composer.input' }, value: 'hello' },
              { kind: 'click', target: { driver: 'composer.submit' } },
              { kind: 'click', target: { driver: 'checklist.row', nth: 1 } },
            ],
          });

          const after = await driver.observe();
          const statusNode = after.elements.find((n) => n.role === 'status');
          return {
            prefixOk: prefixRes.ok,
            prefixSummary: prefixRes.summary,
            flat,
            completedSteps: actRes.completedSteps,
            statusText: statusNode?.name ?? '',
          };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      expect(out.prefixOk).toBe(true);
      expect(out.prefixSummary).toContain('[driver=composer.input]');
      expect(out.prefixSummary).toContain('[driver=composer.submit]');
      expect(out.flat).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'region', driverId: 'workspace.card', hasRef: true }),
          expect.objectContaining({
            role: 'button',
            name: 'Overview',
            driverId: 'nav/home',
            hasRef: true,
          }),
          expect.objectContaining({ role: 'list', driverId: 'checklist.list', hasRef: true }),
          expect.objectContaining({
            role: 'listitem',
            name: 'Draft outline',
            driverId: 'checklist.row',
            hasRef: true,
          }),
          expect.objectContaining({
            role: 'listitem',
            name: 'Publish build',
            driverId: 'checklist.row',
            hasRef: true,
          }),
        ]),
      );
      const ignoredBtn = out.flat.find((n) => n.name === 'Ignored Attr');
      expect(ignoredBtn?.driverId).toBeUndefined();
      expect(out.completedSteps).toBe(3);
      expect(out.statusText).toBe('send:hello|row-1');
    } finally {
      await harness.close();
    }
  });
});
