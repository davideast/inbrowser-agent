import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ActOptions,
  type ActResult,
  type CaptureOptions,
  type CaptureResult,
  type DriverCapabilities,
  DriverError,
  type DriverErrorCode,
  type EvalOptions,
  type EvalResult,
  type ObservationOptions,
  type ObservationSnapshot,
  type PageDriver,
  type SemanticFingerprint,
} from '@inbrowser/driver';
import { type ConnectionTransport, connectPuppeteerDriver } from '@inbrowser/driver/puppeteer';
import { type Page as PlaywrightPage, chromium, expect, test } from '@playwright/test';
import puppeteer, { type Browser as PuppeteerBrowser } from 'puppeteer-core';
import { startHarnessServer } from './fixtures/harness-server.js';
import { runDriverParitySuite } from './shared/driver-parity.js';

async function launchRealCdpChromium(): Promise<PuppeteerBrowser> {
  return puppeteer.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: ['--remote-debugging-port=0', '--no-sandbox'],
  });
}

interface HostBridgeOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: DriverErrorCode;
    readonly message: string;
    readonly candidates?: readonly SemanticFingerprint[];
  };
}

function unwrapHostBridgeOutcome<T>(outcome: HostBridgeOutcome): T {
  if (outcome.ok) {
    return outcome.result as T; // Invariant: ok===true guarantees T result from host iframe bridge
  }
  const err = outcome.error;
  throw new DriverError(err?.code ?? 'DRIVER_PROTOCOL', err?.message ?? 'Host bridge failure', {
    ...(err?.candidates !== undefined ? { candidates: err.candidates } : {}),
  });
}

