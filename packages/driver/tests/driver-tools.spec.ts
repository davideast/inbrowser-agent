import { expect, test } from '@playwright/test';
import type { ActResult, ObservationSnapshot } from '../src/types.js';
import { startHarnessServer } from './fixtures/harness-server.js';

/**
 * Compile-time and runtime ecosystem structural mirrors (`@inbrowser/agent`
 * `ToolHandler` and `@inbrowser/sandbox` `SandboxTool`) verified without casts.
 */
type AgentJsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, AgentJsonSchema>;
  required?: string[];
  items?: AgentJsonSchema | AgentJsonSchema[];
  enum?: unknown[];
  [key: string]: unknown;
};

interface AgentToolHandler<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: AgentJsonSchema;
  available?(capabilities: Record<string, boolean>): boolean;
  parallelSafe?: boolean;
  pure?: boolean;
  execute(
    args: A,
    ctx: {
      signal: AbortSignal;
      workspace?: Record<string, unknown>;
      runtime?: Record<string, unknown>;
    },
  ): Promise<{
    ok: boolean;
    summary: string;
    data?: D;
    workspacePatch?: Record<string, unknown>;
    runtimePatch?: Record<string, unknown>;
  }>;
}

interface SandboxTool<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  pure?: boolean;
  execute(
    args: A,
    ctx: { sandbox: { readonly id: string; readonly cwd: string }; signal: AbortSignal },
  ): Promise<{ ok: boolean; summary: string; data?: D }>;
}

function buildStudioWorkspaceHtml(): string {
  const extraControls: string[] = [];
  for (let i = 1; i <= 42; i += 1) {
    if (i % 3 === 0) {
      extraControls.push(
        `<label for="gain-${String(i)}">Channel ${String(i)} Gain</label>` +
          `<input id="gain-${String(i)}" type="range" min="0" max="100" value="50" />`,
      );
    } else if (i % 2 === 0) {
      extraControls.push(
        `<label><input id="arm-${String(i)}" type="checkbox" /> Arm Channel ${String(i)}</label>`,
      );
    } else {
      extraControls.push(
        `<button type="button" id="solo-${String(i)}">Solo Channel ${String(i)}</button>`,
      );
    }
  }

  return `
    <main aria-label="workspace">
      <section aria-label="inspector">
        <label for="seq-title">Sequence Title</label>
        <input id="seq-title" type="text" value="Untitled Sequence" />

        <label for="export-preset">Export Preset</label>
        <select id="export-preset">
          <option value="draft">Draft 720p</option>
          <option value="broadcast">Broadcast 1080p</option>
          <option value="master">Master 4K</option>
        </select>

        <button type="button" id="commit-seq">Commit Sequence</button>
        <output id="commit-status">Idle</output>
      </section>

      <section aria-label="player">
        <video id="monitor-video" aria-label="Program Monitor" width="320" height="180"></video>
        <canvas id="meter-canvas" aria-label="Peak Meter" width="240" height="60"></canvas>
      </section>

      <section aria-label="timeline">
        ${extraControls.join('\n')}
      </section>
    </main>
    <script>
      const canvas = document.getElementById('meter-canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#0ea5e9';
        ctx.fillRect(8, 8, 120, 32);
      }

      window.__committed = null;
      document.getElementById('commit-seq').addEventListener('click', () => {
        const title = document.getElementById('seq-title').value;
        const preset = document.getElementById('export-preset').value;
        window.__committed = { title, preset };
        document.getElementById('commit-status').textContent = 'Committed: ' + title + ' [' + preset + ']';
      });
    </script>
  `;
}

