import {
  DriverError,
  type DriverTool,
  type DriverToolExecutionContext,
  type DriverToolResult,
  type PageDriver,
} from '../types.js';
import {
  formatActResultYaml,
  formatCaptureResultYaml,
  formatEvalResultYaml,
  formatObservationYaml,
  formatToolErrorYaml,
  formatValidationErrorYaml,
} from './format.js';
import {
  UI_ACT_SCHEMA,
  UI_CAPTURE_SCHEMA,
  UI_EVAL_SCHEMA,
  UI_OBSERVE_SCHEMA,
  type UiActInput,
  type UiCaptureInput,
  type UiEvalInput,
  type UiObserveInput,
  parseUiActArgs,
  parseUiCaptureArgs,
  parseUiEvalArgs,
  parseUiObserveArgs,
} from './schemas.js';

export {
  formatActResultYaml,
  formatCaptureResultYaml,
  formatEvalResultYaml,
  formatObservationYaml,
  UI_ACT_SCHEMA,
  UI_CAPTURE_SCHEMA,
  UI_EVAL_SCHEMA,
  UI_OBSERVE_SCHEMA,
  type UiActInput,
  type UiCaptureInput,
  type UiEvalInput,
  type UiObserveInput,
};

export interface CreateDriverToolsOptions {
  readonly allowEval?: boolean;
  readonly maxYamlChars?: number;
}

export function createDriverTools(
  driver: PageDriver,
  options?: CreateDriverToolsOptions,
): DriverTool[] {
  const maxYamlChars = options?.maxYamlChars;
  const allowEval = options?.allowEval === true;

  const observeTool: DriverTool = {
    name: 'ui_observe',
    description:
      'Observe the live UI semantic tree, element refs, media/canvas state, and drained console/page/network/compile diagnostics.',
    parameters: UI_OBSERVE_SCHEMA,
    parallelSafe: false,
    pure: false,
    async execute(rawArgs: unknown, ctx?: DriverToolExecutionContext): Promise<DriverToolResult> {
      const parsed = parseUiObserveArgs(rawArgs);
      if (!parsed.ok) {
        return { ok: false, summary: formatValidationErrorYaml(parsed.error) };
      }
      try {
        const hasOptions =
          parsed.value.scope !== undefined ||
          parsed.value.includeAllText !== undefined ||
          ctx?.signal !== undefined;
        const snapshot = await driver.observe(
          hasOptions
            ? {
                ...(parsed.value.scope !== undefined ? { scope: parsed.value.scope } : {}),
                ...(parsed.value.includeAllText !== undefined
                  ? { includeAllText: parsed.value.includeAllText }
                  : {}),
                ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
              }
            : undefined,
        );
        return {
          ok: true,
          summary: formatObservationYaml(snapshot, maxYamlChars),
          data: snapshot,
        };
      } catch (err) {
        return { ok: false, summary: formatToolErrorYaml(err) };
      }
    },
  };

  const actTool: DriverTool = {
    name: 'ui_act',
    description:
      'Execute a transactional batch of UI steps in 1 RTT against a snapshot revision and return the compact diff plus diagnostics.',
    parameters: UI_ACT_SCHEMA,
    parallelSafe: false,
    pure: false,
    async execute(rawArgs: unknown, ctx?: DriverToolExecutionContext): Promise<DriverToolResult> {
      const parsed = parseUiActArgs(rawArgs);
      if (!parsed.ok) {
        return { ok: false, summary: formatValidationErrorYaml(parsed.error) };
      }
      try {
        const result = await driver.act({
          rev: parsed.value.rev,
          steps: parsed.value.steps,
          ...(parsed.value.timeoutMs !== undefined ? { timeoutMs: parsed.value.timeoutMs } : {}),
          ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        return {
          ok: result.interruptedReason === undefined,
          summary: formatActResultYaml(result, maxYamlChars),
          data: result,
        };
      } catch (err) {
        return { ok: false, summary: formatToolErrorYaml(err) };
      }
    },
  };

  const captureTool: DriverTool = {
    name: 'ui_capture',
    description:
      'Capture a visual screenshot (viewport or element target) or start/stop viewport video recording.',
    parameters: UI_CAPTURE_SCHEMA,
    parallelSafe: false,
    pure: false,
    async execute(rawArgs: unknown, ctx?: DriverToolExecutionContext): Promise<DriverToolResult> {
      const parsed = parseUiCaptureArgs(rawArgs);
      if (!parsed.ok) {
        return { ok: false, summary: formatValidationErrorYaml(parsed.error) };
      }
      try {
        const captureResult = await driver.capture({
          ...parsed.value,
          ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        return {
          ok: true,
          summary: formatCaptureResultYaml(captureResult),
          data: captureResult,
        };
      } catch (err) {
        return { ok: false, summary: formatToolErrorYaml(err) };
      }
    },
  };

  if (!allowEval) {
    return [observeTool, actTool, captureTool];
  }

  const evalTool: DriverTool = {
    name: 'ui_eval',
    description:
      'Evaluate a JavaScript expression inside the live guest page and return its sanitized value plus drained diagnostics.',
    parameters: UI_EVAL_SCHEMA,
    parallelSafe: false,
    pure: false,
    async execute(rawArgs: unknown, ctx?: DriverToolExecutionContext): Promise<DriverToolResult> {
      if (!driver.capabilities.allowEval) {
        return {
          ok: false,
          summary: formatToolErrorYaml(
            new DriverError(
              'DRIVER_EVAL_DISABLED',
              'JavaScript evaluation is disabled on this PageDriver (capabilities.allowEval is false).',
            ),
          ),
        };
      }
      const parsed = parseUiEvalArgs(rawArgs);
      if (!parsed.ok) {
        return { ok: false, summary: formatValidationErrorYaml(parsed.error) };
      }
      try {
        const evalResult = await driver.eval({
          expression: parsed.value.expression,
          ...(parsed.value.timeoutMs !== undefined ? { timeoutMs: parsed.value.timeoutMs } : {}),
          ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        return {
          ok: true,
          summary: formatEvalResultYaml(evalResult, maxYamlChars),
          data: evalResult,
        };
      } catch (err) {
        return { ok: false, summary: formatToolErrorYaml(err) };
      }
    },
  };

  return [observeTool, actTool, captureTool, evalTool];
}