async function createHostIframeDriverProxy(
  hostPage: PlaywrightPage,
  iframeSrc: string,
  allowEval: boolean,
): Promise<PageDriver> {
  const { handleKey, capabilities } = await hostPage.evaluate(
    async ({ src, evalAllowed }) => {
      const { connectIframe } = await import('@inbrowser/driver');
      const workspace = document.getElementById('workspace');
      if (!workspace) {
        throw new Error('Missing #workspace in host harness');
      }
      const iframe = document.createElement('iframe');
      iframe.style.width = '720px';
      iframe.style.height = '480px';
      iframe.src = src;
      workspace.appendChild(iframe);

      const drv = await connectIframe(iframe, {
        allowEval: evalAllowed,
        rpcTimeoutMs: 3_000,
      });
      const key = `__parity_drv_${Math.random().toString(36).slice(2)}`;
      Reflect.set(window, key, drv);
      return { handleKey: key, capabilities: drv.capabilities };
    },
    { src: iframeSrc, evalAllowed: allowEval },
  );

  const invokeInHost = async <T>(method: 'observe' | 'act' | 'eval', arg: unknown): Promise<T> => {
    const outcome = await hostPage.evaluate(
      async ({ key, m, payload }) => {
        const drv = Reflect.get(window, key) as PageDriver; // Invariant: PageDriver stored under handleKey above
        try {
          let res: unknown;
          if (m === 'observe') {
            res = await drv.observe(payload as ObservationOptions | undefined); // Invariant: observe payload forwarded from proxy
          } else if (m === 'act') {
            res = await drv.act(payload as ActOptions); // Invariant: act payload forwarded from proxy
          } else {
            res = await drv.eval(payload as EvalOptions); // Invariant: eval payload forwarded from proxy
          }
          return { ok: true, result: res };
        } catch (err: unknown) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            typeof Reflect.get(err, 'code') === 'string'
          ) {
            return {
              ok: false,
              error: {
                code: Reflect.get(err, 'code') as DriverErrorCode, // Invariant: DriverError code string verified above
                message:
                  typeof Reflect.get(err, 'message') === 'string'
                    ? (Reflect.get(err, 'message') as string) // Invariant: string narrowed above
                    : 'DriverError',
                ...(Array.isArray(Reflect.get(err, 'candidates'))
                  ? {
                      candidates: Reflect.get(err, 'candidates') as readonly SemanticFingerprint[], // Invariant: DriverError candidates array
                    }
                  : {}),
              },
            };
          }
          return {
            ok: false,
            error: {
              code: 'DRIVER_PROTOCOL' as const,
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
      { key: handleKey, m: method, payload: arg },
    );
    return unwrapHostBridgeOutcome<T>(outcome);
  };

  return {
    capabilities: capabilities as DriverCapabilities, // Invariant: DriverCapabilities returned by connectIframe
    async observe(options?: ObservationOptions): Promise<ObservationSnapshot> {
      const clean =
        options === undefined
          ? undefined
          : {
              ...(options.scope !== undefined ? { scope: options.scope } : {}),
              ...(options.includeAllText !== undefined
                ? { includeAllText: options.includeAllText }
                : {}),
            };
      return invokeInHost<ObservationSnapshot>('observe', clean);
    },
    async act(options: ActOptions): Promise<ActResult> {
      const clean: ActOptions = {
        rev: options.rev,
        steps: options.steps,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      };
      return invokeInHost<ActResult>('act', clean);
    },
    async capture(_options: CaptureOptions): Promise<CaptureResult> {
      throw new DriverError('DRIVER_UNSUPPORTED', 'Capture disabled in non-capture iframe parity');
    },
    async eval(options: EvalOptions): Promise<EvalResult> {
      const clean: EvalOptions = {
        expression: options.expression,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      };
      return invokeInHost<EvalResult>('eval', clean);
    },
    dispose(): void {
      void hostPage
        .evaluate((key) => {
          const drv: unknown = Reflect.get(window, key);
          if (typeof drv === 'object' && drv !== null && 'dispose' in drv) {
            const fn: unknown = Reflect.get(drv, 'dispose');
            if (typeof fn === 'function') {
              fn.call(drv);
            }
          }
        }, handleKey)
        .catch(() => {});
    },
  };
}

test.describe('@inbrowser/driver/puppeteer real-CDP backend', () => {
  test('validates connection options, selects target page, bootstraps preload on raw pages, gates eval, and disconnects without killing browser on dispose', async () => {
    const harness = await startHarnessServer({
      hostPort: 0,
      framePort: 0,
      frameRoutes: {
        '/raw-alpha': (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(`<!doctype html>
            <html lang="en">
              <head><meta charset="utf-8"><title>Alpha Tab</title></head>
              <body><main aria-label="alpha"><button type="button">Alpha Action</button></main></body>
            </html>`);
        },
        '/raw-beta': (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(`<!doctype html>
            <html lang="en">
              <head><meta charset="utf-8"><title>Beta Studio</title></head>
              <body>
                <main aria-label="studio">
                  <h1>Workspace Ready</h1>
                  <button type="button" id="play-btn">Play</button>
                </main>
              </body>
            </html>`);
        },
      },
    });

    const cdpBrowser = await launchRealCdpChromium();
    try {
      const wsEndpoint = cdpBrowser.wsEndpoint();

      // 1. Missing both browserWSEndpoint and transport -> DRIVER_PROTOCOL
      await expect(connectPuppeteerDriver({})).rejects.toMatchObject({
        name: 'DriverError',
        code: 'DRIVER_PROTOCOL',
      });

      // 2. Pre-aborted AbortSignal -> DRIVER_TIMEOUT
      const preAborted = new AbortController();
      preAborted.abort(new Error('cancelled before connect'));
      await expect(
        connectPuppeteerDriver({ browserWSEndpoint: wsEndpoint, signal: preAborted.signal }),
      ).rejects.toMatchObject({
        name: 'DriverError',
        code: 'DRIVER_TIMEOUT',
      });

      // 3. Unresolvable targetUrl filter -> DRIVER_TARGET_NOT_FOUND
      await expect(
        connectPuppeteerDriver({
          browserWSEndpoint: wsEndpoint,
          targetUrl: 'unmatched-tab-identifier',
        }),
      ).rejects.toMatchObject({
        name: 'DriverError',
        code: 'DRIVER_TARGET_NOT_FOUND',
      });

      // Open two uninstrumented raw pages in the external browser and select /raw-beta via targetUrl
      const alphaPage = await cdpBrowser.newPage();
      await alphaPage.goto(`${harness.frameOrigin}/raw-alpha`, { waitUntil: 'domcontentloaded' });
      const betaPage = await cdpBrowser.newPage();
      await betaPage.goto(`${harness.frameOrigin}/raw-beta`, { waitUntil: 'domcontentloaded' });

      const defaultDriver = await connectPuppeteerDriver({
        browserWSEndpoint: wsEndpoint,
        targetUrl: `${harness.frameOrigin}/raw-beta`,
      });

      expect(defaultDriver.capabilities).toEqual({
        protocolVersion: 1,
        allowEval: false,
        captureModes: ['viewport-gpu'],
        trustedInput: true,
      });

      const snap = await defaultDriver.observe();
      expect(snap.rev).toBe(1);
      expect(snap.title).toBe('Beta Studio');
      expect(snap.url).toBe(`${harness.frameOrigin}/raw-beta`);
      expect(snap.elements).toEqual([
        {
          role: 'main',
          name: 'studio',
          ref: 'e1',
          children: [
            { role: 'heading', name: 'Workspace Ready' },
            { role: 'button', name: 'Play', ref: 'e2' },
          ],
        },
      ]);

      await expect(defaultDriver.eval({ expression: 'document.title' })).rejects.toMatchObject({
        name: 'DriverError',
        code: 'DRIVER_EVAL_DISABLED',
      });

      defaultDriver.dispose();
      defaultDriver.dispose(); // idempotent

      // Disposing the driver only disconnects its CDP client; the external browser stays alive!
      expect(cdpBrowser.connected).toBe(true);

      let postDisposeErr: unknown;
      try {
        await defaultDriver.observe();
      } catch (err) {
        postDisposeErr = err;
      }
      expect(postDisposeErr).toBeInstanceOf(DriverError);
      expect((postDisposeErr as DriverError).code).toBe('DRIVER_DISPOSED'); // Invariant: narrowed via instanceof DriverError above

      // Reconnect with allowEval: true and verify sanitized eval + console diagnostics delta
      const evalDriver = await connectPuppeteerDriver({
        browserWSEndpoint: wsEndpoint,
        targetUrl: `${harness.frameOrigin}/raw-beta`,
        allowEval: true,
      });
      try {
        expect(evalDriver.capabilities.allowEval).toBe(true);
        const evalRes = await evalDriver.eval({
          expression: 'console.error("eval-diag-check"), ({ title: document.title, sum: 2 + 3 })',
        });
        expect(evalRes.value).toEqual({ title: 'Beta Studio', sum: 5 });
        expect(evalRes.diagnostics.consoleErrors).toContain('eval-diag-check');
      } finally {
        evalDriver.dispose();
      }
    } finally {
      await cdpBrowser.close();
      await harness.close();
    }
  });

  test('connects over a custom ConnectionTransport, dispatches genuine isTrusted===true CDP click input, and keeps dist/index.js + dist/tools.js free of puppeteer references', async () => {
    const [coreBundle, toolsBundle] = await Promise.all([
      readFile(path.resolve('dist/index.js'), 'utf8'),
      readFile(path.resolve('dist/tools.js'), 'utf8'),
    ]);
    expect(coreBundle.toLowerCase()).not.toContain('puppeteer');
    expect(toolsBundle.toLowerCase()).not.toContain('puppeteer');

    const harness = await startHarnessServer({
      hostPort: 0,
      framePort: 0,
      frameRoutes: {
        '/trusted-input': (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(`<!doctype html>
            <html lang="en">
              <head><meta charset="utf-8"><title>Trusted Input Check</title></head>
              <body>
                <main aria-label="stage">
                  <button type="button" id="arm-btn">Arm Output</button>
                  <output id="trust-status">waiting</output>
                </main>
                <script>
                  window.__clickEvents = [];
                  document.getElementById('arm-btn').addEventListener('click', (ev) => {
                    window.__clickEvents.push({
                      isTrusted: ev.isTrusted,
                      button: ev.button,
                      detail: ev.detail,
                    });
                    document.getElementById('trust-status').textContent =
                      ev.isTrusted ? 'trusted-click' : 'synthetic-click';
                  });
                </script>
              </body>
            </html>`);
        },
      },
    });

    const cdpBrowser = await launchRealCdpChromium();
    try {
      const wsEndpoint = cdpBrowser.wsEndpoint();
      const ws = new WebSocket(wsEndpoint);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
          once: true,
        });
      });

      let sentMessages = 0;
      let receivedMessages = 0;
      let transportClosed = false;

      const customTransport: ConnectionTransport = {
        send(message: string): void {
          sentMessages += 1;
          ws.send(message);
        },
        close(): void {
          transportClosed = true;
          ws.close();
        },
      };

      ws.addEventListener('message', (ev) => {
        receivedMessages += 1;
        customTransport.onmessage?.(typeof ev.data === 'string' ? ev.data : String(ev.data));
      });
      ws.addEventListener('close', () => {
        customTransport.onclose?.();
      });

      const driver = await connectPuppeteerDriver({
        transport: customTransport,
        targetUrl: `${harness.frameOrigin}/trusted-input`,
        allowEval: true,
      });

      try {
        expect(driver.capabilities.trustedInput).toBe(true);
        const snap = await driver.observe();
        const btnRef = snap.elements[0]?.children?.find((n) => n.role === 'button')?.ref;
        expect(btnRef).toBeDefined();

        const actRes = await driver.act({
          rev: snap.rev,
          steps: [{ kind: 'click', target: btnRef! }],
        });

        expect(actRes.completedSteps).toBe(1);
        expect(actRes.totalSteps).toBe(1);
        expect(actRes.interruptedReason).toBeUndefined();
        expect(actRes.diff.fullReset).toBe(false);
        expect(actRes.diff.changed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: 'status', name: 'trusted-click' }),
          ]),
        );

        const eventsEval = await driver.eval({ expression: 'window.__clickEvents' });
        expect(eventsEval.value).toEqual([{ isTrusted: true, button: 0, detail: 1 }]);
        expect(sentMessages).toBeGreaterThan(0);
        expect(receivedMessages).toBeGreaterThan(0);
      } finally {
        driver.dispose();
      }

      // browser.disconnect() triggers transport.close() asynchronously
      await expect.poll(() => transportClosed, { timeout: 2_000 }).toBe(true);
    } finally {
      await cdpBrowser.close();
      await harness.close();
    }
  });

  test('dispatches trusted CDP drag, keyboard chords, waitFor, and halts mid-batch on compile_error and DOM <dialog>', async () => {
    const harness = await startHarnessServer({
      hostPort: 0,
      framePort: 0,
      frameRoutes: {
        '/advanced-cdp': (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(`<!doctype html>
            <html lang="en">
              <head><meta charset="utf-8"><title>Advanced CDP Actions</title></head>
              <body>
                <main aria-label="canvas-lab" style="padding: 20px;">
                  <div
                    id="drag-handle"
                    role="button"
                    tabindex="0"
                    aria-label="Timeline Scrubber"
                    style="width: 48px; height: 32px; background: #2563eb; color: #fff;"
                  >Scrub</div>
                  <button type="button" id="delayed-spawn-btn">Spawn Toast</button>
                  <button type="button" id="open-modal-btn">Open Modal</button>
                  <button type="button" id="show-overlay-btn">Trigger Compile Error</button>
                  <button type="button" id="never-btn">Should Skip</button>
                  <dialog id="confirm-dialog" aria-label="Confirm Modal">
                    <p>Proceed with action?</p>
                  </dialog>
                  <output id="lab-status">ready</output>
                </main>
                <script>
                  window.__dragTrusted = [];
                  let dragging = false;
                  const handle = document.getElementById('drag-handle');
                  handle.addEventListener('pointerdown', (e) => {
                    dragging = true;
                    window.__dragTrusted.push(['down', e.isTrusted]);
                  });
                  window.addEventListener('pointerup', (e) => {
                    if (dragging) {
                      dragging = false;
                      window.__dragTrusted.push(['up', e.isTrusted]);
                    }
                  });
                  window.addEventListener('keydown', (e) => {
                    if (e.ctrlKey && e.key.toLowerCase() === 'k') {
                      e.preventDefault();
                      document.getElementById('lab-status').textContent =
                        e.isTrusted ? 'trusted-shortcut' : 'synthetic-shortcut';
                    }
                  });
                  document.getElementById('delayed-spawn-btn').addEventListener('click', () => {
                    setTimeout(() => {
                      const badge = document.createElement('div');
                      badge.setAttribute('role', 'status');
                      badge.textContent = 'Export Finished';
                      document.querySelector('main').appendChild(badge);
                    }, 35);
                  });
                  document.getElementById('open-modal-btn').addEventListener('click', () => {
                    document.getElementById('confirm-dialog').setAttribute('open', '');
                  });
                  document.getElementById('show-overlay-btn').addEventListener('click', () => {
                    const overlay = document.createElement('vite-error-overlay');
                    overlay.textContent = 'SyntaxError: Unexpected token (line 12)';
                    document.body.appendChild(overlay);
                  });
                  document.getElementById('never-btn').addEventListener('click', () => {
                    document.getElementById('lab-status').textContent = 'ran-skipped-step';
                  });
                </script>
              </body>
            </html>`);
        },
      },
    });

    const cdpBrowser = await launchRealCdpChromium();
    try {
      const driver = await connectPuppeteerDriver({
        browserWSEndpoint: cdpBrowser.wsEndpoint(),
        targetUrl: `${harness.frameOrigin}/advanced-cdp`,
        allowEval: true,
      });

      try {
        const snap = await driver.observe();

        // 1. Real CDP drag + Control+k chord + delayed waitFor
        const act1 = await driver.act({
          rev: snap.rev,
          steps: [
            {
              kind: 'drag',
              from: { role: 'button', name: 'Timeline Scrubber' },
              to: { deltaX: 90, deltaY: 0 },
              steps: 4,
            },
            { kind: 'press', key: 'Control+k' },
            { kind: 'click', target: { role: 'button', name: 'Spawn Toast' } },
            { kind: 'waitFor', text: 'Export Finished', state: 'visible', timeoutMs: 1_500 },
          ],
        });
        expect(act1.completedSteps).toBe(4);
        expect(act1.interruptedReason).toBeUndefined();

        const dragEvents = await driver.eval({ expression: 'window.__dragTrusted' });
        expect(dragEvents.value).toEqual([
          ['down', true],
          ['up', true],
        ]);
        const statusText = await driver.eval({
          expression: 'document.getElementById("lab-status").textContent',
        });
        expect(statusText.value).toBe('trusted-shortcut');

        // 2. DOM <dialog open> mid-batch halt
        const actModal = await driver.act({
          rev: act1.rev,
          steps: [
            { kind: 'click', target: { role: 'button', name: 'Open Modal' } },
            { kind: 'click', target: { role: 'button', name: 'Should Skip' } },
          ],
        });
        expect(actModal.completedSteps).toBe(1);
        expect(actModal.totalSteps).toBe(2);
        expect(actModal.interruptedReason).toBe('dialog_opened');

        // 3. Compile overlay mid-batch halt
        const actCompile = await driver.act({
          rev: actModal.rev,
          steps: [
            { kind: 'click', target: { role: 'button', name: 'Trigger Compile Error' } },
            { kind: 'click', target: { role: 'button', name: 'Should Skip' } },
          ],
        });
        expect(actCompile.completedSteps).toBe(1);
        expect(actCompile.totalSteps).toBe(2);
        expect(actCompile.interruptedReason).toBe('compile_error');
        expect(actCompile.diagnostics.compileOverlay).toContain('SyntaxError: Unexpected token');
      } finally {
        driver.dispose();
      }
    } finally {
      await cdpBrowser.close();
      await harness.close();
    }
  });
});