test.describe('@inbrowser/driver/tools end-to-end agent tool surface', () => {
  test('drives a 45+ control cross-origin workspace in 2 tool calls (ui_observe -> batched ui_act) with >= 75% summary reduction, scope narrowing, and ecosystem assignability', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Studio Timeline Workspace',
      frameBodyHtml: buildStudioWorkspaceHtml(),
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const outcome = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const { createDriverTools } = await import('@inbrowser/driver/tools');

        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.style.width = '960px';
        iframe.style.height = '640px';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);
        try {
          // Verify direct structural assignability without casts to AgentToolHandler[] and SandboxTool[]
          const agentTools: AgentToolHandler[] = createDriverTools(driver);
          const agentEvalTools: AgentToolHandler[] = createDriverTools(driver, {
            allowEval: true,
          });
          const sandboxTools: SandboxTool[] = createDriverTools(driver);
          const sandboxEvalTools: SandboxTool[] = createDriverTools(driver, { allowEval: true });

          const toolNames = agentTools.map((t) => t.name);
          const evalToolNames = agentEvalTools.map((t) => t.name);
          const sandboxCounts = [sandboxTools.length, sandboxEvalTools.length];

          const turnController = new AbortController();
          const uiObserve = agentTools.find((t) => t.name === 'ui_observe');
          const uiAct = sandboxTools.find((t) => t.name === 'ui_act');
          if (!uiObserve || !uiAct) throw new Error('Missing ui_observe or ui_act');

          // Call 1: ui_observe full workspace through AgentToolHandler signature
          const observeRes = await uiObserve.execute({}, { signal: turnController.signal });
          const snap = observeRes.data as ObservationSnapshot | undefined; // Invariant: ui_observe populates ObservationSnapshot on ok: true
          if (!observeRes.ok || !snap) {
            throw new Error(`ui_observe failed: ${observeRes.summary}`);
          }

          // Locate exact refs from observation snapshot
          const allNodes: Array<{ role: string; name: string; ref?: string }> = [];
          const walk = (nodes: typeof snap.elements): void => {
            for (const n of nodes) {
              allNodes.push(n);
              if (n.children) walk(n.children);
            }
          };
          walk(snap.elements);

          const titleRef = allNodes.find(
            (n) => n.role === 'textbox' && n.name === 'Sequence Title',
          )?.ref;
          const presetRef = allNodes.find(
            (n) => n.role === 'combobox' && n.name === 'Export Preset',
          )?.ref;
          const commitRef = allNodes.find(
            (n) => n.role === 'button' && n.name === 'Commit Sequence',
          )?.ref;
          if (!titleRef || !presetRef || !commitRef) {
            throw new Error('Expected refs for Sequence Title, Export Preset, and Commit Sequence');
          }

          // Call 2: ui_act batching fill + select + click in 1 RTT through SandboxTool signature
          const actRes = await uiAct.execute(
            {
              rev: snap.rev,
              steps: [
                { kind: 'fill', target: titleRef, value: 'Episode 04 Cut' },
                { kind: 'select', target: presetRef, value: 'Master 4K' },
                { kind: 'click', target: commitRef },
              ],
            },
            {
              sandbox: { id: 'sb-studio', cwd: '/workspace' },
              signal: turnController.signal,
            },
          );
          const actData = actRes.data as ActResult | undefined; // Invariant: ui_act populates ActResult on completion

          // Also verify maxYamlChars budget truncation + scope narrowing on live workspace
          const budgetedObserve = createDriverTools(driver, { maxYamlChars: 240 }).find(
            (t) => t.name === 'ui_observe',
          )!;
          const truncatedObs = await budgetedObserve.execute({});
          const scopedObs = await uiObserve.execute(
            { scope: 'region:inspector' },
            { signal: turnController.signal },
          );

          return {
            toolNames,
            evalToolNames,
            sandboxCounts,
            observeOk: observeRes.ok,
            observeSummary: observeRes.summary,
            actOk: actRes.ok,
            actSummary: actRes.summary,
            actRev: actData?.rev,
            actCompletedSteps: actData?.completedSteps,
            actTotalSteps: actData?.totalSteps,
            truncatedSummary: truncatedObs.summary,
            scopedSummary: scopedObs.summary,
          };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      const frame = page.frames().find((f) => f.url().startsWith(harness.frameOrigin));
      expect(frame).toBeDefined();

      const guestCommitted = await frame!.evaluate(() => {
        // Invariant: read guest fixture commit record
        return (window as unknown as { __committed: { title: string; preset: string } | null })
          .__committed;
      });

      expect(outcome.toolNames).toEqual(['ui_observe', 'ui_act', 'ui_capture']);
      expect(outcome.evalToolNames).toEqual(['ui_observe', 'ui_act', 'ui_capture', 'ui_eval']);
      expect(outcome.sandboxCounts).toEqual([3, 4]);
      expect(outcome.observeOk).toBe(true);
      expect(outcome.observeSummary).toContain('rev: 1');
      expect(outcome.observeSummary).toContain('Program Monitor');
      expect(outcome.observeSummary).toContain('Peak Meter');
      expect(outcome.observeSummary).toContain('nonBlank=true');

      expect(outcome.actOk).toBe(true);
      expect(outcome.actCompletedSteps).toBe(3);
      expect(outcome.actTotalSteps).toBe(3);
      expect(outcome.actRev).toBe(2);
      expect(outcome.actSummary).toContain('status: ok');
      expect(outcome.actSummary).toContain('steps: 3/3');
      expect(outcome.actSummary).toContain('Episode 04 Cut');
      expect(outcome.actSummary).toContain('Committed: Episode 04 Cut [master]');

      expect(guestCommitted).toEqual({
        title: 'Episode 04 Cut',
        preset: 'master',
      });

      // Localized ui_act diff summary must be >= 75% smaller than full-page ui_observe summary
      const reductionRatio = 1 - outcome.actSummary.length / outcome.observeSummary.length;
      expect(reductionRatio).toBeGreaterThanOrEqual(0.75);

      // Budget truncation + scope narrowing
      expect(outcome.truncatedSummary.length).toBeLessThanOrEqual(240);
      expect(outcome.truncatedSummary).toMatch(
        /\.\.\. \(truncated \d+ chars; pass scope to narrow\)$/,
      );
      expect(outcome.scopedSummary).toContain('Sequence Title');
      expect(outcome.scopedSummary).not.toContain('Solo Channel 41');
    } finally {
      await harness.close();
    }
  });

  test('preserves partial ActResult data when ui_act halts mid-batch and reports structured candidate/validation/abort errors without throwing', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Guard & Error Workspace',
      frameBodyHtml: `
        <main aria-label="workspace">
          <section aria-label="catalog">
            <button type="button" id="open-confirm">Delete Asset</button>
            <button type="button" id="spa-route">Open Details Route</button>
            <button type="button" id="never-run">Secondary Action</button>
            <dialog id="confirm-dialog" aria-label="Confirm Asset Removal">
              <button type="button" id="confirm-close">Cancel Removal</button>
            </dialog>
            <output id="trace">ready</output>
          </section>
        </main>
        <script>
          window.__secondaryCount = 0;
          document.getElementById('never-run').addEventListener('click', () => {
            window.__secondaryCount += 1;
          });
          document.getElementById('open-confirm').addEventListener('click', () => {
            document.getElementById('confirm-dialog').setAttribute('open', '');
            document.getElementById('trace').textContent = 'dialog-open';
          });
          document.getElementById('confirm-close').addEventListener('click', () => {
            document.getElementById('confirm-dialog').removeAttribute('open');
            document.getElementById('trace').textContent = 'dialog-closed';
          });
          document.getElementById('spa-route').addEventListener('click', () => {
            history.pushState({}, '', '/catalog/item-9');
            document.getElementById('trace').textContent = 'navigated';
          });
        </script>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const check = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const { createDriverTools } = await import('@inbrowser/driver/tools');

        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const iframe = document.createElement('iframe');
        iframe.style.width = '720px';
        iframe.style.height = '480px';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);
        try {
          const tools = createDriverTools(driver);
          const uiObserve = tools.find((t) => t.name === 'ui_observe')!;
          const uiAct = tools.find((t) => t.name === 'ui_act')!;

          const initial = await uiObserve.execute({});
          const initialRev = (initial.data as ObservationSnapshot).rev; // Invariant: initial ui_observe succeeded

          // 1. Invalid scope in ui_observe -> catches DRIVER_TARGET_NOT_FOUND with live landmark candidates
          const badScope = await uiObserve.execute({ scope: 'nonexistent-landmark' });

          // 2. Malformed LLM arguments -> structured INVALID_ARGUMENTS without throwing
          const malformedAct = await uiAct.execute({ rev: 'not-a-number', steps: null });

          // 3. Mid-batch dialog_opened interruption -> ok: false WITH partial ActResult data preserved
          const dialogInterrupt = await uiAct.execute({
            rev: initialRev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Delete Asset' } },
              { kind: 'click', target: { role: 'button', name: 'Secondary Action' } },
            ],
          });
          const dialogData = dialogInterrupt.data as ActResult | undefined; // Invariant: partial ActResult attached on interruption

          // Close the modal cleanly using the new rev from partial ActResult
          const closedModal = await uiAct.execute({
            rev: dialogData!.rev,
            steps: [{ kind: 'click', target: { role: 'button', name: 'Cancel Removal' } }],
          });
          const closedData = closedModal.data as ActResult; // Invariant: single-step close succeeded

          // 4. Mid-batch SPA navigation interruption -> ok: false WITH partial ActResult data + fullReset diff
          const navInterrupt = await uiAct.execute({
            rev: closedData.rev,
            steps: [
              { kind: 'click', target: { role: 'button', name: 'Open Details Route' } },
              { kind: 'click', target: { role: 'button', name: 'Secondary Action' } },
            ],
          });
          const navData = navInterrupt.data as ActResult | undefined; // Invariant: partial ActResult attached on navigation interruption

          // 5. Pre-aborted AbortSignal forwarded through ctx.signal -> ok: false DRIVER_TIMEOUT
          const abortCtrl = new AbortController();
          abortCtrl.abort(new Error('agent turn cancelled'));
          const abortedObs = await uiObserve.execute({}, { signal: abortCtrl.signal });

          return {
            badScope,
            malformedAct,
            dialogInterruptOk: dialogInterrupt.ok,
            dialogInterruptSummary: dialogInterrupt.summary,
            dialogDataPresent: dialogData !== undefined,
            dialogCompleted: dialogData?.completedSteps,
            dialogTotal: dialogData?.totalSteps,
            dialogReason: dialogData?.interruptedReason,
            navInterruptOk: navInterrupt.ok,
            navInterruptSummary: navInterrupt.summary,
            navDataPresent: navData !== undefined,
            navReason: navData?.interruptedReason,
            navFullReset: navData?.diff.fullReset,
            abortedObs,
          };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      const frame = page.frames().find((f) => f.url().startsWith(harness.frameOrigin));
      const secondaryClicks = await frame!.evaluate(() => {
        // Invariant: read guest fixture guard counter
        return (window as unknown as { __secondaryCount: number }).__secondaryCount;
      });

      expect(secondaryClicks).toBe(0);

      expect(check.badScope.ok).toBe(false);
      expect(check.badScope.summary).toContain('DRIVER_TARGET_NOT_FOUND');
      expect(check.badScope.summary).toContain('candidates:');
      expect(check.badScope.summary).toContain('catalog');

      expect(check.malformedAct.ok).toBe(false);
      expect(check.malformedAct.summary).toContain('INVALID_ARGUMENTS');

      expect(check.dialogInterruptOk).toBe(false);
      expect(check.dialogDataPresent).toBe(true);
      expect(check.dialogCompleted).toBe(1);
      expect(check.dialogTotal).toBe(2);
      expect(check.dialogReason).toBe('dialog_opened');
      expect(check.dialogInterruptSummary).toContain('interrupted: dialog_opened');
      expect(check.dialogInterruptSummary).toContain('Confirm Asset Removal');

      expect(check.navInterruptOk).toBe(false);
      expect(check.navDataPresent).toBe(true);
      expect(check.navReason).toBe('navigation');
      expect(check.navFullReset).toBe(true);
      expect(check.navInterruptSummary).toContain('interrupted: navigation');
      expect(check.navInterruptSummary).toContain('fullReset: true');

      expect(check.abortedObs.ok).toBe(false);
      expect(check.abortedObs.summary).toContain('DRIVER_TIMEOUT');
    } finally {
      await harness.close();
    }
  });

  test('executes end-to-end silent ui_capture (screenshot + WebM recording) on connectIframe, reports structured capture errors, and enforces ui_eval opt-in security gates', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Capture & Eval Workspace',
      frameBodyHtml: `
        <main aria-label="player">
          <button type="button" id="ping-btn">Ping</button>
          <span id="version-badge">v2.4.0</span>
        </main>
      `,
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const summary = await page.evaluate(async (frameOrigin) => {
        const { DriverError, connectIframe, isCaptureResult } = await import('@inbrowser/driver');
        const { createDriverTools } = await import('@inbrowser/driver/tools');

        const workspace = document.getElementById('workspace');
        if (!workspace) throw new Error('Missing #workspace');

        const makeIframe = (): HTMLIFrameElement => {
          const el = document.createElement('iframe');
          el.style.width = '640px';
          el.style.height = '360px';
          el.src = `${frameOrigin}/frame`;
          workspace.appendChild(el);
          return el;
        };

        // 1. Live PreviewPortBackend with allowEval: false (default)
        const lockedDriver = await connectIframe(makeIframe());
        let stopWithoutStartRes: { ok: boolean; summary: string };
        let liveScreenshotRes: {
          ok: boolean;
          summary: string;
          byteLength: number | undefined;
          width: number | undefined;
          height: number | undefined;
        };
        let liveStartRecRes: { ok: boolean; summary: string };
        let liveStopRecRes: {
          ok: boolean;
          summary: string;
          byteLength: number | undefined;
        };
        let unsupportedCaptureRes: { ok: boolean; summary: string };
        let lockedEvalAttempt: { ok: boolean; summary: string };
        let wrappedGpuRecordingRes: { ok: boolean; summary: string };

        try {
          const defaultTools = createDriverTools(lockedDriver);
          const liveCaptureTool = defaultTools.find((t) => t.name === 'ui_capture')!;

          // Stopping recording when none is active surfaces structured DRIVER_PROTOCOL
          stopWithoutStartRes = await liveCaptureTool.execute({ mode: 'stop_recording' });

          // Real end-to-end silent screenshot on bare connectIframe
          const liveShot = await liveCaptureTool.execute({
            mode: 'screenshot',
            target: { role: 'button', name: 'Ping' },
            format: 'webp',
            quality: 0.85,
          });
          const liveShotData = isCaptureResult(liveShot.data) ? liveShot.data : undefined;
          liveScreenshotRes = {
            ok: liveShot.ok,
            summary: liveShot.summary,
            byteLength: liveShotData?.bytes.byteLength,
            width: liveShotData?.width,
            height: liveShotData?.height,
          };

          // Real end-to-end silent start_recording -> stop_recording on bare connectIframe
          liveStartRecRes = await liveCaptureTool.execute({ mode: 'start_recording' });
          await new Promise((resolve) => setTimeout(resolve, 140));
          const liveRecStop = await liveCaptureTool.execute({ mode: 'stop_recording' });
          const liveRecData = isCaptureResult(liveRecStop.data) ? liveRecStop.data : undefined;
          liveStopRecRes = {
            ok: liveRecStop.ok,
            summary: liveRecStop.summary,
            byteLength: liveRecData?.bytes.byteLength,
          };

          // Force-enable ui_eval in options while underlying driver has allowEval: false
          const toolsOverLockedDriver = createDriverTools(lockedDriver, { allowEval: true });
          const lockedEvalTool = toolsOverLockedDriver.find((t) => t.name === 'ui_eval')!;
          lockedEvalAttempt = await lockedEvalTool.execute({ expression: 'document.title' });

          // Verify structured DRIVER_UNSUPPORTED envelope when a custom PageDriver rejects capture
          const unsupportedDriver = {
            ...lockedDriver,
            capabilities: lockedDriver.capabilities,
            observe: lockedDriver.observe.bind(lockedDriver),
            act: lockedDriver.act.bind(lockedDriver),
            eval: lockedDriver.eval.bind(lockedDriver),
            dispose: lockedDriver.dispose.bind(lockedDriver),
            async capture() {
              throw new DriverError(
                'DRIVER_UNSUPPORTED',
                'Capture backend unavailable in this host.',
              );
            },
          };
          const unsupportedTool = createDriverTools(unsupportedDriver).find(
            (t) => t.name === 'ui_capture',
          )!;
          unsupportedCaptureRes = await unsupportedTool.execute({
            mode: 'screenshot',
            format: 'webp',
          });

          // Verify viewport-gpu recording metadata formatting
          const gpuRecordingDriver = {
            ...lockedDriver,
            capabilities: lockedDriver.capabilities,
            observe: lockedDriver.observe.bind(lockedDriver),
            act: lockedDriver.act.bind(lockedDriver),
            eval: lockedDriver.eval.bind(lockedDriver),
            dispose: lockedDriver.dispose.bind(lockedDriver),
            async capture() {
              const payload = new Uint8Array(48_120);
              payload.fill(7);
              return {
                mimeType: 'video/webm',
                bytes: payload,
                width: 640,
                height: 360,
                modeUsed: 'viewport-gpu' as const,
                durationMs: 920,
              };
            },
          };
          const wrappedCaptureTool = createDriverTools(gpuRecordingDriver).find(
            (t) => t.name === 'ui_capture',
          )!;
          wrappedGpuRecordingRes = await wrappedCaptureTool.execute({ mode: 'stop_recording' });
        } finally {
          lockedDriver.dispose();
        }

        // 2. Live PreviewPortBackend with allowEval: true
        const evalDriver = await connectIframe(makeIframe(), { allowEval: true });
        try {
          const defaultOmittedEval = createDriverTools(evalDriver).some(
            (t) => t.name === 'ui_eval',
          );
          const fullTools = createDriverTools(evalDriver, { allowEval: true });
          const uiEval = fullTools.find((t) => t.name === 'ui_eval')!;
          const uiObserve = fullTools.find((t) => t.name === 'ui_observe')!;

          const evalRes = await uiEval.execute({
            expression: `(() => {
              console.error('diagnostic from eval');
              return {
                badge: document.getElementById('version-badge')?.textContent,
                title: document.title,
              };
            })()`,
          });
          const subsequentObserve = await uiObserve.execute({});

          return {
            stopWithoutStartRes,
            liveScreenshotRes,
            liveStartRecRes,
            liveStopRecRes,
            unsupportedCaptureRes,
            lockedEvalAttempt,
            wrappedGpuRecordingRes,
            defaultOmittedEval,
            evalOk: evalRes.ok,
            evalSummary: evalRes.summary,
            subsequentObserveSummary: subsequentObserve.summary,
          };
        } finally {
          evalDriver.dispose();
        }
      }, harness.frameOrigin);

      expect(summary.stopWithoutStartRes.ok).toBe(false);
      expect(summary.stopWithoutStartRes.summary).toContain('DRIVER_PROTOCOL');

      expect(summary.liveScreenshotRes.ok).toBe(true);
      expect(summary.liveScreenshotRes.byteLength).toBeGreaterThan(0);
      expect(summary.liveScreenshotRes.width).toBeGreaterThan(0);
      expect(summary.liveScreenshotRes.height).toBeGreaterThan(0);
      expect(summary.liveScreenshotRes.summary).toContain('mimeType: "image/webp"');
      expect(summary.liveScreenshotRes.summary).toContain('modeUsed: silent');
      expect(summary.liveScreenshotRes.summary.length).toBeLessThan(200);

      expect(summary.liveStartRecRes.ok).toBe(true);
      expect(summary.liveStopRecRes.ok).toBe(true);
      expect(summary.liveStopRecRes.byteLength).toBeGreaterThan(0);
      expect(summary.liveStopRecRes.summary).toContain('mimeType: "video/webm"');
      expect(summary.liveStopRecRes.summary).toContain('modeUsed: silent');

      expect(summary.unsupportedCaptureRes.ok).toBe(false);
      expect(summary.unsupportedCaptureRes.summary).toContain('DRIVER_UNSUPPORTED');

      expect(summary.lockedEvalAttempt.ok).toBe(false);
      expect(summary.lockedEvalAttempt.summary).toContain('DRIVER_EVAL_DISABLED');

      expect(summary.wrappedGpuRecordingRes.ok).toBe(true);
      expect(summary.wrappedGpuRecordingRes.summary).toContain('mimeType: "video/webm"');
      expect(summary.wrappedGpuRecordingRes.summary).toContain('byteLength: 48120');
      expect(summary.wrappedGpuRecordingRes.summary).toContain('modeUsed: viewport-gpu');
      expect(summary.wrappedGpuRecordingRes.summary).toContain('durationMs: 920');

      expect(summary.defaultOmittedEval).toBe(false);
      expect(summary.evalOk).toBe(true);
      expect(summary.evalSummary).toContain('"v2.4.0"');
      expect(summary.evalSummary).toContain('"Capture & Eval Workspace"');
      expect(summary.evalSummary).toContain('diagnostic from eval');
      // Diagnostics drained during ui_eval do not repeat on subsequent ui_observe
      expect(summary.subsequentObserveSummary).not.toContain('diagnostic from eval');
    } finally {
      await harness.close();
    }
  });
});
