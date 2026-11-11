import { expect, test } from '@playwright/test';
import {
  loadPreloadSource,
  renderPreloadedHtmlDocument,
  startHarnessServer,
} from './fixtures/harness-server.js';

test.describe('cross-origin MessageChannel foundation', () => {
  test('establishes a 1-RTT cross-origin MessageChannel handshake via connectIframe and connectPort', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameRoutes: {
        '/frame-delayed': async (_req, res) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const preloadSource = await loadPreloadSource();
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(
            renderPreloadedHtmlDocument({
              title: 'Delayed Workspace',
              bodyHtml: '<main aria-label="timeline"></main>',
              preloadSource,
            }),
          );
        },
      },
    });
    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const handshakeSummary = await page.evaluate(async (frameOrigin) => {
        const driverMod = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) {
          throw new Error('Missing #workspace container');
        }

        // Delayed cross-origin iframe verifies connectIframe completes cleanly even when
        // called while iframe.contentWindow is still on initial about:blank pre-commit.
        const delayedIframe = document.createElement('iframe');
        delayedIframe.src = `${frameOrigin}/frame-delayed`;
        workspace.appendChild(delayedIframe);
        const delayedDriver = await driverMod.connectIframe(delayedIframe);
        const delayedCaps = delayedDriver.capabilities;
        delayedDriver.dispose();

        const iframe = document.createElement('iframe');
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        // Wait for load first so connectIframe exercises the single-message 1-RTT path.
        await new Promise<void>((resolve) => {
          iframe.addEventListener('load', () => resolve(), { once: true });
        });

        const defaultDriver = await driverMod.connectIframe(iframe);
        const defaultCaps = defaultDriver.capabilities;
        defaultDriver.dispose();

        // Also verify direct connectPort with allowEval: true via bind_port transfer.
        const channel = new MessageChannel();
        if (!iframe.contentWindow) {
          throw new Error('Missing iframe contentWindow');
        }
        iframe.contentWindow.postMessage(
          {
            channel: driverMod.DRIVER_CHANNEL,
            kind: 'bind_port',
            protocolVersion: driverMod.PROTOCOL_VERSION,
          },
          frameOrigin,
          [channel.port2],
        );

        const evalEnabledDriver = await driverMod.connectPort(channel.port1, {
          allowEval: true,
        });
        const evalCaps = evalEnabledDriver.capabilities;
        evalEnabledDriver.dispose();

        return {
          hostOrigin: window.origin,
          frameOrigin,
          delayedCaps,
          defaultCaps,
          evalCaps,
        };
      }, harness.frameOrigin);

      expect(handshakeSummary.hostOrigin).not.toBe(handshakeSummary.frameOrigin);
      expect(handshakeSummary.delayedCaps.protocolVersion).toBe(1);
      expect(handshakeSummary.defaultCaps).toEqual({
        protocolVersion: 1,
        allowEval: false,
        captureModes: ['silent'],
        trustedInput: false,
      });
      expect(handshakeSummary.evalCaps).toEqual({
        protocolVersion: 1,
        allowEval: true,
        captureModes: ['silent'],
        trustedInput: false,
      });
    } finally {
      await harness.close();
    }
  });

  test('round-trips RPC calls across cross-origin MessagePort with coded DriverError propagation and saved preload intrinsics', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameBodyHtml:
        '<main aria-label="player"><button type="button">Play</button></main>' +
        '<script>' +
        'MessagePort.prototype.postMessage = () => { throw new Error("tampered guest postMessage"); };' +
        'window.MessageEvent = class FakeMessageEvent {};' +
        'Function.prototype.call = () => { throw new Error("tampered guest Function.prototype.call"); };' +
        '</script>',
    });
    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const rpcOutcomes = await page.evaluate(async (frameOrigin) => {
        const { connectIframe, DriverError } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) {
          throw new Error('Missing #workspace container');
        }

        const iframe = document.createElement('iframe');
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe, { allowEval: false });

        async function captureDriverError(
          op: () => Promise<unknown>,
        ): Promise<{ code: string; message: string }> {
          try {
            await op();
            return { code: 'NO_ERROR', message: '' };
          } catch (err) {
            if (err instanceof DriverError) {
              return { code: err.code, message: err.message };
            }
            return {
              code: 'UNEXPECTED',
              message: err instanceof Error ? err.message : String(err),
            };
          }
        }

        const evalDisabled = await captureDriverError(() =>
          driver.eval({ expression: 'document.title' }),
        );
        const observed = await driver.observe({ scope: 'main' });
        const actResult = await driver.act({
          rev: observed.rev,
          steps: [{ kind: 'click', target: 'e2' }],
        });
        const captureResult = await driver.capture({ mode: 'screenshot', format: 'webp' });
        driver.dispose();

        const evalDriver = await connectIframe(iframe, { allowEval: true });
        const evalResult = await evalDriver.eval({ expression: 'document.title' });
        evalDriver.dispose();

        return {
          evalDisabled,
          observed,
          actResult,
          captureSummary: {
            mimeType: captureResult.mimeType,
            byteLength: captureResult.bytes.byteLength,
            modeUsed: captureResult.modeUsed,
          },
          evalResult,
        };
      }, harness.frameOrigin);

      expect(rpcOutcomes.evalDisabled.code).toBe('DRIVER_EVAL_DISABLED');
      expect(rpcOutcomes.evalDisabled.message).toContain('allowEval');
      expect(rpcOutcomes.observed.rev).toBe(1);
      expect(rpcOutcomes.observed.elements).toEqual([
        {
          role: 'main',
          name: 'player',
          ref: 'e1',
          children: [
            {
              role: 'button',
              name: 'Play',
              ref: 'e2',
            },
          ],
        },
      ]);
      expect(rpcOutcomes.actResult.completedSteps).toBe(1);
      expect(rpcOutcomes.actResult.interruptedReason).toBeUndefined();
      expect(rpcOutcomes.captureSummary.mimeType).toBe('image/webp');
      expect(rpcOutcomes.captureSummary.byteLength).toBeGreaterThan(0);
      expect(rpcOutcomes.captureSummary.modeUsed).toBe('silent');
      expect(rpcOutcomes.evalResult.value).toBe('Timeline Player Preview');
    } finally {
      await harness.close();
    }
  });

  test('enforces handshakeTimeoutMs, rpcTimeoutMs, AbortSignal cancellation, and DRIVER_DISPOSED teardown', async ({
    page,
  }) => {
    const harness = await startHarnessServer();
    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const lifecycleSummary = await page.evaluate(async (frameOrigin) => {
        const { connectIframe, connectPort, DRIVER_CHANNEL, DriverError, PROTOCOL_VERSION } =
          await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) {
          throw new Error('Missing #workspace container');
        }

        async function raceWithGuard<T>(promise: Promise<T>, guardMs: number): Promise<T> {
          return Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error(`Guarded operation hung > ${guardMs}ms`)), guardMs);
            }),
          ]);
        }

        async function captureCode(op: () => Promise<unknown>, guardMs = 500): Promise<string> {
          try {
            await raceWithGuard(op(), guardMs);
            return 'NO_ERROR';
          } catch (err) {
            if (err instanceof DriverError) {
              return err.code;
            }
            return `UNEXPECTED:${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // 1. Handshake timeout against cross-origin frame without preload
        const bareIframe = document.createElement('iframe');
        bareIframe.src = `${frameOrigin}/frame-uninstrumented`;
        workspace.appendChild(bareIframe);
        const uninstrumentedHandshakeCode = await captureCode(() =>
          connectIframe(bareIframe, { handshakeTimeoutMs: 80 }),
        );

        // 2. Peer MessagePort that completes hello_ack and then intentionally stalls RPCs
        function createStallingPeerChannel(): MessagePort {
          const channel = new MessageChannel();
          channel.port2.addEventListener('message', (event: MessageEvent<unknown>) => {
            const data = event.data;
            if (
              typeof data === 'object' &&
              data !== null &&
              'kind' in data &&
              data.kind === 'hello'
            ) {
              channel.port2.postMessage({
                channel: DRIVER_CHANNEL,
                kind: 'hello_ack',
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {
                  protocolVersion: PROTOCOL_VERSION,
                  allowEval: true,
                  captureModes: ['silent'],
                  trustedInput: false,
                },
              });
            }
          });
          channel.port2.start();
          return channel.port1;
        }

        const stalledPort = createStallingPeerChannel();
        const stalledDriver = await connectPort(stalledPort, { rpcTimeoutMs: 70 });

        // 2a. rpcTimeoutMs triggers DRIVER_TIMEOUT
        const stalledRpcCode = await captureCode(() => stalledDriver.observe());

        // 2b. Pre-aborted AbortSignal rejects immediately
        const preAborted = new AbortController();
        preAborted.abort(new Error('already cancelled'));
        const preAbortedCode = await captureCode(() =>
          stalledDriver.observe({ signal: preAborted.signal }),
        );

        // 2c. Mid-flight AbortSignal cancels before a 5_000ms rpcTimeoutMs
        const slowPort = createStallingPeerChannel();
        const slowDriver = await connectPort(slowPort, { rpcTimeoutMs: 5_000 });
        const midFlightController = new AbortController();
        setTimeout(() => midFlightController.abort(new Error('cancelled mid-flight')), 30);
        const midFlightStart = performance.now();
        const midFlightAbortCode = await captureCode(
          () => slowDriver.observe({ signal: midFlightController.signal }),
          500,
        );
        const midFlightElapsedMs = performance.now() - midFlightStart;

        // 2d. dispose() immediately rejects in-flight pending RPCs AND subsequent calls with DRIVER_DISPOSED
        const inFlightPromise = slowDriver.act({
          rev: 1,
          steps: [{ kind: 'click', target: 'e1' }],
        });
        slowDriver.dispose();
        slowDriver.dispose(); // Idempotent second call
        stalledDriver.dispose();

        const inFlightDisposeCode = await captureCode(() => inFlightPromise);
        const postDisposeObserveCode = await captureCode(() => slowDriver.observe());
        const postDisposeCaptureCode = await captureCode(() =>
          slowDriver.capture({ mode: 'screenshot' }),
        );
        const postDisposeEvalCode = await captureCode(() =>
          slowDriver.eval({ expression: '1 + 1' }),
        );

        return {
          uninstrumentedHandshakeCode,
          stalledRpcCode,
          preAbortedCode,
          midFlightAbortCode,
          midFlightCancelledQuickly: midFlightElapsedMs < 400,
          inFlightDisposeCode,
          postDisposeObserveCode,
          postDisposeCaptureCode,
          postDisposeEvalCode,
        };
      }, harness.frameOrigin);

      expect(lifecycleSummary).toEqual({
        uninstrumentedHandshakeCode: 'DRIVER_TIMEOUT',
        stalledRpcCode: 'DRIVER_TIMEOUT',
        preAbortedCode: 'DRIVER_TIMEOUT',
        midFlightAbortCode: 'DRIVER_TIMEOUT',
        midFlightCancelledQuickly: true,
        inFlightDisposeCode: 'DRIVER_DISPOSED',
        postDisposeObserveCode: 'DRIVER_DISPOSED',
        postDisposeCaptureCode: 'DRIVER_DISPOSED',
        postDisposeEvalCode: 'DRIVER_DISPOSED',
      });
    } finally {
      await harness.close();
    }
  });
});