runDriverParitySuite({
  backendName: 'puppeteer-core real CDP',
  injectPreloadInHtml: false,
  supportsCapture: true,
  async createSession({ harness, initialPath, allowEval }) {
    const cdpBrowser = await launchRealCdpChromium();
    try {
      const driver = await connectPuppeteerDriver({
        browserWSEndpoint: cdpBrowser.wsEndpoint(),
        targetUrl: `${harness.frameOrigin}${initialPath}`,
        ...(allowEval !== undefined ? { allowEval } : {}),
      });
      return {
        driver,
        async cleanup(): Promise<void> {
          driver.dispose();
          await cdpBrowser.close();
        },
      };
    } catch (err) {
      await cdpBrowser.close();
      throw err;
    }
  },
});

runDriverParitySuite({
  backendName: 'connectIframe MessagePort',
  injectPreloadInHtml: true,
  supportsCapture: false,
  async createSession({ browser, harness, initialPath, allowEval }) {
    const hostPage = await browser.newPage();
    try {
      await hostPage.goto(`${harness.hostOrigin}/host`);
      const driver = await createHostIframeDriverProxy(
        hostPage,
        `${harness.frameOrigin}${initialPath}`,
        Boolean(allowEval),
      );
      return {
        driver,
        async cleanup(): Promise<void> {
          driver.dispose();
          await hostPage.close();
        },
      };
    } catch (err) {
      await hostPage.close();
      throw err;
    }
  },
});
