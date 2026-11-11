import { DriverError, type PageDriver, type SnapshotNode } from '@inbrowser/driver';
import { type Browser as PlaywrightBrowser, expect, test } from '@playwright/test';
import {
  type HarnessServer,
  loadPreloadSource,
  renderPreloadedHtmlDocument,
  startHarnessServer,
} from '../fixtures/harness-server.js';

export interface ParityDriverSession {
  readonly driver: PageDriver;
  cleanup(): Promise<void>;
}

export interface DriverParitySuiteOptions {
  readonly backendName: string;
  readonly injectPreloadInHtml: boolean;
  readonly supportsCapture: boolean;
  createSession(context: {
    readonly browser: PlaywrightBrowser;
    readonly harness: HarnessServer;
    readonly initialPath: string;
    readonly allowEval?: boolean;
  }): Promise<ParityDriverSession>;
}

function findNodeByRole(
  nodes: readonly SnapshotNode[],
  role: string,
  name?: string,
): SnapshotNode | undefined {
  for (const node of nodes) {
    if (node.role === role && (name === undefined || node.name === name)) {
      return node;
    }
    if (node.children !== undefined) {
      const nested = findNodeByRole(node.children, role, name);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

export function runDriverParitySuite(suiteOptions: DriverParitySuiteOptions): void {
  test.describe(`PageDriver parity suite [${suiteOptions.backendName}]`, () => {
    test('observes semantic ARIA tree, open Shadow DOM, media/canvas state, and drains diagnostics deltas', async ({
      browser,
    }) => {
      const preloadSource = suiteOptions.injectPreloadInHtml
        ? await loadPreloadSource()
        : undefined;

      const harness = await startHarnessServer({
        hostPort: 0,
        framePort: 0,
        frameRoutes: {
          '/parity-observe': (_req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(
              renderPreloadedHtmlDocument({
                title: 'Inspector View',
                ...(preloadSource !== undefined ? { preloadSource } : {}),
                bodyHtml: `
                  <main aria-label="inspector">
                    <h1>Asset Review</h1>
                    <canvas id="waveform-canvas" width="80" height="40" aria-label="Waveform Canvas"></canvas>
                    <video id="clip-player" width="160" height="90" aria-label="Clip Player"></video>
                    <div id="shadow-host"></div>
                    <button type="button" id="emit-diag-btn">Emit Diagnostics</button>
                  </main>
                  <script>
                    const canvas = document.getElementById('waveform-canvas');
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#0f766e';
                    ctx.fillRect(4, 4, 72, 32);

                    const host = document.getElementById('shadow-host');
                    const shadow = host.attachShadow({ mode: 'open' });
                    const shadowBtn = document.createElement('button');
                    shadowBtn.type = 'button';
                    shadowBtn.textContent = 'Shadow Action';
                    shadow.appendChild(shadowBtn);

                    document.getElementById('emit-diag-btn').addEventListener('click', () => {
                      console.error('parity-console-error');
                      void fetch('/missing-resource-404');
                      setTimeout(() => {
                        Promise.reject(new Error('parity-unhandled-rejection'));
                      }, 0);
                    });
                  </script>
                `,
              }),
            );
          },
          '/missing-resource-404': (_req, res) => {
            res.writeHead(404, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end('Missing item');
          },
        },
      });

      const session = await suiteOptions.createSession({
        browser,
        harness,
        initialPath: '/parity-observe',
      });
      try {
        const snap1 = await session.driver.observe();
        expect(snap1.rev).toBe(1);
        expect(snap1.title).toBe('Inspector View');

        const mainNode = findNodeByRole(snap1.elements, 'main', 'inspector');
        expect(mainNode?.ref).toBeDefined();
        expect(findNodeByRole(snap1.elements, 'heading', 'Asset Review')).toBeDefined();

        const canvasNode = findNodeByRole(snap1.elements, 'canvas', 'Waveform Canvas');
        expect(canvasNode?.canvas).toEqual({ width: 80, height: 40, nonBlank: true });

        const videoNode = findNodeByRole(snap1.elements, 'video', 'Clip Player');
        expect(videoNode?.media).toMatchObject({
          kind: 'video',
          paused: true,
          width: 160,
          height: 90,
        });

        const shadowBtn = findNodeByRole(snap1.elements, 'button', 'Shadow Action');
        expect(shadowBtn?.ref).toBeDefined();

        const diagBtn = findNodeByRole(snap1.elements, 'button', 'Emit Diagnostics');
        expect(diagBtn?.ref).toBeDefined();

        const actRes = await session.driver.act({
          rev: snap1.rev,
          steps: [{ kind: 'click', target: diagBtn!.ref! }],
        });
        expect(actRes.completedSteps).toBe(1);

        // Allow microtask/timer rejection + 404 fetch to settle if not already drained in actRes
        await new Promise((r) => setTimeout(r, 40));
        const snap2 = await session.driver.observe();

        const combinedConsole = [
          ...actRes.diagnostics.consoleErrors,
          ...snap2.diagnostics.consoleErrors,
        ];
        const combinedPageErrors = [
          ...actRes.diagnostics.pageErrors,
          ...snap2.diagnostics.pageErrors,
        ];
        const combinedNet = [
          ...actRes.diagnostics.networkFailures,
          ...snap2.diagnostics.networkFailures,
        ];

        expect(combinedConsole).toContain('parity-console-error');
        expect(combinedPageErrors.some((msg) => msg.includes('parity-unhandled-rejection'))).toBe(
          true,
        );
        expect(combinedNet).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              method: 'GET',
              status: 404,
            }),
          ]),
        );

        // Subsequent observe() drains empty deltas
        const snap3 = await session.driver.observe();
        expect(snap3.diagnostics.consoleErrors).toEqual([]);
        expect(snap3.diagnostics.pageErrors).toEqual([]);
        expect(snap3.diagnostics.networkFailures).toEqual([]);
      } finally {
        await session.cleanup();
        await harness.close();
      }
    });

    test('self-heals [ref=eN] across DOM node replacement and reports candidates on DRIVER_TARGET_AMBIGUOUS', async ({
      browser,
    }) => {
      const preloadSource = suiteOptions.injectPreloadInHtml
        ? await loadPreloadSource()
        : undefined;

      const harness = await startHarnessServer({
        hostPort: 0,
        framePort: 0,
        frameRoutes: {
          '/parity-refs': (_req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(
              renderPreloadedHtmlDocument({
                title: 'Ref Healing Workspace',
                ...(preloadSource !== undefined ? { preloadSource } : {}),
                bodyHtml: `
                  <main aria-label="editor">
                    <div id="toolbar-slot">
                      <button type="button" class="save-action">Save Draft</button>
                    </div>
                    <button type="button" id="remount-btn">Remount Toolbar</button>
                    <button type="button" id="duplicate-btn">Insert Second Save</button>
                    <output id="save-counter">saves:0</output>
                  </main>
                  <script>
                    let saves = 0;
                    function wireButtons(root) {
                      for (const btn of root.querySelectorAll('.save-action')) {
                        btn.onclick = () => {
                          saves += 1;
                          document.getElementById('save-counter').textContent = 'saves:' + saves;
                        };
                      }
                    }
                    wireButtons(document);

                    document.getElementById('remount-btn').addEventListener('click', () => {
                      const slot = document.getElementById('toolbar-slot');
                      slot.innerHTML = '<button type="button" class="save-action">Save Draft</button>';
                      wireButtons(slot);
                    });

                    document.getElementById('duplicate-btn').addEventListener('click', () => {
                      const slot = document.getElementById('toolbar-slot');
                      slot.innerHTML =
                        '<button type="button" class="save-action">Save Draft</button>' +
                        '<button type="button" class="save-action">Save Draft</button>';
                      wireButtons(slot);
                    });
                  </script>
                `,
              }),
            );
          },
        },
      });

      const session = await suiteOptions.createSession({
        browser,
        harness,
        initialPath: '/parity-refs',
      });
      try {
        const initialSnap = await session.driver.observe();
        const saveRef = findNodeByRole(initialSnap.elements, 'button', 'Save Draft')?.ref;
        const remountRef = findNodeByRole(initialSnap.elements, 'button', 'Remount Toolbar')?.ref;
        const duplicateRef = findNodeByRole(
          initialSnap.elements,
          'button',
          'Insert Second Save',
        )?.ref;
        expect(saveRef).toBeDefined();
        expect(remountRef).toBeDefined();
        expect(duplicateRef).toBeDefined();

        // Replace the underlying <button> DOM node completely, then click the original saveRef without re-observing
        const remountRes = await session.driver.act({
          rev: initialSnap.rev,
          steps: [
            { kind: 'click', target: remountRef! },
            { kind: 'click', target: saveRef! },
          ],
        });
        expect(remountRes.completedSteps).toBe(2);
        expect(remountRes.interruptedReason).toBeUndefined();
        expect(findNodeByRole(remountRes.diff.changed, 'status', 'saves:1')).toBeDefined();

        // Now detach saveRef's WeakRef AND introduce a duplicate twin in the same landmark cohort
        const dupRes = await session.driver.act({
          rev: remountRes.rev,
          steps: [{ kind: 'click', target: duplicateRef! }],
        });
        expect(dupRes.completedSteps).toBe(1);

        // Stale saveRef now faces 2 identical candidates where cohortSize was 1 -> DRIVER_TARGET_AMBIGUOUS
        const ambiguousRefAct = await session.driver.act({
          rev: dupRes.rev,
          steps: [{ kind: 'click', target: saveRef! }],
          timeoutMs: 800,
        });
        expect(ambiguousRefAct.completedSteps).toBe(0);
        expect(ambiguousRefAct.interruptedReason).toBe('step_error');
        expect(ambiguousRefAct.error).toContain('DRIVER_TARGET_AMBIGUOUS');
        expect(ambiguousRefAct.error).toContain('Save Draft');

        // Role query without nth also surfaces DRIVER_TARGET_AMBIGUOUS
        const ambiguousRoleAct = await session.driver.act({
          rev: ambiguousRefAct.rev,
          steps: [{ kind: 'click', target: { role: 'button', name: 'Save Draft' } }],
          timeoutMs: 800,
        });
        expect(ambiguousRoleAct.completedSteps).toBe(0);
        expect(ambiguousRoleAct.interruptedReason).toBe('step_error');
        expect(ambiguousRoleAct.error).toContain('DRIVER_TARGET_AMBIGUOUS');

        if (suiteOptions.supportsCapture) {
          let captureErr: unknown;
          try {
            await session.driver.capture({
              mode: 'screenshot',
              target: { role: 'button', name: 'Save Draft' },
            });
          } catch (err) {
            captureErr = err;
          }
          expect(captureErr).toBeInstanceOf(DriverError);
          const typedErr = captureErr as DriverError; // Invariant: narrowed via instanceof DriverError above
          expect(typedErr.code).toBe('DRIVER_TARGET_AMBIGUOUS');
          expect(typedErr.candidates).toHaveLength(2);
        }
      } finally {
        await session.cleanup();
        await harness.close();
      }
    });

    test('executes multi-step transactional act() batches and halts on step_error and dialog_opened with partial progress', async ({
      browser,
    }) => {
      const preloadSource = suiteOptions.injectPreloadInHtml
        ? await loadPreloadSource()
        : undefined;

      const harness = await startHarnessServer({
        hostPort: 0,
        framePort: 0,
        frameRoutes: {
          '/parity-act': (_req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(
              renderPreloadedHtmlDocument({
                title: 'Transactional Form',
                ...(preloadSource !== undefined ? { preloadSource } : {}),
                bodyHtml: `
                  <main aria-label="settings">
                    <label for="item-title">Item Title</label>
                    <input id="item-title" type="text" value="Initial" />

                    <label for="tier-select">Tier</label>
                    <select id="tier-select">
                      <option value="starter">Starter</option>
                      <option value="scale">Scale</option>
                    </select>

                    <label for="level-range">Level</label>
                    <input id="level-range" type="range" min="0" max="100" value="20" />

                    <button type="button" id="apply-btn">Apply Changes</button>
                    <button type="button" id="alert-btn">Open Alert</button>
                    <button type="button" id="unreachable-btn">Unreachable Action</button>
                    <output id="applied-summary">idle</output>
                  </main>
                  <script>
                    document.getElementById('apply-btn').addEventListener('click', () => {
                      const title = document.getElementById('item-title').value;
                      const tier = document.getElementById('tier-select').value;
                      const level = document.getElementById('level-range').value;
                      document.getElementById('applied-summary').textContent =
                        title + ':' + tier + ':' + level;
                    });
                    document.getElementById('alert-btn').addEventListener('click', () => {
                      document.getElementById('applied-summary').textContent = 'alert-triggered';
                      window.alert('Confirm Archive');
                    });
                    document.getElementById('unreachable-btn').addEventListener('click', () => {
                      document.getElementById('applied-summary').textContent = 'should-not-execute';
                    });
                  </script>
                `,
              }),
            );
          },
        },
      });

      const session = await suiteOptions.createSession({
        browser,
        harness,
        initialPath: '/parity-act',
      });
      try {
        const snap = await session.driver.observe();

        // 1. Full multi-step batch: fill + select + setValue + click
        const batchOk = await session.driver.act({
          rev: snap.rev,
          steps: [
            { kind: 'fill', target: { role: 'textbox', name: 'Item Title' }, value: 'Launch Plan' },
            { kind: 'select', target: { role: 'combobox', name: 'Tier' }, value: 'scale' },
            { kind: 'setValue', target: { role: 'slider', name: 'Level' }, value: 85 },
            { kind: 'click', target: { role: 'button', name: 'Apply Changes' } },
          ],
        });
        expect(batchOk.completedSteps).toBe(4);
        expect(batchOk.totalSteps).toBe(4);
        expect(batchOk.interruptedReason).toBeUndefined();
        expect(
          findNodeByRole(batchOk.diff.changed, 'status', 'Launch Plan:scale:85'),
        ).toBeDefined();

        // 2. Mid-batch step_error preserves step 0 mutation and halts before step 2
        const batchStepErr = await session.driver.act({
          rev: batchOk.rev,
          steps: [
            {
              kind: 'fill',
              target: { role: 'textbox', name: 'Item Title' },
              value: 'Partial Draft',
            },
            { kind: 'click', target: 'e999' },
            { kind: 'click', target: { role: 'button', name: 'Unreachable Action' } },
          ],
          timeoutMs: 600,
        });
        expect(batchStepErr.completedSteps).toBe(1);
        expect(batchStepErr.totalSteps).toBe(3);
        expect(batchStepErr.interruptedReason).toBe('step_error');
        expect(batchStepErr.error).toContain('DRIVER_TARGET_NOT_FOUND');
        const changedInput = findNodeByRole(batchStepErr.diff.changed, 'textbox', 'Item Title');
        expect(changedInput?.value).toBe('Partial Draft');

        // 3. Mid-batch native alert() auto-dismisses and halts with dialog_opened before step 1
        const batchDialog = await session.driver.act({
          rev: batchStepErr.rev,
          steps: [
            { kind: 'click', target: { role: 'button', name: 'Open Alert' } },
            { kind: 'click', target: { role: 'button', name: 'Unreachable Action' } },
          ],
        });
        expect(batchDialog.completedSteps).toBe(1);
        expect(batchDialog.totalSteps).toBe(2);
        expect(batchDialog.interruptedReason).toBe('dialog_opened');
        expect(batchDialog.diagnostics.consoleErrors).toContain('[dialog:alert] Confirm Archive');
        expect(findNodeByRole(batchDialog.diff.changed, 'status', 'alert-triggered')).toBeDefined();
      } finally {
        await session.cleanup();
        await harness.close();
      }
    });

    test('gates eval() on allowEval and returns sanitized values plus diagnostics when enabled', async ({
      browser,
    }) => {
      const preloadSource = suiteOptions.injectPreloadInHtml
        ? await loadPreloadSource()
        : undefined;

      const harness = await startHarnessServer({
        hostPort: 0,
        framePort: 0,
        frameRoutes: {
          '/parity-eval': (_req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(
              renderPreloadedHtmlDocument({
                title: 'Eval Sandbox',
                ...(preloadSource !== undefined ? { preloadSource } : {}),
                bodyHtml: `<main aria-label="sandbox"><button type="button">One</button><button type="button">Two</button></main>`,
              }),
            );
          },
        },
      });

      const lockedSession = await suiteOptions.createSession({
        browser,
        harness,
        initialPath: '/parity-eval',
        allowEval: false,
      });
      try {
        expect(lockedSession.driver.capabilities.allowEval).toBe(false);
        await expect(
          lockedSession.driver.eval({ expression: 'document.title' }),
        ).rejects.toMatchObject({
          name: 'DriverError',
          code: 'DRIVER_EVAL_DISABLED',
        });
      } finally {
        await lockedSession.cleanup();
      }

      const unlockedSession = await suiteOptions.createSession({
        browser,
        harness,
        initialPath: '/parity-eval',
        allowEval: true,
      });
      try {
        expect(unlockedSession.driver.capabilities.allowEval).toBe(true);
        const res = await unlockedSession.driver.eval({
          expression:
            'console.error("parity-eval-diag"), ({ title: document.title, buttons: document.querySelectorAll("button").length, bodyNode: document.body })',
        });
        expect(res.diagnostics.consoleErrors).toContain('parity-eval-diag');
        expect(res.value).toMatchObject({
          title: 'Eval Sandbox',
          buttons: 2,
        });
      } finally {
        await unlockedSession.cleanup();
        await harness.close();
      }
    });

    test('preserves PageDriver continuity and monotonic revisions across <a href> and navigate/reload/back/forward', async ({
      browser,
    }) => {
      const preloadSource = suiteOptions.injectPreloadInHtml
        ? await loadPreloadSource()
        : undefined;

      const harness = await startHarnessServer({
        hostPort: 0,
        framePort: 0,
        frameRoutes: {
          '/parity-nav-index': (_req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(
              renderPreloadedHtmlDocument({
                title: 'Catalog Index',
                ...(preloadSource !== undefined ? { preloadSource } : {}),
                bodyHtml: `
                  <main aria-label="catalog">
                    <h1>Catalog</h1>
                    <a id="open-detail" href="/parity-nav-detail">Open Detail</a>
                    <button type="button">Unreachable Step</button>
                  </main>
                `,
              }),
            );
          },
          '/parity-nav-detail': async (_req, res) => {
            await new Promise((r) => setTimeout(r, 35));
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(
              renderPreloadedHtmlDocument({
                title: 'Item Detail',
                ...(preloadSource !== undefined ? { preloadSource } : {}),
                bodyHtml: `
                  <main aria-label="detail">
                    <h1>Detail View</h1>
                    <label for="note-input">Note</label>
                    <input id="note-input" type="text" value="" />
                    <button type="button" id="save-note">Save</button>
                    <output id="note-out">pending</output>
                  </main>
                  <script>
                    document.getElementById('save-note').addEventListener('click', () => {
                      document.getElementById('note-out').textContent =
                        'saved:' + document.getElementById('note-input').value;
                    });
                  </script>
                `,
              }),
            );
          },
          '/parity-nav-summary': (_req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(
              renderPreloadedHtmlDocument({
                title: 'Summary Page',
                ...(preloadSource !== undefined ? { preloadSource } : {}),
                bodyHtml: `
                  <main aria-label="summary">
                    <h1>Summary</h1>
                    <button type="button" id="confirm-btn">Confirm</button>
                    <output id="confirm-out">waiting</output>
                  </main>
                  <script>
                    window.__bootToken = Math.random().toString(36).slice(2);
                    document.getElementById('confirm-btn').addEventListener('click', () => {
                      document.getElementById('confirm-out').textContent = 'done';
                    });
                  </script>
                `,
              }),
            );
          },
        },
      });

      const session = await suiteOptions.createSession({
        browser,
        harness,
        initialPath: '/parity-nav-index',
        allowEval: true,
      });
      try {
        const snap0 = await session.driver.observe();

        // Mid-batch <a href> click halts with navigation and fullReset diff
        const navClick = await session.driver.act({
          rev: snap0.rev,
          steps: [
            { kind: 'click', target: { role: 'link', name: 'Open Detail' } },
            { kind: 'click', target: { role: 'button', name: 'Unreachable Step' } },
          ],
        });
        expect(navClick.completedSteps).toBe(1);
        expect(navClick.totalSteps).toBe(2);
        expect(navClick.interruptedReason).toBe('navigation');
        expect(navClick.title).toBe('Item Detail');
        expect(navClick.diff.fullReset).toBe(true);
        expect(navClick.rev).toBeGreaterThan(snap0.rev);

        // Same PageDriver instance works seamlessly on the new document
        const detailAct = await session.driver.act({
          rev: navClick.rev,
          steps: [
            { kind: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'ready' },
            { kind: 'click', target: { role: 'button', name: 'Save' } },
          ],
        });
        expect(detailAct.completedSteps).toBe(2);
        expect(detailAct.rev).toBeGreaterThan(navClick.rev);
        expect(findNodeByRole(detailAct.diff.changed, 'status', 'saved:ready')).toBeDefined();

        // Explicit navigate url -> reload -> back -> forward
        const toSummary = await session.driver.act({
          rev: detailAct.rev,
          steps: [{ kind: 'navigate', url: '/parity-nav-summary' }],
        });
        expect(toSummary.interruptedReason).toBeUndefined();
        expect(toSummary.title).toBe('Summary Page');
        expect(toSummary.rev).toBeGreaterThan(detailAct.rev);

        const token1 = (await session.driver.eval({ expression: 'window.__bootToken' })).value;
        const reloaded = await session.driver.act({
          rev: toSummary.rev,
          steps: [{ kind: 'navigate', action: 'reload' }],
        });
        const token2 = (await session.driver.eval({ expression: 'window.__bootToken' })).value;
        expect(reloaded.rev).toBeGreaterThan(toSummary.rev);
        expect(token2).not.toBe(token1);

        const wentBack = await session.driver.act({
          rev: reloaded.rev,
          steps: [{ kind: 'navigate', action: 'back' }],
        });
        expect(wentBack.title).toBe('Item Detail');
        expect(wentBack.rev).toBeGreaterThan(reloaded.rev);

        const wentForward = await session.driver.act({
          rev: wentBack.rev,
          steps: [{ kind: 'navigate', action: 'forward' }],
        });
        expect(wentForward.title).toBe('Summary Page');
        expect(wentForward.rev).toBeGreaterThan(wentBack.rev);
      } finally {
        await session.cleanup();
        await harness.close();
      }
    });

    if (suiteOptions.supportsCapture) {
      test('captures viewport PNG, element-targeted WebP screenshots, and WebM recordings with valid container headers', async ({
        browser,
      }) => {
        const preloadSource = suiteOptions.injectPreloadInHtml
          ? await loadPreloadSource()
          : undefined;

        const harness = await startHarnessServer({
          hostPort: 0,
          framePort: 0,
          frameRoutes: {
            '/parity-capture': (_req, res) => {
              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
              });
              res.end(
                renderPreloadedHtmlDocument({
                  title: 'Visual Capture Stage',
                  ...(preloadSource !== undefined ? { preloadSource } : {}),
                  bodyHtml: `
                    <main aria-label="stage" style="padding: 24px; background: #0f172a; min-height: 420px; color: #f8fafc;">
                      <section
                        id="card-badge"
                        aria-label="Preview Card"
                        style="width: 220px; height: 120px; background: #14b8a6; border-radius: 8px; padding: 12px; box-sizing: border-box;"
                      >
                        <h2 style="margin: 0;">Card Header</h2>
                      </section>
                      <button type="button" id="paint-step-btn" style="margin-top: 16px;">Advance Frame</button>
                    </main>
                    <script>
                      let step = 0;
                      document.getElementById('paint-step-btn').addEventListener('click', () => {
                        step += 1;
                        document.getElementById('card-badge').style.background =
                          step % 2 === 1 ? '#f97316' : '#14b8a6';
                      });
                    </script>
                  `,
                }),
              );
            },
          },
        });

        const session = await suiteOptions.createSession({
          browser,
          harness,
          initialPath: '/parity-capture',
        });
        try {
          const snap = await session.driver.observe();
          const cardRef = findNodeByRole(snap.elements, 'region', 'Preview Card')?.ref;
          const stepBtnRef = findNodeByRole(snap.elements, 'button', 'Advance Frame')?.ref;
          expect(cardRef).toBeDefined();
          expect(stepBtnRef).toBeDefined();

          // 1. Full viewport PNG screenshot (\x89PNG\r\n\x1a\n)
          const pngShot = await session.driver.capture({
            mode: 'screenshot',
            format: 'png',
          });
          expect(pngShot.mimeType).toBe('image/png');
          expect(pngShot.bytes.byteLength).toBeGreaterThan(100);
          expect(Array.from(pngShot.bytes.slice(0, 8))).toEqual([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]);
          expect(pngShot.width).toBeGreaterThan(240);
          expect(pngShot.height).toBeGreaterThan(150);

          // 2. Element-targeted WebP screenshot (RIFF....WEBP)
          const webpClip = await session.driver.capture({
            mode: 'screenshot',
            target: cardRef!,
            format: 'webp',
            quality: 0.85,
          });
          expect(webpClip.mimeType).toBe('image/webp');
          expect(webpClip.bytes.byteLength).toBeGreaterThan(30);
          const riffAscii = String.fromCharCode(...webpClip.bytes.slice(0, 4));
          const webpAscii = String.fromCharCode(...webpClip.bytes.slice(8, 12));
          expect(riffAscii).toBe('RIFF');
          expect(webpAscii).toBe('WEBP');
          expect(webpClip.width).toBeGreaterThanOrEqual(200);
          expect(webpClip.width).toBeLessThan(pngShot.width);
          expect(webpClip.height).toBeGreaterThanOrEqual(100);
          expect(webpClip.height).toBeLessThan(pngShot.height);

          // 3. Video recording start -> UI frame change -> stop (EBML WebM \x1a\x45\xdf\xa3)
          const recStart = await session.driver.capture({ mode: 'start_recording' });
          expect(recStart.bytes.byteLength).toBe(0);

          await session.driver.act({
            rev: snap.rev,
            steps: [{ kind: 'click', target: stepBtnRef! }],
          });
          await new Promise((r) => setTimeout(r, 120));

          const recStop = await session.driver.capture({ mode: 'stop_recording' });
          expect(recStop.mimeType.startsWith('video/webm')).toBe(true);
          expect(recStop.bytes.byteLength).toBeGreaterThan(64);
          expect(Array.from(recStop.bytes.slice(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
          expect(recStop.width).toBeGreaterThan(0);
          expect(recStop.height).toBeGreaterThan(0);
          expect(recStop.durationMs).toBeGreaterThanOrEqual(0);
        } finally {
          await session.cleanup();
          await harness.close();
        }
      });
    }
  });
}
