import { expect, test } from '@playwright/test';
import { startHarnessServer } from './fixtures/harness-server.js';

test.describe('transactional ui_act, human-takeover guard, and eval', () => {
  test('renders isolated open-Shadow-DOM cursor overlay during act, excludes it from observe/diff, computes baseline diff without prior observe, and hides overlay after settle', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Cursor Overlay Workspace',
      frameBodyHtml: `
        <main aria-label="player">
          <button type="button" id="arm-btn">Arm Track</button>
          <output id="status-out">Idle</output>
        </main>
        <script>
          window.__overlaySnapshots = [];
          document.getElementById('arm-btn').addEventListener('click', () => {
            const host = document.querySelector('[data-inbrowser-driver-ui="cursor"]');
            const sr = host && host.shadowRoot;
            window.__overlaySnapshots.push({
              exists: Boolean(host),
              pointerEvents: host ? getComputedStyle(host).pointerEvents : null,
              displayDuringClick: host ? getComputedStyle(host).display : null,
              hasShadowRoot: Boolean(sr),
              badgeText: sr ? (sr.querySelector('[data-part="badge"]')?.textContent ?? '') : '',
              boxWidth: sr ? (sr.querySelector('[data-part="box"]')?.getBoundingClientRect().width ?? 0) : 0,
            });
            document.getElementById('status-out').textContent = 'Armed';
            setTimeout(() => {
              document.getElementById('status-out').textContent = 'Ready';
            }, 30);
          });
        </script>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const outcome = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.style.width = '640px';
        iframe.style.height = '400px';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe, { allowEval: true });
        try {
          // Call act() directly with rev: 0 BEFORE any driver.observe() to verify non-draining baseline diff!
          const actRes = await driver.act({
            rev: 0,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Arm Track' } },
              { kind: 'waitFor', text: 'Ready', timeoutMs: 2_000 },
            ],
          });

          const postSnap = await driver.observe();
          return { actRes, postSnap };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      const frame = page.frames().find((f) => f.url().startsWith(harness.frameOrigin));
      expect(frame).toBeDefined();

      const frameOverlayCheck = await frame!.evaluate(() => {
        // Invariant: test-only window inspection inside guest fixture
        const win = window as unknown as {
          __overlaySnapshots: Array<{
            exists: boolean;
            pointerEvents: string | null;
            displayDuringClick: string | null;
            hasShadowRoot: boolean;
            badgeText: string;
            boxWidth: number;
          }>;
        };
        const host = document.querySelector('[data-inbrowser-driver-ui="cursor"]');
        return {
          duringClick: win.__overlaySnapshots,
          displayAfterSettle: host ? getComputedStyle(host).display : 'missing',
        };
      });

      expect(outcome.actRes.completedSteps).toBe(2);
      expect(outcome.actRes.totalSteps).toBe(2);
      expect(outcome.actRes.interruptedReason).toBeUndefined();
      expect(outcome.actRes.diff.fullReset).toBe(false);
      expect(outcome.actRes.diff.changed).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'status', name: 'Ready' })]),
      );

      // Cursor overlay was active with open shadow root + badge + highlight box during click, then hidden
      expect(frameOverlayCheck.duringClick).toHaveLength(1);
      expect(frameOverlayCheck.duringClick[0]?.exists).toBe(true);
      expect(frameOverlayCheck.duringClick[0]?.pointerEvents).toBe('none');
      expect(frameOverlayCheck.duringClick[0]?.displayDuringClick).not.toBe('none');
      expect(frameOverlayCheck.duringClick[0]?.hasShadowRoot).toBe(true);
      expect(frameOverlayCheck.duringClick[0]?.badgeText).toContain('1/2');
      expect(frameOverlayCheck.duringClick[0]?.boxWidth).toBeGreaterThan(0);
      expect(frameOverlayCheck.displayAfterSettle).toBe('none');

      // [data-inbrowser-driver-ui] never leaks into observe() or diff
      const serialized = JSON.stringify({
        actDiff: outcome.actRes.diff,
        postElements: outcome.postSnap.elements,
      });
      expect(serialized).not.toContain('1/2');
      expect(serialized).not.toContain('cursor');
    } finally {
      await harness.close();
    }
  });

  test('halts mid-batch with user_takeover when real isTrusted human input arrives in the guest frame', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Human Takeover Workspace',
      frameBodyHtml: `
        <main aria-label="timeline">
          <button type="button" id="step-one">Start Render</button>
          <button type="button" id="step-three">Publish Output</button>
          <div id="human-pad" style="width: 160px; height: 80px; background: #eee;">Pad</div>
          <output id="state-log">init</output>
        </main>
        <script>
          window.__publishClicked = false;
          document.getElementById('step-one').addEventListener('click', () => {
            document.getElementById('state-log').textContent = 'rendering';
          });
          document.getElementById('step-three').addEventListener('click', () => {
            window.__publishClicked = true;
            document.getElementById('state-log').textContent = 'published';
          });
        </script>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.id = 'preview-frame';
        iframe.style.width = '640px';
        iframe.style.height = '400px';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);
        const snap = await driver.observe();
        // Invariant: stash pending act promise on host window so Playwright can dispatch real mouse input mid-batch
        const w = window as unknown as {
          __pendingActPromise: Promise<unknown>;
          __takeoverDriver: typeof driver;
        };
        w.__takeoverDriver = driver;
        w.__pendingActPromise = driver.act({
          rev: snap.rev,
          steps: [
            { kind: 'click', target: { role: 'button', name: 'Start Render' } },
            { kind: 'waitFor', text: 'never-arrives', timeoutMs: 4_000 },
            { kind: 'click', target: { role: 'button', name: 'Publish Output' } },
          ],
        });
      }, harness.frameOrigin);

      const frame = page.frames().find((f) => f.url().startsWith(harness.frameOrigin));
      expect(frame).toBeDefined();

      // Wait until step 0 ('Start Render') has executed inside the batch
      await expect(frame!.locator('#state-log')).toHaveText('rendering');

      // Dispatch a genuine Playwright mouse click (isTrusted === true) inside the cross-origin iframe!
      const padBox = await frame!.locator('#human-pad').boundingBox();
      expect(padBox).not.toBeNull();
      await page.mouse.click(padBox!.x + padBox!.width / 2, padBox!.y + padBox!.height / 2);

      const actRes = await page.evaluate(async () => {
        // Invariant: retrieve pending act promise and dispose driver cleanly
        const w = window as unknown as {
          __pendingActPromise: Promise<{
            completedSteps: number;
            totalSteps: number;
            interruptedReason?: string;
          }>;
          __takeoverDriver: { dispose(): void };
        };
        try {
          return await w.__pendingActPromise;
        } finally {
          w.__takeoverDriver.dispose();
        }
      });

      const publishClicked = await frame!.evaluate(() => {
        // Invariant: read guest boolean flag set only if step 2 executed
        return (window as unknown as { __publishClicked: boolean }).__publishClicked;
      });

      expect(actRes.completedSteps).toBe(1);
      expect(actRes.totalSteps).toBe(3);
      expect(actRes.interruptedReason).toBe('user_takeover');
      expect(publishClicked).toBe(false);
    } finally {
      await harness.close();
    }
  });

  test('executes all interactive DriverStep kinds (fill, setValue, select, press, drag, click) with React 19 controlled setters and self-healing refs in 1 MessagePort RTT', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Controls & Media Workspace',
      frameBodyHtml: `
        <main aria-label="editor">
          <form id="clip-form">
            <label for="clip-title">Clip Title</label>
            <input id="clip-title" type="text" value="Untitled" />

            <label for="clip-notes">Notes</label>
            <textarea id="clip-notes">Initial</textarea>

            <div id="rich-caption" role="textbox" aria-label="Caption" contenteditable="true">Draft</div>

            <label for="codec-select">Codec</label>
            <select id="codec-select">
              <option value="h264">H.264</option>
              <option value="vp9">VP9</option>
              <option value="av1">AV1</option>
            </select>

            <label for="tracks-select">Tracks</label>
            <select id="tracks-select" multiple>
              <option value="v1">Video 1</option>
              <option value="a1">Audio 1</option>
              <option value="s1">Subtitles</option>
            </select>

            <div id="preset-combo" role="combobox" aria-label="Preset" aria-expanded="false" tabindex="0">Balanced</div>
            <div id="preset-popup" role="listbox" hidden>
              <div role="option" data-value="fast">Fast Preview</div>
              <div role="option" data-value="hq">Studio HQ</div>
            </div>

            <label for="gain-slider">Gain</label>
            <input id="gain-slider" type="range" min="0" max="100" value="20" />

            <label><input id="mute-toggle" type="checkbox" /> Mute Monitor</label>
          </form>

          <video id="preview-video" aria-label="Preview Video" width="240" height="135"></video>
          <audio id="bg-audio" aria-label="Backing Audio"></audio>

          <div id="drag-area" style="position: relative; width: 300px; height: 80px; background: #f8fafc;">
            <div id="playhead" role="slider" aria-label="Playhead" tabindex="0"
              style="position: absolute; left: 10px; top: 20px; width: 24px; height: 24px; background: #2563eb;"></div>
            <div id="marker-drop" role="region" aria-label="Drop Marker"
              style="position: absolute; left: 180px; top: 16px; width: 48px; height: 32px; background: #cbd5e1;"></div>
          </div>

          <div id="remount-zone">
            <button type="button" id="apply-fx">Apply Effect</button>
          </div>
          <output id="events-summary">ready</output>
        </main>
        <script>
          // Simulate React 19 controlled input property descriptor + _valueTracker on #clip-title & #clip-notes
          function installControlledTrap(el, onControlledChange) {
            const proto = Object.getPrototypeOf(el);
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            let tracked = desc.get.call(el);
            el._valueTracker = {
              getValue: () => tracked,
              setValue: (v) => { tracked = String(v); },
            };
            Object.defineProperty(el, 'value', {
              configurable: true,
              get() { return desc.get.call(this); },
              set(next) {
                // Direct instance assignment (el.value = x) updates tracker too, causing React to ignore input!
                tracked = String(next);
                desc.set.call(this, next);
              },
            });
            el.addEventListener('input', () => {
              const current = desc.get.call(el);
              if (current !== tracked) {
                tracked = current;
                onControlledChange(current);
              }
            });
          }

          window.__state = {
            controlledTitle: 'Untitled',
            controlledNotes: 'Initial',
            formSubmits: 0,
            chords: [],
            rightClicks: 0,
            dblClicks: 0,
            dragMoves: 0,
            dragEndDeltaX: 0,
            droppedOnMarker: false,
            mediaEvents: [],
            remountedApplyClicks: 0,
          };

          const titleInput = document.getElementById('clip-title');
          const notesInput = document.getElementById('clip-notes');
          installControlledTrap(titleInput, (val) => {
            window.__state.controlledTitle = val;
            // Trigger full remount of #remount-zone (simulating React key remount) so subsequent ref heals!
            document.getElementById('remount-zone').innerHTML =
              '<button type="button" id="apply-fx-v2">Apply Effect</button>';
            document.getElementById('apply-fx-v2').addEventListener('click', () => {
              window.__state.remountedApplyClicks += 1;
              document.getElementById('events-summary').textContent = 'applied:' + val;
            });
            document.getElementById('apply-fx-v2').addEventListener('contextmenu', (e) => {
              e.preventDefault();
              window.__state.rightClicks += 1;
            });
            document.getElementById('apply-fx-v2').addEventListener('dblclick', () => {
              window.__state.dblClicks += 1;
            });
          });
          installControlledTrap(notesInput, (val) => {
            window.__state.controlledNotes = val;
          });

          document.getElementById('clip-form').addEventListener('submit', (e) => {
            e.preventDefault();
            window.__state.formSubmits += 1;
          });

          const combo = document.getElementById('preset-combo');
          const popup = document.getElementById('preset-popup');
          combo.addEventListener('click', () => {
            combo.setAttribute('aria-expanded', 'true');
            popup.hidden = false;
          });
          for (const opt of popup.querySelectorAll('[role="option"]')) {
            opt.addEventListener('click', () => {
              combo.textContent = opt.textContent;
              combo.setAttribute('aria-expanded', 'false');
              popup.hidden = true;
            });
          }

          window.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
              window.__state.chords.push(
                [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.shiftKey && 'Shift', e.key]
                  .filter(Boolean)
                  .join('+'),
              );
            }
          });

          for (const id of ['preview-video', 'bg-audio']) {
            const media = document.getElementById(id);
            for (const evName of ['timeupdate', 'seeked']) {
              media.addEventListener(evName, () => {
                window.__state.mediaEvents.push(id + ':' + evName + ':' + media.currentTime);
              });
            }
          }

          const playhead = document.getElementById('playhead');
          let dragStartX = null;
          playhead.addEventListener('pointerdown', (e) => {
            dragStartX = e.clientX;
          });
          window.addEventListener('pointermove', (e) => {
            if (dragStartX !== null) {
              window.__state.dragMoves += 1;
            }
          });
          window.addEventListener('pointerup', (e) => {
            if (dragStartX !== null) {
              window.__state.dragEndDeltaX = Math.round(e.clientX - dragStartX);
              if (e.target && e.target.id === 'marker-drop') {
                window.__state.droppedOnMarker = true;
              }
              dragStartX = null;
            }
          });
        </script>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const summary = await page.evaluate(async (frameOrigin) => {
        const { connectPort, DRIVER_CHANNEL, PROTOCOL_VERSION } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.style.width = '800px';
        iframe.style.height = '700px';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);
        await new Promise<void>((resolve) => {
          iframe.addEventListener('load', () => resolve(), { once: true });
        });

        // Wrap a MessageChannel relay so we can count exact RPC messages across the wire!
        const hostSide = new MessageChannel();
        const guestSide = new MessageChannel();
        let hostToGuestRpcCount = 0;
        let guestToHostRpcCount = 0;

        hostSide.port2.addEventListener('message', (ev) => {
          const d = ev.data as { kind?: string }; // Invariant: inspect test wire envelope kind
          if (d?.kind === 'rpc_request') hostToGuestRpcCount += 1;
          guestSide.port1.postMessage(ev.data);
        });
        guestSide.port1.addEventListener('message', (ev) => {
          const d = ev.data as { kind?: string }; // Invariant: inspect test wire envelope kind
          if (d?.kind === 'rpc_response') guestToHostRpcCount += 1;
          hostSide.port2.postMessage(ev.data);
        });
        hostSide.port2.start();
        guestSide.port1.start();

        iframe.contentWindow!.postMessage(
          {
            channel: DRIVER_CHANNEL,
            kind: 'bind_port',
            protocolVersion: PROTOCOL_VERSION,
          },
          frameOrigin,
          [guestSide.port2],
        );

        const driver = await connectPort(hostSide.port1);
        try {
          const snap = await driver.observe();
          const applyRef = snap.elements
            .flatMap((n) => [n, ...(n.children ?? [])])
            .find((n) => n.role === 'button' && n.name === 'Apply Effect')?.ref;
          if (!applyRef) throw new Error('Missing Apply Effect ref');

          hostToGuestRpcCount = 0;
          guestToHostRpcCount = 0;

          const actRes = await driver.act({
            rev: snap.rev,
            steps: [
              {
                kind: 'fill',
                target: { role: 'textbox', name: 'Clip Title' },
                value: 'Intro Cut',
                submit: true,
              },
              {
                kind: 'fill',
                target: { role: 'textbox', name: 'Notes' },
                value: 'Trimmed lead-in',
              },
              {
                kind: 'fill',
                target: { role: 'textbox', name: 'Caption' },
                value: 'Scene 01',
              },
              {
                kind: 'select',
                target: { role: 'combobox', name: 'Codec' },
                value: 'AV1',
              },
              {
                kind: 'select',
                target: { role: 'listbox', name: 'Tracks' },
                value: ['v1', 'Subtitles'],
              },
              {
                kind: 'select',
                target: { role: 'combobox', name: 'Preset' },
                value: 'Studio HQ',
              },
              {
                kind: 'setValue',
                target: { role: 'slider', name: 'Gain' },
                value: 75,
              },
              {
                kind: 'setValue',
                target: { role: 'video', name: 'Preview Video' },
                value: 12.5,
              },
              {
                kind: 'setValue',
                target: { role: 'audio', name: 'Backing Audio' },
                value: 4.25,
              },
              {
                kind: 'click',
                target: { role: 'checkbox', name: 'Mute Monitor' },
              },
              {
                kind: 'press',
                target: { role: 'textbox', name: 'Clip Title' },
                key: 'Control+a',
              },
              {
                kind: 'press',
                key: 'Meta+Enter',
              },
              {
                kind: 'press',
                key: 'Shift+Tab',
              },
              {
                kind: 'drag',
                from: { role: 'slider', name: 'Playhead' },
                to: { target: { role: 'region', name: 'Drop Marker' } },
                steps: 6,
              },
              // Click remounted button via stale eN ref (healed automatically!) + right-click + dblclick
              {
                kind: 'click',
                target: applyRef,
              },
              {
                kind: 'click',
                target: applyRef,
                button: 'right',
              },
              {
                kind: 'click',
                target: applyRef,
                clickCount: 2,
              },
            ],
          });

          return {
            actRes,
            hostToGuestRpcCount,
            guestToHostRpcCount,
          };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      const frame = page.frames().find((f) => f.url().startsWith(harness.frameOrigin));
      expect(frame).toBeDefined();
      const guestState = await frame!.evaluate(() => {
        // Invariant: read guest fixture test state
        const w = window as unknown as {
          __state: {
            controlledTitle: string;
            controlledNotes: string;
            formSubmits: number;
            chords: string[];
            rightClicks: number;
            dblClicks: number;
            dragMoves: number;
            dragEndDeltaX: number;
            droppedOnMarker: boolean;
            mediaEvents: string[];
            remountedApplyClicks: number;
          };
        };
        const codec = (document.getElementById('codec-select') as HTMLSelectElement).value; // Invariant: known HTMLSelectElement in test fixture
        const tracks = Array.from(
          (document.getElementById('tracks-select') as HTMLSelectElement).selectedOptions, // Invariant: known HTMLSelectElement in test fixture
        ).map((o) => o.value);
        const caption = document.getElementById('rich-caption')?.textContent;
        const preset = document.getElementById('preset-combo')?.textContent;
        const gain = (document.getElementById('gain-slider') as HTMLInputElement).value; // Invariant: known HTMLInputElement in test fixture
        const muted = (document.getElementById('mute-toggle') as HTMLInputElement).checked; // Invariant: known HTMLInputElement in test fixture
        return { state: w.__state, codec, tracks, caption, preset, gain, muted };
      });

      // Entire 17-step batch executed in exactly 1 MessagePort RTT!
      expect(summary.hostToGuestRpcCount).toBe(1);
      expect(summary.guestToHostRpcCount).toBe(1);
      expect(summary.actRes.completedSteps).toBe(17);
      expect(summary.actRes.totalSteps).toBe(17);
      expect(summary.actRes.interruptedReason).toBeUndefined();

      expect(guestState.state.controlledTitle).toBe('Intro Cut');
      expect(guestState.state.controlledNotes).toBe('Trimmed lead-in');
      expect(guestState.state.formSubmits).toBe(1);
      expect(guestState.caption).toBe('Scene 01');
      expect(guestState.codec).toBe('av1');
      expect(guestState.tracks).toEqual(['v1', 's1']);
      expect(guestState.preset).toBe('Studio HQ');
      expect(guestState.gain).toBe('75');
      expect(guestState.muted).toBe(true);
      expect(guestState.state.chords).toEqual(
        expect.arrayContaining(['Ctrl+a', 'Meta+Enter', 'Shift+Tab']),
      );
      expect(guestState.state.dragMoves).toBe(6);
      expect(guestState.state.dragEndDeltaX).toBeGreaterThan(140);
      expect(guestState.state.droppedOnMarker).toBe(true);
      expect(guestState.state.mediaEvents).toEqual(
        expect.arrayContaining([
          'preview-video:timeupdate:12.5',
          'preview-video:seeked:12.5',
          'bg-audio:timeupdate:4.25',
          'bg-audio:seeked:4.25',
        ]),
      );
      expect(guestState.state.remountedApplyClicks).toBe(3); // 1 single click + 2 clicks in dblclick
      expect(guestState.state.rightClicks).toBe(1);
      expect(guestState.state.dblClicks).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test('waits for scrollIntoView, layout stability, enabled state, unobscured hit-test, and network/DOM settle', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Actionability Wait Workspace',
      frameRoutes: {
        '/api/commit': async (_req, res) => {
          await new Promise((r) => setTimeout(r, 45));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ savedRevision: 'r9' }));
        },
      },
      frameBodyHtml: `
        <main aria-label="inspector" style="min-height: 1800px; position: relative;">
          <div style="height: 1100px;">Spacer</div>
          <div style="position: relative; width: 220px; height: 60px;">
            <button type="button" id="commit-btn" disabled style="width: 180px; height: 40px;">Commit Track</button>
            <div id="scrim" style="position: absolute; inset: 0; background: rgba(0,0,0,0.4);">Loading</div>
          </div>
          <output id="save-status">unsaved</output>
        </main>
        <script>
          setTimeout(() => {
            document.getElementById('commit-btn').disabled = false;
          }, 40);
          setTimeout(() => {
            document.getElementById('scrim').remove();
          }, 90);
          document.getElementById('commit-btn').addEventListener('click', async () => {
            const res = await fetch('/api/commit', { method: 'POST' });
            const body = await res.json();
            document.getElementById('save-status').textContent = 'saved:' + body.savedRevision;
          });
        </script>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const actRes = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.style.width = '500px';
        iframe.style.height = '320px';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);
        try {
          const snap = await driver.observe();
          return await driver.act({
            rev: snap.rev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Commit Track' } },
              { kind: 'waitFor', idleMs: 40, timeoutMs: 2_000 },
            ],
          });
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      expect(actRes.completedSteps).toBe(2);
      expect(actRes.interruptedReason).toBeUndefined();
      expect(actRes.diff.changed).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'status', name: 'saved:r9' })]),
      );
    } finally {
      await harness.close();
    }
  });

  test('halts transactionally with structured ActResult on step_error, pageerror/unhandledrejection, compile_error, native & DOM dialog_opened, and SPA navigation', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Interruption Guard Workspace',
      frameBodyHtml: `
        <main aria-label="deck">
          <button type="button" class="dup-btn">Duplicate Action</button>
          <button type="button" class="dup-btn">Duplicate Action</button>
          <button type="button" id="permanently-disabled" disabled>Locked Action</button>
          <button type="button" id="throw-sync">Throw Sync</button>
          <button type="button" id="reject-async">Reject Async</button>
          <button type="button" id="trigger-alert">Trigger Native Alert</button>
          <button type="button" id="open-dom-modal">Open Confirm Modal</button>
          <button type="button" id="trigger-compile-err">Trigger Compile Error</button>
          <button type="button" id="spa-nav">Go SPA Route</button>
          <button type="button" id="after-guard">After Guard</button>

          <dialog id="confirm-modal" aria-label="Confirm Delete">
            <p>Delete clip permanently?</p>
            <button type="button" id="confirm-yes">Confirm Yes</button>
          </dialog>
          <output id="guard-trace">clean</output>
        </main>
        <script>
          window.__afterGuardCount = 0;
          window.__confirmReturnValue = 'unset';
          window.__promptReturnValue = 'unset';

          document.getElementById('after-guard').addEventListener('click', () => {
            window.__afterGuardCount += 1;
          });
          document.getElementById('throw-sync').addEventListener('click', () => {
            throw new Error('sync listener crash');
          });
          document.getElementById('reject-async').addEventListener('click', () => {
            Promise.reject(new Error('async task rejected'));
          });
          document.getElementById('trigger-alert').addEventListener('click', () => {
            alert('Disk quota warning');
            window.__confirmReturnValue = confirm('Proceed anyway?');
            window.__promptReturnValue = prompt('Enter label');
          });
          document.getElementById('open-dom-modal').addEventListener('click', () => {
            document.getElementById('confirm-modal').setAttribute('open', '');
          });
          document.getElementById('confirm-yes').addEventListener('click', () => {
            document.getElementById('confirm-modal').removeAttribute('open');
            document.getElementById('guard-trace').textContent = 'confirmed-modal';
          });
          document.getElementById('trigger-compile-err').addEventListener('click', () => {
            const overlay = document.createElement('vite-error-overlay');
            const sr = overlay.attachShadow({ mode: 'open' });
            sr.innerHTML = '<pre>SyntaxError: Unexpected token (panel.tsx:14:2)</pre>';
            document.body.appendChild(overlay);
          });
          document.getElementById('spa-nav').addEventListener('click', () => {
            history.pushState({}, '', '/clips/42');
            document.getElementById('guard-trace').textContent = 'route:/clips/42';
          });
        </script>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const results = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.style.width = '720px';
        iframe.style.height = '500px';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);
        try {
          const s0 = await driver.observe();

          // 1a. Missing target at step 0 -> structured ActResult (does not reject!)
          const notFoundRes = await driver.act({
            rev: s0.rev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Nonexistent Button' } },
              { kind: 'click', target: { role: 'button', name: 'After Guard' } },
            ],
            timeoutMs: 120,
          });

          // 1b. Ambiguous target -> fails fast with candidates
          const ambiguousRes = await driver.act({
            rev: notFoundRes.rev,
            steps: [{ kind: 'click', target: { role: 'button', name: 'Duplicate Action' } }],
          });

          // 1c. Actionability timeout on disabled button
          const disabledRes = await driver.act({
            rev: ambiguousRes.rev,
            timeoutMs: 120,
            steps: [{ kind: 'click', target: { role: 'button', name: 'Locked Action' } }],
          });

          // 2a. Uncaught synchronous pageerror during step 0
          const syncErrRes = await driver.act({
            rev: disabledRes.rev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Throw Sync' } },
              { kind: 'click', target: { role: 'button', name: 'After Guard' } },
            ],
          });

          // 2b. Unhandled promise rejection during step 0
          const asyncRejRes = await driver.act({
            rev: syncErrRes.rev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Reject Async' } },
              { kind: 'click', target: { role: 'button', name: 'After Guard' } },
            ],
          });

          // 3a. Native alert/confirm/prompt auto-dismissed + diagnostic message + dialog_opened
          const nativeDialogRes = await driver.act({
            rev: asyncRejRes.rev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Trigger Native Alert' } },
              { kind: 'click', target: { role: 'button', name: 'After Guard' } },
            ],
          });

          // 3b. Newly opened DOM <dialog open> mid-batch halts before step 1
          const domDialogOpenRes = await driver.act({
            rev: nativeDialogRes.rev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Open Confirm Modal' } },
              { kind: 'click', target: { role: 'button', name: 'After Guard' } },
            ],
          });

          // 3c. Subsequent turn can click inside the already-open <dialog open> cleanly
          const domDialogConfirmRes = await driver.act({
            rev: domDialogOpenRes.rev,
            steps: [{ kind: 'click', target: { role: 'button', name: 'Confirm Yes' } }],
          });

          // 4. SPA pushState mid-batch halts with interruptedReason: 'navigation'
          const spaNavRes = await driver.act({
            rev: domDialogConfirmRes.rev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Go SPA Route' } },
              { kind: 'click', target: { role: 'button', name: 'After Guard' } },
            ],
          });

          // 5. Compile error overlay halts with interruptedReason: 'compile_error'
          const compileErrRes = await driver.act({
            rev: spaNavRes.rev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Trigger Compile Error' } },
              { kind: 'click', target: { role: 'button', name: 'After Guard' } },
            ],
          });

          return {
            notFoundRes,
            ambiguousRes,
            disabledRes,
            syncErrRes,
            asyncRejRes,
            nativeDialogRes,
            domDialogOpenRes,
            domDialogConfirmRes,
            spaNavRes,
            compileErrRes,
          };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      const frame = page.frames().find((f) => f.url().startsWith(harness.frameOrigin));
      const guestCheck = await frame!.evaluate(() => {
        // Invariant: read guest fixture guard state
        const w = window as unknown as {
          __afterGuardCount: number;
          __confirmReturnValue: unknown;
          __promptReturnValue: unknown;
        };
        return {
          afterGuardCount: w.__afterGuardCount,
          confirmReturnValue: w.__confirmReturnValue,
          promptReturnValue: w.__promptReturnValue,
        };
      });

      // Step after every interrupted step NEVER ran!
      expect(guestCheck.afterGuardCount).toBe(0);
      expect(guestCheck.confirmReturnValue).toBe(false);
      expect(guestCheck.promptReturnValue).toBeNull();

      expect(results.notFoundRes.completedSteps).toBe(0);
      expect(results.notFoundRes.interruptedReason).toBe('step_error');
      expect(results.notFoundRes.error).toContain('DRIVER_TARGET_NOT_FOUND');

      expect(results.ambiguousRes.completedSteps).toBe(0);
      expect(results.ambiguousRes.interruptedReason).toBe('step_error');
      expect(results.ambiguousRes.error).toContain('DRIVER_TARGET_AMBIGUOUS');
      expect(results.ambiguousRes.error).toContain('Duplicate Action');

      expect(results.disabledRes.completedSteps).toBe(0);
      expect(results.disabledRes.interruptedReason).toBe('step_error');
      expect(results.disabledRes.error).toContain('disabled');

      expect(results.syncErrRes.completedSteps).toBe(1);
      expect(results.syncErrRes.totalSteps).toBe(2);
      expect(results.syncErrRes.interruptedReason).toBe('step_error');
      expect(results.syncErrRes.error).toContain('sync listener crash');
      expect(results.syncErrRes.diagnostics.pageErrors.join('\n')).toContain('sync listener crash');

      expect(results.asyncRejRes.completedSteps).toBe(1);
      expect(results.asyncRejRes.totalSteps).toBe(2);
      expect(results.asyncRejRes.interruptedReason).toBe('step_error');
      expect(results.asyncRejRes.error).toContain('async task rejected');
      expect(results.asyncRejRes.diagnostics.pageErrors.join('\n')).toContain(
        'async task rejected',
      );

      expect(results.nativeDialogRes.completedSteps).toBe(1);
      expect(results.nativeDialogRes.interruptedReason).toBe('dialog_opened');
      expect(results.nativeDialogRes.diagnostics.consoleErrors.join('\n')).toContain(
        'Disk quota warning',
      );

      expect(results.domDialogOpenRes.completedSteps).toBe(1);
      expect(results.domDialogOpenRes.interruptedReason).toBe('dialog_opened');
      expect(results.domDialogOpenRes.diff.added).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'dialog', name: 'Confirm Delete' }),
        ]),
      );

      expect(results.domDialogConfirmRes.completedSteps).toBe(1);
      expect(results.domDialogConfirmRes.interruptedReason).toBeUndefined();

      expect(results.spaNavRes.completedSteps).toBe(1);
      expect(results.spaNavRes.totalSteps).toBe(2);
      expect(results.spaNavRes.interruptedReason).toBe('navigation');
      expect(results.spaNavRes.url).toContain('/clips/42');
      expect(results.spaNavRes.diff.fullReset).toBe(true);

      expect(results.compileErrRes.completedSteps).toBe(1);
      expect(results.compileErrRes.interruptedReason).toBe('compile_error');
      expect(results.compileErrRes.diagnostics.compileOverlay).toContain('SyntaxError');
    } finally {
      await harness.close();
    }
  });

  test('evaluates sync and async expressions with timeoutMs, DataCloneError-safe sanitization, and diagnostics draining when allowEval is true', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Eval Inspection Workspace',
      frameBodyHtml: `
        <section id="eval-box" class="panel primary" aria-label="Inspector Panel">
          <span>Ready</span>
        </section>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const outcome = await page.evaluate(async (frameOrigin) => {
        const { connectIframe, DriverError } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const makeFrame = (): HTMLIFrameElement => {
          const el = document.createElement('iframe');
          el.style.width = '480px';
          el.style.height = '320px';
          el.src = `${frameOrigin}/frame`;
          workspace.appendChild(el);
          return el;
        };

        const lockedDriver = await connectIframe(makeFrame());
        let disabledCode = 'none';
        try {
          await lockedDriver.eval({ expression: 'document.title' });
        } catch (err) {
          disabledCode = err instanceof DriverError ? err.code : String(err);
        } finally {
          lockedDriver.dispose();
        }

        const evalDriver = await connectIframe(makeFrame(), { allowEval: true });
        try {
          const titleRes = await evalDriver.eval({ expression: 'document.title' });
          const asyncRes = await evalDriver.eval({
            expression:
              '(async () => { await new Promise((r) => setTimeout(r, 15)); console.error("eval-side-err"); return { path: window.location.pathname, sum: 19 + 23 }; })()',
          });
          const afterAsyncObs = await evalDriver.observe();

          const complexRes = await evalDriver.eval({
            expression: `(() => {
              function namedHelper() {}
              const cyc = { label: 'root' };
              cyc.self = cyc;
              const list = [1, undefined, 9007199254740993n];
              list.push(list);
              return {
                undef: undefined,
                big: 9007199254740993n,
                el: document.getElementById('eval-box'),
                textNode: document.createTextNode('inline text'),
                err: new TypeError('invalid range'),
                fn: namedHelper,
                sym: Symbol('tag'),
                cyc,
                list,
              };
            })()`,
          });

          let timeoutCode = 'none';
          try {
            await evalDriver.eval({ expression: 'new Promise(() => {})', timeoutMs: 45 });
          } catch (err) {
            timeoutCode = err instanceof DriverError ? err.code : String(err);
          }

          return {
            disabledCode,
            titleRes,
            asyncRes,
            afterAsyncConsoleErrors: afterAsyncObs.diagnostics.consoleErrors,
            complexValue: complexRes.value,
            timeoutCode,
          };
        } finally {
          evalDriver.dispose();
        }
      }, harness.frameOrigin);

      expect(outcome.disabledCode).toBe('DRIVER_EVAL_DISABLED');
      expect(outcome.titleRes.value).toBe('Eval Inspection Workspace');
      expect(outcome.asyncRes.value).toEqual({ path: '/frame', sum: 42 });
      expect(outcome.asyncRes.diagnostics.consoleErrors).toEqual(['eval-side-err']);
      expect(outcome.afterAsyncConsoleErrors).toEqual([]);
      expect(outcome.timeoutCode).toBe('DRIVER_TIMEOUT');

      const complex = outcome.complexValue as Record<string, unknown>; // Invariant: evaluated object literal sanitized to plain record
      expect(complex['undef']).toBeNull();
      expect(complex['big']).toBe('9007199254740993n');
      expect(complex['el']).toMatchObject({ tag: 'section', id: 'eval-box' });
      expect(complex['textNode']).toMatchObject({ nodeName: '#text' });
      expect(complex['err']).toMatchObject({ name: 'TypeError', message: 'invalid range' });
      expect(String(complex['fn'])).toContain('namedHelper');
      expect(complex['sym']).toBe('Symbol(tag)');
      expect((complex['cyc'] as Record<string, unknown>)['self']).toBe('[Circular]'); // Invariant: sanitized nested object
      expect(complex['list']).toEqual([1, null, '9007199254740993n', '[Circular]']);
    } finally {
      await harness.close();
    }
  });
});
