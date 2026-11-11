import { expect, test } from '@playwright/test';
import {
  loadPreloadSource,
  renderPreloadedHtmlDocument,
  startHarnessServer,
} from './fixtures/harness-server.js';

test.describe('cross-navigation MessagePort continuity', () => {
  test('re-handshakes across full-page <a href> and navigate/reload/back/forward transitions without hanging RPCs or losing PageDriver continuity', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Catalog Index Page',
      frameBodyHtml: `
        <main aria-label="catalog">
          <h1>Catalog Index</h1>
          <a id="details-link" href="/details"><span>Open Item Details</span></a>
          <button type="button" id="unreachable-btn">Unreachable Step</button>
        </main>
        <script>
          document.getElementById('details-link').addEventListener('click', () => {
            console.error('leaving-catalog-index');
          });
        </script>
      `,
      frameRoutes: {
        '/details': async (_req, res) => {
          // Intentional 55ms response delay verifies act() waits for document commit
          // rather than resolving prematurely on the outgoing page after 16ms settle.
          await new Promise((r) => setTimeout(r, 55));
          const preloadSource = await loadPreloadSource();
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(
            renderPreloadedHtmlDocument({
              title: 'Item Details Page',
              preloadSource,
              bodyHtml: `
                <main aria-label="item-details">
                  <h1>Item #108</h1>
                  <label for="review-note">Review Note</label>
                  <input id="review-note" type="text" value="" />
                  <button type="button" id="save-note">Save Note</button>
                  <output id="saved-status">unsaved</output>
                </main>
                <script>
                  console.error('booted-item-details');
                  document.getElementById('save-note').addEventListener('click', () => {
                    const v = document.getElementById('review-note').value;
                    document.getElementById('saved-status').textContent = 'saved:' + v;
                  });
                </script>
              `,
            }),
          );
        },
        '/summary': async (_req, res) => {
          const preloadSource = await loadPreloadSource();
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(
            renderPreloadedHtmlDocument({
              title: 'Order Summary Page',
              preloadSource,
              bodyHtml: `
                <main aria-label="summary">
                  <h1>Summary Ready</h1>
                  <button type="button" id="ping-summary">Confirm Summary</button>
                  <output id="summary-out">idle</output>
                </main>
                <script>
                  window.__loadStamp = Math.random().toString(36).slice(2);
                  document.getElementById('ping-summary').addEventListener('click', () => {
                    document.getElementById('summary-out').textContent = 'confirmed';
                  });
                </script>
              `,
            }),
          );
        },
      },
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const trace = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.style.width = '640px';
        iframe.style.height = '420px';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe, {
          allowEval: true,
          rpcTimeoutMs: 1_500,
        });

        try {
          const indexSnap = await driver.observe();

          // 1. Multi-step batch where step 0 clicks <a href="/details">:
          //    halts at step 0 with interruptedReason: 'navigation' and fullReset diff on /details
          const navMidBatch = await driver.act({
            rev: indexSnap.rev,
            steps: [
              { kind: 'click', target: { role: 'link', name: 'Open Item Details' } },
              { kind: 'click', target: { role: 'button', name: 'Unreachable Step' } },
            ],
          });

          // 2. Continue using the SAME PageDriver instance on /details!
          const detailsSnap = await driver.observe({ includeAllText: true });
          const editOnDetails = await driver.act({
            rev: detailsSnap.rev,
            steps: [
              { kind: 'fill', target: { role: 'textbox', name: 'Review Note' }, value: 'ship-it' },
              { kind: 'click', target: { role: 'button', name: 'Save Note' } },
            ],
          });
          const evalDetailsPath = await driver.eval({
            expression:
              '({ path: window.location.pathname, status: document.getElementById("saved-status").textContent })',
          });

          // 3. Final-step { kind: 'navigate', url: '/summary' } completes normally (no interruptedReason)
          const navFinalStep = await driver.act({
            rev: editOnDetails.rev,
            steps: [{ kind: 'navigate', url: '/summary' }],
          });
          const stampBeforeReload = (await driver.eval({ expression: 'window.__loadStamp' })).value;

          // 4. { action: 'reload' }, { action: 'back' }, and { action: 'forward' }
          const reloadRes = await driver.act({
            rev: navFinalStep.rev,
            steps: [{ kind: 'navigate', action: 'reload' }],
          });
          const stampAfterReload = (await driver.eval({ expression: 'window.__loadStamp' })).value;

          const backRes = await driver.act({
            rev: reloadRes.rev,
            steps: [{ kind: 'navigate', action: 'back' }],
          });

          const forwardRes = await driver.act({
            rev: backRes.rev,
            steps: [{ kind: 'navigate', action: 'forward' }],
          });

          const finalSummaryAct = await driver.act({
            rev: forwardRes.rev,
            steps: [{ kind: 'click', target: { role: 'button', name: 'Confirm Summary' } }],
          });
          const summaryConfirmed = (
            await driver.eval({
              expression: 'document.getElementById("summary-out").textContent',
            })
          ).value;

          return {
            indexRev: indexSnap.rev,
            navMidBatch,
            detailsRev: detailsSnap.rev,
            editOnDetailsRev: editOnDetails.rev,
            evalDetailsPath: evalDetailsPath.value,
            navFinalStep,
            stampBeforeReload,
            reloadRes,
            stampAfterReload,
            backRes,
            forwardRes,
            finalSummaryActRev: finalSummaryAct.rev,
            summaryConfirmed,
          };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      expect(trace.navMidBatch.completedSteps).toBe(1);
      expect(trace.navMidBatch.totalSteps).toBe(2);
      expect(trace.navMidBatch.interruptedReason).toBe('navigation');
      expect(trace.navMidBatch.url).toBe(`${harness.frameOrigin}/details`);
      expect(trace.navMidBatch.title).toBe('Item Details Page');
      expect(trace.navMidBatch.diff.fullReset).toBe(true);
      expect(trace.navMidBatch.diff.fromRev).toBe(trace.indexRev);
      expect(trace.navMidBatch.diagnostics.consoleErrors).toEqual(
        expect.arrayContaining(['leaving-catalog-index', 'booted-item-details']),
      );

      // Monotonic revisions across cross-document navigations!
      expect(trace.navMidBatch.rev).toBeGreaterThan(trace.indexRev);
      expect(trace.detailsRev).toBeGreaterThan(trace.navMidBatch.rev);
      expect(trace.editOnDetailsRev).toBeGreaterThan(trace.detailsRev);
      expect(trace.evalDetailsPath).toEqual({ path: '/details', status: 'saved:ship-it' });

      expect(trace.navFinalStep.completedSteps).toBe(1);
      expect(trace.navFinalStep.totalSteps).toBe(1);
      expect(trace.navFinalStep.interruptedReason).toBeUndefined();
      expect(trace.navFinalStep.url).toBe(`${harness.frameOrigin}/summary`);
      expect(trace.navFinalStep.diff.fullReset).toBe(true);

      expect(trace.reloadRes.interruptedReason).toBeUndefined();
      expect(trace.stampAfterReload).not.toBe(trace.stampBeforeReload);
      expect(trace.reloadRes.rev).toBeGreaterThan(trace.navFinalStep.rev);

      expect(trace.backRes.url).toBe(`${harness.frameOrigin}/details`);
      expect(trace.backRes.rev).toBeGreaterThan(trace.reloadRes.rev);

      expect(trace.forwardRes.url).toBe(`${harness.frameOrigin}/summary`);
      expect(trace.forwardRes.rev).toBeGreaterThan(trace.backRes.rev);
      expect(trace.finalSummaryActRev).toBeGreaterThan(trace.forwardRes.rev);
      expect(trace.summaryConfirmed).toBe('confirmed');
    } finally {
      await harness.close();
    }
  });

  test('supports custom MessagePort replacement via ConnectPortOptions.onPortReplacement and unsubscribes on dispose', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Port Bridge Start',
      frameBodyHtml: '<main aria-label="bridge"><a href="/next">Next Page</a></main>',
      frameRoutes: {
        '/next': async (_req, res) => {
          const preloadSource = await loadPreloadSource();
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(
            renderPreloadedHtmlDocument({
              title: 'Port Bridge Next',
              preloadSource,
              bodyHtml:
                '<main aria-label="bridge-next"><button type="button" id="ok">Done</button></main>',
            }),
          );
        },
      },
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const result = await page.evaluate(async (frameOrigin) => {
        const { connectPort, DRIVER_CHANNEL, PROTOCOL_VERSION } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);
        await new Promise<void>((r) => iframe.addEventListener('load', () => r(), { once: true }));

        const bindFreshChannel = (): MessagePort => {
          const ch = new MessageChannel();
          iframe.contentWindow!.postMessage(
            { channel: DRIVER_CHANNEL, kind: 'bind_port', protocolVersion: PROTOCOL_VERSION },
            frameOrigin,
            [ch.port2],
          );
          return ch.port1;
        };

        let unsubscribed = false;
        const driver = await connectPort(bindFreshChannel(), {
          rpcTimeoutMs: 1_500,
          onPortReplacement(rebind) {
            const onLoad = (): void => {
              rebind(bindFreshChannel());
            };
            iframe.addEventListener('load', onLoad);
            return () => {
              unsubscribed = true;
              iframe.removeEventListener('load', onLoad);
            };
          },
        });

        const s0 = await driver.observe();
        const navRes = await driver.act({
          rev: s0.rev,
          steps: [{ kind: 'click', target: { role: 'link', name: 'Next Page' } }],
        });
        const s1 = await driver.observe();
        driver.dispose();

        return {
          navUrl: navRes.url,
          navFullReset: navRes.diff.fullReset,
          nextTitle: s1.title,
          nextRevGreater: s1.rev > s0.rev,
          unsubscribed,
        };
      }, harness.frameOrigin);

      expect(result).toEqual({
        navUrl: `${harness.frameOrigin}/next`,
        navFullReset: true,
        nextTitle: 'Port Bridge Next',
        nextRevGreater: true,
        unsubscribed: true,
      });
    } finally {
      await harness.close();
    }
  });
});
