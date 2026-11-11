import { describe, expect, it } from 'vitest';
import {
  UI_ACT_SCHEMA,
  UI_CAPTURE_SCHEMA,
  UI_EVAL_SCHEMA,
  UI_OBSERVE_SCHEMA,
  createDriverTools,
  formatActResultYaml,
  formatCaptureResultYaml,
  formatEvalResultYaml,
  formatObservationYaml,
} from '../../src/tools/index.js';
import {
  type ActOptions,
  type ActResult,
  type CaptureOptions,
  type CaptureResult,
  DriverError,
  type DriverTool,
  type EvalOptions,
  type EvalResult,
  type ObservationOptions,
  type ObservationSnapshot,
  type PageDriver,
  type RefId,
  type SnapshotNode,
} from '../../src/types.js';

/**
 * Exact structural mirrors of `@inbrowser/agent` `ToolHandler` and
 * `@inbrowser/sandbox` `SandboxTool` under `exactOptionalPropertyTypes: true`.
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

interface AgentToolContext {
  signal: AbortSignal;
  workspace?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

interface AgentToolResult<D = unknown> {
  ok: boolean;
  summary: string;
  data?: D;
  workspacePatch?: Record<string, unknown>;
  runtimePatch?: Record<string, unknown>;
}

interface AgentToolHandler<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: AgentJsonSchema;
  available?(capabilities: Record<string, boolean>): boolean;
  parallelSafe?: boolean;
  pure?: boolean;
  execute(args: A, ctx: AgentToolContext): Promise<AgentToolResult<D>>;
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

function createFakeDriver(overrides?: {
  readonly allowEval?: boolean;
  readonly onObserve?: (options?: ObservationOptions) => Promise<ObservationSnapshot>;
  readonly onAct?: (options: ActOptions) => Promise<ActResult>;
  readonly onCapture?: (options: CaptureOptions) => Promise<CaptureResult>;
  readonly onEval?: (options: EvalOptions) => Promise<EvalResult>;
}): PageDriver {
  const allowEval = overrides?.allowEval ?? false;
  return {
    capabilities: {
      protocolVersion: 1,
      allowEval,
      captureModes: ['silent'],
      trustedInput: false,
    },
    async observe(options?: ObservationOptions): Promise<ObservationSnapshot> {
      if (overrides?.onObserve) return overrides.onObserve(options);
      return {
        rev: 1,
        url: 'http://localhost:4721/frame',
        title: 'Studio Workspace',
        viewport: { width: 1280, height: 720 },
        diagnostics: {
          compileOverlay: null,
          consoleErrors: [],
          pageErrors: [],
          networkFailures: [],
        },
        elements: [],
      };
    },
    async act(options: ActOptions): Promise<ActResult> {
      if (overrides?.onAct) return overrides.onAct(options);
      return {
        completedSteps: options.steps.length,
        totalSteps: options.steps.length,
        rev: options.rev + 1,
        url: 'http://localhost:4721/frame',
        title: 'Studio Workspace',
        diff: {
          fromRev: options.rev,
          toRev: options.rev + 1,
          fullReset: false,
          added: [],
          removed: [],
          changed: [],
        },
        diagnostics: {
          compileOverlay: null,
          consoleErrors: [],
          pageErrors: [],
          networkFailures: [],
        },
      };
    },
    async capture(options: CaptureOptions): Promise<CaptureResult> {
      if (overrides?.onCapture) return overrides.onCapture(options);
      throw new DriverError('DRIVER_UNSUPPORTED', 'Capture backend is not configured.');
    },
    async eval(options: EvalOptions): Promise<EvalResult> {
      if (overrides?.onEval) return overrides.onEval(options);
      if (!allowEval) {
        throw new DriverError('DRIVER_EVAL_DISABLED', 'Eval is disabled.');
      }
      return {
        value: null,
        diagnostics: {
          compileOverlay: null,
          consoleErrors: [],
          pageErrors: [],
          networkFailures: [],
        },
      };
    },
    dispose(): void {},
  };
}

describe('@inbrowser/driver/tools — tool surface, schemas, and argument validation', () => {
  it('gates ui_eval behind options.allowEval, sets parallelSafe/pure false, and assigns cleanly to ecosystem tool arrays', () => {
    const driver = createFakeDriver({ allowEval: true });

    const defaultTools = createDriverTools(driver);
    const evalEnabledTools = createDriverTools(driver, { allowEval: true });

    // Compile-time structural assignability without casts to readonly DriverTool[], AgentToolHandler[], and SandboxTool[]
    const readonlyDriverTools: readonly DriverTool[] = defaultTools;
    const agentDefaultTools: AgentToolHandler[] = createDriverTools(driver);
    const agentAllTools: AgentToolHandler[] = createDriverTools(driver, { allowEval: true });
    const sandboxDefaultTools: SandboxTool[] = createDriverTools(driver);
    const sandboxAllTools: SandboxTool[] = createDriverTools(driver, { allowEval: true });

    expect(readonlyDriverTools.map((t) => t.name)).toEqual(['ui_observe', 'ui_act', 'ui_capture']);
    expect(evalEnabledTools.map((t) => t.name)).toEqual([
      'ui_observe',
      'ui_act',
      'ui_capture',
      'ui_eval',
    ]);
    expect(agentDefaultTools).toHaveLength(3);
    expect(agentAllTools).toHaveLength(4);
    expect(sandboxDefaultTools).toHaveLength(3);
    expect(sandboxAllTools).toHaveLength(4);

    for (const tool of evalEnabledTools) {
      expect(tool.parallelSafe).toBe(false);
      expect(tool.pure).toBe(false);
      expect(tool.parameters.type).toBe('object');
    }

    expect(UI_OBSERVE_SCHEMA.type).toBe('object');
    expect(UI_ACT_SCHEMA.required).toEqual(['rev', 'steps']);
    expect(UI_CAPTURE_SCHEMA.required).toEqual(['mode']);
    expect(UI_EVAL_SCHEMA.required).toEqual(['expression']);
  });

  it('defensively validates malformed LLM arguments and normalizes target refs and whitespace scopes', async () => {
    let observedOptions: ObservationOptions | undefined;
    let actedOptions: ActOptions | undefined;

    const driver = createFakeDriver({
      allowEval: true,
      async onObserve(opts) {
        observedOptions = opts;
        return {
          rev: 2,
          url: 'http://localhost:4721/frame',
          title: 'Catalog',
          viewport: { width: 800, height: 600 },
          diagnostics: {
            compileOverlay: null,
            consoleErrors: [],
            pageErrors: [],
            networkFailures: [],
          },
          elements: [],
        };
      },
      async onAct(opts) {
        actedOptions = opts;
        return {
          completedSteps: opts.steps.length,
          totalSteps: opts.steps.length,
          rev: opts.rev + 1,
          url: 'http://localhost:4721/frame',
          title: 'Catalog',
          diff: {
            fromRev: opts.rev,
            toRev: opts.rev + 1,
            fullReset: false,
            added: [],
            removed: [],
            changed: [],
          },
          diagnostics: {
            compileOverlay: null,
            consoleErrors: [],
            pageErrors: [],
            networkFailures: [],
          },
        };
      },
    });

    const tools = createDriverTools(driver, { allowEval: true });
    const observeTool = tools.find((t) => t.name === 'ui_observe')!;
    const actTool = tools.find((t) => t.name === 'ui_act')!;
    const captureTool = tools.find((t) => t.name === 'ui_capture')!;
    const evalTool = tools.find((t) => t.name === 'ui_eval')!;

    // Malformed payloads return structured { ok: false } rather than throwing
    const badObserve = await observeTool.execute({ scope: 42 });
    expect(badObserve.ok).toBe(false);
    expect(badObserve.summary).toContain('scope');

    const badActMissingRev = await actTool.execute({ steps: [] });
    expect(badActMissingRev.ok).toBe(false);
    expect(badActMissingRev.summary).toContain('rev');

    const badActStep = await actTool.execute({
      rev: 1,
      steps: [{ kind: 'navigate', url: '/a', action: 'reload' }],
    });
    expect(badActStep.ok).toBe(false);
    expect(badActStep.summary).toContain('steps[0]');

    const badWaitStep = await actTool.execute({
      rev: 1,
      steps: [{ kind: 'waitFor' }],
    });
    expect(badWaitStep.ok).toBe(false);
    expect(badWaitStep.summary).toContain('waitFor');

    const badCapture = await captureTool.execute({ mode: 'screenshot', quality: 2.5 });
    expect(badCapture.ok).toBe(false);
    expect(badCapture.summary).toContain('quality');

    const badEval = await evalTool.execute({ expression: '   ' });
    expect(badEval.ok).toBe(false);
    expect(badEval.summary).toContain('expression');

    // Normalization: blank scope -> omitted; padded scope -> trimmed
    await observeTool.execute({ scope: '   ' });
    expect(observedOptions?.scope).toBeUndefined();

    await observeTool.execute({ scope: '  main  ', includeAllText: true });
    expect(observedOptions).toEqual({ scope: 'main', includeAllText: true });

    // Normalization: "[ref=e4]", " e7 ", and { ref: "e9" } normalize to canonical RefId strings
    const okAct = await actTool.execute({
      rev: 2,
      steps: [
        { kind: 'click', target: '[ref=e4]' },
        { kind: 'fill', target: ' e7 ', value: 'Clip A' },
        { kind: 'drag', from: { ref: 'e9' }, to: { target: 'ref=e10' } },
      ],
    });
    expect(okAct.ok).toBe(true);
    expect(actedOptions?.steps).toEqual([
      { kind: 'click', target: 'e4' },
      { kind: 'fill', target: 'e7', value: 'Clip A' },
      { kind: 'drag', from: 'e9', to: { target: 'e10' } },
    ]);
  });
});

describe('@inbrowser/driver/tools — formatObservationYaml', () => {
  it('renders compact ARIA hierarchy, media/canvas states, safe string escaping, clean diagnostics omission, and deterministic truncation', () => {
    const cleanSnap: ObservationSnapshot = {
      rev: 3,
      url: 'http://localhost:4721/frame',
      title: 'Editor "Main"\nView',
      viewport: { width: 1280, height: 720 },
      diagnostics: {
        compileOverlay: null,
        consoleErrors: [],
        pageErrors: [],
        networkFailures: [],
      },
      elements: [
        {
          role: 'main',
          name: 'editor',
          children: [
            {
              role: 'textbox',
              name: 'Clip Title',
              ref: 'e1',
              value: 'Line 1\n"Line 2"',
              disabled: false,
            },
            {
              role: 'slider',
              name: 'Gain',
              ref: 'e2',
              value: '20',
              min: 0,
              max: 100,
              disabled: false,
            },
            {
              role: 'checkbox',
              name: 'Mute',
              ref: 'e3',
              checked: true,
              disabled: true,
            },
            {
              role: 'combobox',
              name: 'Codec',
              ref: 'e4',
              value: 'av1',
              expanded: false,
              disabled: false,
            },
            {
              role: 'video',
              name: 'Preview Video',
              ref: 'e5',
              media: {
                kind: 'video',
                paused: true,
                currentTime: 0,
                duration: 12.5,
                width: 240,
                height: 135,
                ready: true,
                error: null,
              },
            },
            {
              role: 'canvas',
              name: 'Waveform',
              ref: 'e6',
              canvas: {
                width: 300,
                height: 80,
                nonBlank: true,
              },
            },
          ],
        },
      ],
    };

    const yaml = formatObservationYaml(cleanSnap);
    expect(yaml).not.toContain('diagnostics:');
    expect(yaml).toContain('rev: 3');
    expect(yaml).toContain('url: "http://localhost:4721/frame"');
    expect(yaml).toContain('title: "Editor \\"Main\\"\\nView"');
    expect(yaml).toContain('viewport: 1280x720');
    expect(yaml).toContain('- main "editor":');
    expect(yaml).toContain('  - textbox "Clip Title" [ref=e1] value="Line 1\\n\\"Line 2\\""');
    expect(yaml).toContain('  - slider "Gain" [ref=e2] value="20" min=0 max=100');
    expect(yaml).toContain('  - checkbox "Mute" [ref=e3] checked=true disabled');
    expect(yaml).toContain('  - combobox "Codec" [ref=e4] value="av1" expanded=false');
    expect(yaml).toContain(
      '  - video "Preview Video" [ref=e5] paused time=0/12.5 size=240x135 ready',
    );
    expect(yaml).toContain('  - canvas "Waveform" [ref=e6] size=300x80 nonBlank=true');

    // Non-empty diagnostics render prominently before elements
    const dirtySnap: ObservationSnapshot = {
      ...cleanSnap,
      diagnostics: {
        compileOverlay: 'SyntaxError: Unexpected token (panel.tsx:9:4)',
        consoleErrors: ['Failed to load preset'],
        pageErrors: ['TypeError: track is undefined'],
        networkFailures: [
          {
            method: 'POST',
            url: 'http://localhost:4721/api/render',
            status: 503,
            statusText: 'Service Unavailable',
          },
        ],
      },
    };
    const dirtyYaml = formatObservationYaml(dirtySnap);
    expect(dirtyYaml).toContain('diagnostics:');
    expect(dirtyYaml).toContain('compileOverlay: "SyntaxError: Unexpected token (panel.tsx:9:4)"');
    expect(dirtyYaml).toContain('consoleErrors:');
    expect(dirtyYaml).toContain('pageErrors:');
    expect(dirtyYaml).toContain(
      '503 POST "http://localhost:4721/api/render" "Service Unavailable"',
    );
    expect(dirtyYaml.indexOf('diagnostics:')).toBeLessThan(dirtyYaml.indexOf('elements:'));

    // Deterministic maxChars truncation with exact trailer
    const truncated = formatObservationYaml(cleanSnap, 180);
    const secondTruncated = formatObservationYaml(cleanSnap, 180);
    expect(truncated).toBe(secondTruncated);
    expect(truncated.length).toBeLessThanOrEqual(180);
    expect(truncated).toMatch(/\.\.\. \(truncated \d+ chars; pass scope to narrow\)$/);
  });
});

function makeRefId(index: number): RefId {
  // Invariant: positive integer index produces canonical eN RefId literal
  return `e${String(index)}` as RefId;
}

function buildMultiControlWorkspaceSnapshot(rev: number): ObservationSnapshot {
  const controls: SnapshotNode[] = [
    {
      role: 'textbox',
      name: 'Sequence Title',
      ref: 'e2',
      value: 'Draft Sequence',
      disabled: false,
    },
    { role: 'combobox', name: 'Export Preset', ref: 'e3', value: 'standard', expanded: false },
    { role: 'button', name: 'Save Sequence', ref: 'e4' },
    { role: 'status', name: 'Idle' },
  ];
  for (let i = 1; i <= 42; i += 1) {
    controls.push({
      role: i % 3 === 0 ? 'slider' : i % 2 === 0 ? 'checkbox' : 'button',
      name: `Timeline Track Control ${String(i)}`,
      ref: makeRefId(i + 4),
      ...(i % 3 === 0 ? { value: '50', min: 0, max: 100 } : {}),
      ...(i % 2 === 0 && i % 3 !== 0 ? { checked: false } : {}),
    });
  }
  return {
    rev,
    url: 'http://localhost:4721/workspace',
    title: 'Timeline Studio Workspace',
    viewport: { width: 1440, height: 900 },
    diagnostics: {
      compileOverlay: null,
      consoleErrors: [],
      pageErrors: [],
      networkFailures: [],
    },
    elements: [
      {
        role: 'main',
        name: 'workspace',
        ref: 'e1',
        children: controls,
      },
    ],
  };
}

describe('@inbrowser/driver/tools — formatActResultYaml and partial ui_act results', () => {
  it('achieves >= 75% character reduction on localized updates across a 45+ control workspace and formats none/added/removed/fullReset diffs', () => {
    const fullSnapshot = buildMultiControlWorkspaceSnapshot(1);
    const fullObserveYaml = formatObservationYaml(fullSnapshot);

    const localizedActResult: ActResult = {
      completedSteps: 3,
      totalSteps: 3,
      rev: 2,
      url: 'http://localhost:4721/workspace',
      title: 'Timeline Studio Workspace',
      diff: {
        fromRev: 1,
        toRev: 2,
        fullReset: false,
        added: [],
        removed: [],
        changed: [
          { role: 'textbox', name: 'Sequence Title', ref: 'e2', value: 'Final Master' },
          { role: 'combobox', name: 'Export Preset', ref: 'e3', value: 'uhd', expanded: false },
          { role: 'status', name: 'Saved: Final Master (uhd)' },
        ],
      },
      diagnostics: {
        compileOverlay: null,
        consoleErrors: [],
        pageErrors: [],
        networkFailures: [],
      },
    };

    const actYaml = formatActResultYaml(localizedActResult);
    expect(actYaml).toContain('status: ok');
    expect(actYaml).toContain('steps: 3/3');
    expect(actYaml).toContain('rev: 2');
    expect(actYaml).toContain('  changed:');
    expect(actYaml).toContain('- textbox "Sequence Title" [ref=e2] value="Final Master"');
    expect(actYaml).not.toContain('added:');
    expect(actYaml).not.toContain('removed:');

    const reductionRatio = 1 - actYaml.length / fullObserveYaml.length;
    expect(reductionRatio).toBeGreaterThanOrEqual(0.75);

    // No-op diff renders `diff: none`
    const noChangeYaml = formatActResultYaml({
      ...localizedActResult,
      diff: { fromRev: 2, toRev: 3, fullReset: false, added: [], removed: [], changed: [] },
    });
    expect(noChangeYaml).toContain('diff: none');

    // Added subtree + removed refs render compactly
    const addedRemovedYaml = formatActResultYaml({
      ...localizedActResult,
      diff: {
        fromRev: 2,
        toRev: 3,
        fullReset: false,
        added: [
          {
            role: 'dialog',
            name: 'Export Summary',
            ref: 'e50',
            children: [{ role: 'button', name: 'Close', ref: 'e51' }],
          },
        ],
        removed: ['e4', 'e7'],
        changed: [],
      },
    });
    expect(addedRemovedYaml).toContain('  added:');
    expect(addedRemovedYaml).toContain('    - dialog "Export Summary" [ref=e50]:');
    expect(addedRemovedYaml).toContain('      - button "Close" [ref=e51]');
    expect(addedRemovedYaml).toContain('  removed: [e4, e7]');

    // Cross-page navigation fullReset renders fullReset: true + elements
    const fullResetYaml = formatActResultYaml({
      completedSteps: 1,
      totalSteps: 1,
      rev: 4,
      url: 'http://localhost:4721/catalog',
      title: 'Asset Catalog',
      diff: {
        fromRev: 3,
        toRev: 4,
        fullReset: true,
        added: [],
        removed: [],
        changed: [],
        elements: [
          {
            role: 'main',
            name: 'catalog',
            ref: 'e1',
            children: [{ role: 'button', name: 'Import Clip', ref: 'e2' }],
          },
        ],
      },
      diagnostics: {
        compileOverlay: null,
        consoleErrors: [],
        pageErrors: [],
        networkFailures: [],
      },
    });
    expect(fullResetYaml).toContain('  fullReset: true');
    expect(fullResetYaml).toContain('    - main "catalog" [ref=e1]:');
    expect(fullResetYaml).toContain('      - button "Import Clip" [ref=e2]');
  });

  it('returns ok: false while always preserving partial ActResult data across all interruption reasons', async () => {
    const reasons = [
      'step_error',
      'compile_error',
      'dialog_opened',
      'navigation',
      'user_takeover',
    ] as const;

    for (const reason of reasons) {
      const partialResult: ActResult = {
        completedSteps: 1,
        totalSteps: 3,
        interruptedReason: reason,
        ...(reason === 'step_error' ? { error: 'Target button is disabled' } : {}),
        rev: 5,
        url: 'http://localhost:4721/workspace',
        title: 'Timeline Studio Workspace',
        diff: {
          fromRev: 4,
          toRev: 5,
          fullReset: reason === 'navigation',
          added: [],
          removed: [],
          changed: [{ role: 'status', name: `halted:${reason}` }],
          ...(reason === 'navigation' ? { elements: [] } : {}),
        },
        diagnostics: {
          compileOverlay: reason === 'compile_error' ? 'SyntaxError in timeline.tsx' : null,
          consoleErrors: [],
          pageErrors: [],
          networkFailures: [],
        },
      };

      const driver = createFakeDriver({
        async onAct() {
          return partialResult;
        },
      });
      const actTool = createDriverTools(driver).find((t) => t.name === 'ui_act')!;
      const toolRes = await actTool.execute({
        rev: 4,
        steps: [
          { kind: 'click', target: 'e1' },
          { kind: 'click', target: 'e2' },
          { kind: 'click', target: 'e3' },
        ],
      });

      expect(toolRes.ok).toBe(false);
      expect(toolRes.data).toEqual(partialResult);
      expect(toolRes.summary).toContain(`interrupted: ${reason}`);
      expect(toolRes.summary).toContain('steps: 1/3');
      expect(toolRes.summary).toContain('rev: 5');
      if (reason === 'step_error') {
        expect(toolRes.summary).toContain('error: "Target button is disabled"');
      }
      if (reason === 'compile_error') {
        expect(toolRes.summary).toContain('SyntaxError in timeline.tsx');
      }
    }
  });
});

describe('@inbrowser/driver/tools — ui_capture, ui_eval, AbortSignal forwarding, and candidate errors', () => {
  it('formats capture metadata compactly without dumping binary bytes and reports recording durationMs', async () => {
    const largeBytes = new Uint8Array(256_000);
    largeBytes.fill(0xab);

    const screenshotResult: CaptureResult = {
      mimeType: 'image/webp',
      bytes: largeBytes,
      width: 1280,
      height: 720,
      modeUsed: 'silent',
    };
    const recordingResult: CaptureResult = {
      mimeType: 'video/webm',
      bytes: new Uint8Array([1, 2, 3, 4]),
      width: 1280,
      height: 720,
      modeUsed: 'viewport-gpu',
      durationMs: 1840,
    };

    const shotYaml = formatCaptureResultYaml(screenshotResult);
    expect(shotYaml).toContain('mimeType: "image/webp"');
    expect(shotYaml).toContain('width: 1280');
    expect(shotYaml).toContain('height: 720');
    expect(shotYaml).toContain('byteLength: 256000');
    expect(shotYaml).toContain('modeUsed: silent');
    expect(shotYaml).not.toContain('durationMs');
    expect(shotYaml.length).toBeLessThan(240);

    const recYaml = formatCaptureResultYaml(recordingResult);
    expect(recYaml).toContain('mimeType: "video/webm"');
    expect(recYaml).toContain('modeUsed: viewport-gpu');
    expect(recYaml).toContain('byteLength: 4');
    expect(recYaml).toContain('durationMs: 1840');

    const driver = createFakeDriver({
      async onCapture(opts) {
        return opts.mode === 'stop_recording' ? recordingResult : screenshotResult;
      },
    });
    const captureTool = createDriverTools(driver).find((t) => t.name === 'ui_capture')!;
    const res = await captureTool.execute({
      mode: 'screenshot',
      target: '[ref=e2]',
      format: 'webp',
    });
    expect(res.ok).toBe(true);
    expect(res.data).toBe(screenshotResult);
    expect(res.summary).toBe(shotYaml);
  });

  it('enforces ui_eval capability checks, formats eval values + diagnostics safely, and truncates huge outputs', async () => {
    // 1. Driver with capabilities.allowEval === false rejects cleanly even if tool created with { allowEval: true }
    const lockedDriver = createFakeDriver({ allowEval: false });
    const lockedEvalTool = createDriverTools(lockedDriver, { allowEval: true }).find(
      (t) => t.name === 'ui_eval',
    )!;
    const lockedRes = await lockedEvalTool.execute({ expression: 'document.title' });
    expect(lockedRes.ok).toBe(false);
    expect(lockedRes.summary).toContain('DRIVER_EVAL_DISABLED');

    // 2. Driver whose eval() throws DRIVER_EVAL_DISABLED is caught cleanly
    const throwingEvalDriver = createFakeDriver({
      allowEval: true,
      async onEval() {
        throw new DriverError('DRIVER_EVAL_DISABLED', 'Guest frame rejected eval.');
      },
    });
    const throwingEvalTool = createDriverTools(throwingEvalDriver, { allowEval: true }).find(
      (t) => t.name === 'ui_eval',
    )!;
    const thrownRes = await throwingEvalTool.execute({ expression: '1 + 1' });
    expect(thrownRes.ok).toBe(false);
    expect(thrownRes.summary).toContain('DRIVER_EVAL_DISABLED');
    expect(thrownRes.summary).toContain('Guest frame rejected eval.');

    // 3. Circular/BigInt/diagnostic formatting + maxChars truncation
    const circular: Record<string, unknown> = { label: 'node', count: 12n };
    circular['self'] = circular;
    const evalYaml = formatEvalResultYaml({
      value: circular,
      diagnostics: {
        compileOverlay: null,
        consoleErrors: ['warn: deprecated API'],
        pageErrors: [],
        networkFailures: [],
      },
    });
    expect(evalYaml).toContain('status: ok');
    expect(evalYaml).toContain('"12n"');
    expect(evalYaml).toContain('"[Circular]"');
    expect(evalYaml).toContain('consoleErrors:');
    expect(evalYaml).toContain('warn: deprecated API');

    const hugeEvalYaml = formatEvalResultYaml(
      {
        value: { payload: 'x'.repeat(500) },
        diagnostics: {
          compileOverlay: null,
          consoleErrors: [],
          pageErrors: [],
          networkFailures: [],
        },
      },
      140,
    );
    expect(hugeEvalYaml.length).toBeLessThanOrEqual(140);
    expect(hugeEvalYaml).toMatch(/\.\.\. \(truncated \d+ chars; pass scope to narrow\)$/);
  });

  it('forwards AbortSignal to driver methods and formats candidate hints on DRIVER_TARGET_NOT_FOUND and DRIVER_TARGET_AMBIGUOUS', async () => {
    const receivedSignals: Array<AbortSignal | undefined> = [];

    const driver = createFakeDriver({
      allowEval: true,
      async onObserve(opts) {
        receivedSignals.push(opts?.signal);
        throw new DriverError('DRIVER_TARGET_NOT_FOUND', 'Scope "inspector" was not found.', {
          candidates: [
            { role: 'region', name: 'Inspector Panel', nth: 0, landmark: 'main "workspace"' },
            { role: 'region', name: 'Timeline Panel', nth: 0 },
          ],
        });
      },
      async onAct(opts) {
        receivedSignals.push(opts.signal);
        throw new DriverError('DRIVER_TIMEOUT', 'Action aborted by signal.');
      },
      async onCapture(opts) {
        receivedSignals.push(opts.signal);
        throw new DriverError('DRIVER_TARGET_AMBIGUOUS', 'Target matched 2 buttons.', {
          candidates: [
            { role: 'button', name: 'Duplicate Track', nth: 0 },
            { role: 'button', name: 'Duplicate Track', nth: 1 },
          ],
        });
      },
      async onEval(opts) {
        receivedSignals.push(opts.signal);
        throw new Error('Unexpected guest bridge disconnect');
      },
    });

    const controller = new AbortController();
    const tools = createDriverTools(driver, { allowEval: true });
    const [obsTool, actTool, capTool, evalTool] = tools;

    const obsErr = await obsTool!.execute({ scope: 'inspector' }, { signal: controller.signal });
    expect(obsErr.ok).toBe(false);
    expect(obsErr.summary).toContain('DRIVER_TARGET_NOT_FOUND');
    expect(obsErr.summary).toContain('candidates:');
    expect(obsErr.summary).toContain('Inspector Panel');
    expect(obsErr.summary).toContain('landmark="main \\"workspace\\""');

    const actErr = await actTool!.execute(
      { rev: 1, steps: [{ kind: 'click', target: 'e1' }] },
      { signal: controller.signal },
    );
    expect(actErr.ok).toBe(false);
    expect(actErr.summary).toContain('DRIVER_TIMEOUT');

    const capErr = await capTool!.execute(
      { mode: 'screenshot', target: { role: 'button', name: 'Duplicate Track' } },
      { signal: controller.signal },
    );
    expect(capErr.ok).toBe(false);
    expect(capErr.summary).toContain('DRIVER_TARGET_AMBIGUOUS');
    expect(capErr.summary).toContain('nth=0');
    expect(capErr.summary).toContain('nth=1');

    const evalErr = await evalTool!.execute(
      { expression: 'window.status' },
      { signal: controller.signal },
    );
    expect(evalErr.ok).toBe(false);
    expect(evalErr.summary).toContain('UNEXPECTED_ERROR');
    expect(evalErr.summary).toContain('Unexpected guest bridge disconnect');

    expect(receivedSignals).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });

  it('recognizes cross-bundle DriverError shapes and normalizes ARIA-line / ref scopes in ui_observe', async () => {
    let seenScope: string | undefined;
    class SeparateBundleDriverError extends Error {
      readonly code = 'DRIVER_TARGET_NOT_FOUND';
      readonly candidates = [{ role: 'region', name: 'inspector', nth: 0 }];
      constructor(message: string) {
        super(message);
        this.name = 'DriverError';
      }
    }

    const driver = createFakeDriver({
      async onObserve(opts) {
        seenScope = opts?.scope;
        if (opts?.scope === 'region:missing') {
          throw new SeparateBundleDriverError('Unmatched scope "region:missing".');
        }
        return {
          rev: 1,
          url: 'http://localhost:4721/frame',
          title: 'Workspace',
          viewport: { width: 800, height: 600 },
          diagnostics: {
            compileOverlay: null,
            consoleErrors: [],
            pageErrors: [],
            networkFailures: [],
          },
          elements: [],
        };
      },
    });

    const obsTool = createDriverTools(driver).find((t) => t.name === 'ui_observe')!;

    await obsTool.execute({ scope: '[ref=e5]' });
    expect(seenScope).toBe('e5');

    await obsTool.execute({ scope: 'region "inspector":' });
    expect(seenScope).toBe('region:inspector');

    const crossBundleErr = await obsTool.execute({ scope: 'region "missing"' });
    expect(crossBundleErr.ok).toBe(false);
    expect(crossBundleErr.summary).toContain('code: DRIVER_TARGET_NOT_FOUND');
    expect(crossBundleErr.summary).toContain('candidates:');
    expect(crossBundleErr.summary).toContain('name="inspector"');
  });

  it('formats driverId and intent annotations in YAML and parses { driver, nth? } and driver: shorthand targets', async () => {
    const capturedActs: ActOptions[] = [];
    const capturedScopes: Array<string | undefined> = [];
    const capturedShots: CaptureOptions[] = [];

    const driver = createFakeDriver({
      async onObserve(opts) {
        capturedScopes.push(opts?.scope);
        return {
          rev: 3,
          url: 'http://localhost:4721/frame',
          title: 'Workspace',
          viewport: { width: 1024, height: 640 },
          diagnostics: {
            compileOverlay: null,
            consoleErrors: [],
            pageErrors: [],
            networkFailures: [],
          },
          elements: [
            {
              role: 'region',
              name: 'Inspector',
              ref: 'e1',
              driverId: 'inspector.panel',
              intent: 'Lists active validation issues',
              children: [
                {
                  role: 'button',
                  name: 'L4:47 Undefined token',
                  ref: 'e2',
                  driverId: 'inspector.issue',
                  intent: 'Selects issue and scrolls editor to line',
                },
              ],
            },
          ],
        };
      },
      async onAct(opts) {
        capturedActs.push(opts);
        return {
          completedSteps: opts.steps.length,
          totalSteps: opts.steps.length,
          rev: opts.rev + 1,
          url: 'http://localhost:4721/frame',
          title: 'Workspace',
          diff: {
            fromRev: opts.rev,
            toRev: opts.rev + 1,
            fullReset: false,
            added: [],
            removed: [],
            changed: [
              {
                role: 'textbox',
                name: 'Source',
                ref: 'e3',
                driverId: 'editor.source',
                value: 'updated',
              },
            ],
          },
          diagnostics: {
            compileOverlay: null,
            consoleErrors: [],
            pageErrors: [],
            networkFailures: [],
          },
        };
      },
      async onCapture(opts) {
        capturedShots.push(opts);
        return {
          mimeType: 'image/webp',
          bytes: new Uint8Array([1, 2, 3]),
          width: 320,
          height: 180,
          modeUsed: 'silent',
        };
      },
    });

    const tools = createDriverTools(driver);
    const obsTool = tools.find((t) => t.name === 'ui_observe')!;
    const actTool = tools.find((t) => t.name === 'ui_act')!;
    const capTool = tools.find((t) => t.name === 'ui_capture')!;

    const obsRes = await obsTool.execute({ scope: 'driver:inspector.panel' });
    expect(obsRes.ok).toBe(true);
    expect(capturedScopes[0]).toBe('driver:inspector.panel');
    expect(obsRes.summary).toContain(
      '- region "Inspector" [ref=e1] [driver=inspector.panel] intent="Lists active validation issues":',
    );
    expect(obsRes.summary).toContain(
      '  - button "L4:47 Undefined token" [ref=e2] [driver=inspector.issue] intent="Selects issue and scrolls editor to line"',
    );

    const slashYaml = formatObservationYaml({
      rev: 1,
      url: 'http://localhost:4721/frame',
      title: 'Nav',
      viewport: { width: 800, height: 600 },
      diagnostics: {
        compileOverlay: null,
        consoleErrors: [],
        pageErrors: [],
        networkFailures: [],
      },
      elements: [{ role: 'link', name: 'Home', ref: 'e1', driverId: 'nav/home' }],
    });
    expect(slashYaml).toContain('- link "Home" [ref=e1] [driver=nav/home]');

    await obsTool.execute({ scope: '[driver=editor.source]' });
    expect(capturedScopes[1]).toBe('driver:editor.source');

    const actRes = await actTool.execute({
      rev: 3,
      steps: [
        { kind: 'click', target: { driver: 'inspector.issue', nth: 1 } },
        { kind: 'fill', target: 'driver:editor.source', value: 'updated' },
      ],
    });
    expect(actRes.ok).toBe(true);
    expect(capturedActs[0]?.steps).toEqual([
      { kind: 'click', target: { driver: 'inspector.issue', nth: 1 } },
      { kind: 'fill', target: { driver: 'editor.source' }, value: 'updated' },
    ]);
    expect(actRes.summary).toContain('[driver=editor.source]');

    const capRes = await capTool.execute({
      mode: 'screenshot',
      target: { driver: 'inspector.panel' },
    });
    expect(capRes.ok).toBe(true);
    expect(capturedShots[0]).toEqual({
      mode: 'screenshot',
      target: { driver: 'inspector.panel' },
    });

    const badDriverRes = await actTool.execute({
      rev: 3,
      steps: [{ kind: 'click', target: { driver: '   ' } }],
    });
    expect(badDriverRes.ok).toBe(false);
    expect(badDriverRes.summary).toContain('INVALID_ARGUMENTS');
  });
});
