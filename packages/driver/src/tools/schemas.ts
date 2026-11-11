import { isPosSafeInt, isRecord } from '../protocol.js';
import type {
  CaptureOptions,
  DragDestination,
  DriverJsonSchema,
  DriverStep,
  RefId,
  SnapshotRevision,
  TargetSpec,
} from '../types.js';

export interface UiObserveInput {
  readonly scope?: string;
  readonly includeAllText?: boolean;
}

export interface UiActInput {
  readonly rev: SnapshotRevision;
  readonly steps: readonly DriverStep[];
  readonly timeoutMs?: number;
}

export interface UiCaptureInput {
  readonly mode: 'screenshot' | 'start_recording' | 'stop_recording';
  readonly target?: TargetSpec;
  readonly format?: 'webp' | 'png';
  readonly quality?: number;
}

export interface UiEvalInput {
  readonly expression: string;
  readonly timeoutMs?: number;
}

export type ParseArgsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const TARGET_SPEC_SCHEMA: DriverJsonSchema = {
  description:
    'Element ref from ui_observe (e.g. "e3"), data-driver query ({ driver, nth? } or "driver:editor.source"), role query ({ role, name?, nth? }), or text query ({ text, exact? }).',
  anyOf: [
    {
      type: 'string',
      description: 'Element ref ID from ui_observe (e.g. "e1") or "driver:<id>" shorthand.',
    },
    {
      type: 'object',
      properties: {
        driver: {
          type: 'string',
          description: 'Namespaced data-driver attribute value (e.g. "editor.source").',
        },
        nth: { type: 'integer', description: 'Zero-based index among matching elements.' },
      },
      required: ['driver'],
    },
    {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'ARIA role such as "button", "textbox", or "slider".',
        },
        name: { type: 'string', description: 'Accessible name to match.' },
        nth: { type: 'integer', description: 'Zero-based index among matching elements.' },
      },
      required: ['role'],
    },
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text content to match.' },
        exact: { type: 'boolean', description: 'Require exact full-text match when true.' },
      },
      required: ['text'],
    },
  ],
};

const DRAG_DESTINATION_SCHEMA: DriverJsonSchema = {
  description:
    'Drop destination: { target }, relative offset { deltaX, deltaY }, or viewport point { clientX, clientY }.',
  type: 'object',
  properties: {
    target: TARGET_SPEC_SCHEMA,
    deltaX: { type: 'number' },
    deltaY: { type: 'number' },
    clientX: { type: 'number' },
    clientY: { type: 'number' },
  },
};

const DRIVER_STEP_SCHEMA: DriverJsonSchema = {
  type: 'object',
  description:
    'Single UI action step: click, fill, setValue, select, press, drag, navigate, or waitFor.',
  properties: {
    kind: {
      type: 'string',
      enum: ['click', 'fill', 'setValue', 'select', 'press', 'drag', 'navigate', 'waitFor'],
      description: 'Action step discriminant.',
    },
    target: TARGET_SPEC_SCHEMA,
    button: {
      type: 'string',
      enum: ['left', 'middle', 'right'],
      description: 'Mouse button for click steps.',
    },
    clickCount: {
      type: 'integer',
      description: 'Click count (e.g. 2 for double-click).',
    },
    value: {
      description:
        'Text string (fill), string/number (setValue), or option string/string[] (select).',
    },
    submit: {
      type: 'boolean',
      description: 'Submit enclosing form after fill when true.',
    },
    key: {
      type: 'string',
      description: 'Key or chord for press steps (e.g. "Enter", "Control+a").',
    },
    from: TARGET_SPEC_SCHEMA,
    to: DRAG_DESTINATION_SCHEMA,
    steps: {
      type: 'integer',
      description: 'Intermediate pointer move steps for drag.',
    },
    url: {
      type: 'string',
      description: 'Destination URL for navigate steps (mutually exclusive with action).',
    },
    action: {
      type: 'string',
      enum: ['reload', 'back', 'forward'],
      description: 'History navigation action (mutually exclusive with url).',
    },
    text: {
      type: 'string',
      description: 'Substring text to await in waitFor steps.',
    },
    state: {
      type: 'string',
      enum: ['attached', 'visible', 'hidden', 'detached'],
      description: 'Target element state to await in waitFor steps.',
    },
    idleMs: {
      type: 'number',
      description: 'Network and DOM quiet window in milliseconds for waitFor steps.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Per-step waitFor timeout in milliseconds.',
    },
  },
  required: ['kind'],
};

export const UI_OBSERVE_SCHEMA: DriverJsonSchema = {
  type: 'object',
  description:
    'Observe the live UI semantic tree, element refs, media/canvas state, and drained console/page/network/compile diagnostics.',
  properties: {
    scope: {
      type: 'string',
      description:
        'Optional ref ID (e.g. "e2"), driver prefix ("driver:composer"), role/landmark ("main" or "region:inspector"), or CSS selector ("#inspector") to narrow observation.',
    },
    includeAllText: {
      type: 'boolean',
      description: 'Include non-interactive static text nodes when true.',
    },
  },
};

export const UI_ACT_SCHEMA: DriverJsonSchema = {
  type: 'object',
  description:
    'Execute an ordered transactional batch of UI steps in 1 RTT against a snapshot revision and return the compact UI diff plus diagnostics.',
  properties: {
    rev: {
      type: 'integer',
      description:
        'Snapshot revision from the latest ui_observe or ui_act result (pass 0 if unobserved).',
    },
    steps: {
      type: 'array',
      description:
        'Ordered transactional UI steps to execute sequentially until completion or guard halt.',
      items: DRIVER_STEP_SCHEMA,
    },
    timeoutMs: {
      type: 'number',
      description: 'Optional actionability and batch timeout in milliseconds.',
    },
  },
  required: ['rev', 'steps'],
};

export const UI_CAPTURE_SCHEMA: DriverJsonSchema = {
  type: 'object',
  description:
    'Capture a visual screenshot (viewport or element target) or start/stop viewport video recording.',
  properties: {
    mode: {
      type: 'string',
      enum: ['screenshot', 'start_recording', 'stop_recording'],
      description: 'Capture operation mode.',
    },
    target: TARGET_SPEC_SCHEMA,
    format: {
      type: 'string',
      enum: ['webp', 'png'],
      description: 'Screenshot image format when mode is "screenshot" (default "webp").',
    },
    quality: {
      type: 'number',
      description: 'Encoding quality between 0 and 1 when format is "webp".',
    },
  },
  required: ['mode'],
};

export const UI_EVAL_SCHEMA: DriverJsonSchema = {
  type: 'object',
  description:
    'Evaluate a JavaScript expression inside the live guest page and return its sanitized value plus drained diagnostics.',
  properties: {
    expression: {
      type: 'string',
      description: 'JavaScript expression or async IIFE to evaluate in the page context.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Optional evaluation timeout in milliseconds.',
    },
  },
  required: ['expression'],
};

function isCanonicalRefId(value: string): value is RefId {
  return /^e\d+$/.test(value);
}

function isNonNegSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegFinite(value: unknown): value is number {
  return isFiniteNum(value) && value >= 0;
}

function parseRefIdLike(raw: string): RefId | null {
  const trimmed = raw.trim();
  const match = /^(?:\[?\s*ref\s*=\s*(e\d+)\s*\]?|@?(e\d+))$/i.exec(trimmed);
  if (!match) return null;
  const candidate = (match[1] ?? match[2] ?? '').toLowerCase();
  return isCanonicalRefId(candidate) ? candidate : null;
}

function parseDriverIdLike(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^(?:driver\s*:\s*(.+)|\[\s*driver\s*=\s*([^\]]+)\s*\])$/i.exec(trimmed);
  if (!match) return null;
  const val = (match[1] ?? match[2] ?? '').trim().replace(/^["']|["']$/g, '');
  return val.length > 0 ? val : null;
}

export function parseTargetSpec(raw: unknown, pathLabel: string): ParseArgsResult<TargetSpec> {
  if (typeof raw === 'string') {
    const refId = parseRefIdLike(raw);
    if (refId !== null) {
      return { ok: true, value: refId };
    }
    const driverId = parseDriverIdLike(raw);
    if (driverId !== null) {
      return { ok: true, value: { driver: driverId } };
    }
    return {
      ok: false,
      error: `Invalid ${pathLabel}: string target "${raw}" is not a ref ID (expected e.g. "e1", "driver:<id>", { driver, nth? }, { role, name? }, or { text }).`,
    };
  }

  if (!isRecord(raw)) {
    return {
      ok: false,
      error: `Invalid ${pathLabel}: expected ref string (e.g. "e1"), { driver, nth? }, { role, name?, nth? }, or { text, exact? }.`,
    };
  }

  if (
    typeof raw['ref'] === 'string' &&
    raw['role'] === undefined &&
    raw['driver'] === undefined &&
    raw['text'] === undefined
  ) {
    const refId = parseRefIdLike(raw['ref']);
    if (refId !== null) {
      return { ok: true, value: refId };
    }
    return {
      ok: false,
      error: `Invalid ${pathLabel}.ref: expected ref ID such as "e1".`,
    };
  }

  if (raw['driver'] !== undefined) {
    if (typeof raw['driver'] !== 'string' || raw['driver'].trim().length === 0) {
      return {
        ok: false,
        error: `Invalid ${pathLabel}.driver: expected a non-empty data-driver string.`,
      };
    }
    if (raw['nth'] !== undefined && !isNonNegSafeInt(raw['nth'])) {
      return {
        ok: false,
        error: `Invalid ${pathLabel}.nth: expected a non-negative integer.`,
      };
    }
    return {
      ok: true,
      value: {
        driver: raw['driver'].trim(),
        ...(raw['nth'] !== undefined ? { nth: raw['nth'] } : {}),
      },
    };
  }

  if (raw['role'] !== undefined) {
    if (typeof raw['role'] !== 'string' || raw['role'].trim().length === 0) {
      return {
        ok: false,
        error: `Invalid ${pathLabel}.role: expected a non-empty ARIA role string.`,
      };
    }
    if (raw['name'] !== undefined && typeof raw['name'] !== 'string') {
      return {
        ok: false,
        error: `Invalid ${pathLabel}.name: expected a string.`,
      };
    }
    if (raw['nth'] !== undefined && !isNonNegSafeInt(raw['nth'])) {
      return {
        ok: false,
        error: `Invalid ${pathLabel}.nth: expected a non-negative integer.`,
      };
    }
    return {
      ok: true,
      value: {
        role: raw['role'].trim(),
        ...(raw['name'] !== undefined ? { name: raw['name'] } : {}),
        ...(raw['nth'] !== undefined ? { nth: raw['nth'] } : {}),
      },
    };
  }

  if (raw['text'] !== undefined) {
    if (typeof raw['text'] !== 'string' || raw['text'].length === 0) {
      return {
        ok: false,
        error: `Invalid ${pathLabel}.text: expected a non-empty string.`,
      };
    }
    if (raw['exact'] !== undefined && typeof raw['exact'] !== 'boolean') {
      return {
        ok: false,
        error: `Invalid ${pathLabel}.exact: expected a boolean.`,
      };
    }
    return {
      ok: true,
      value: {
        text: raw['text'],
        ...(raw['exact'] !== undefined ? { exact: raw['exact'] } : {}),
      },
    };
  }

  return {
    ok: false,
    error: `Invalid ${pathLabel}: target object must specify "role" or "text" (or pass a ref string like "e1").`,
  };
}

function parseDragDestination(raw: unknown, pathLabel: string): ParseArgsResult<DragDestination> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: `Invalid ${pathLabel}: expected { target }, { deltaX, deltaY }, or { clientX, clientY }.`,
    };
  }
  if (raw['target'] !== undefined) {
    const parsedTarget = parseTargetSpec(raw['target'], `${pathLabel}.target`);
    if (!parsedTarget.ok) return parsedTarget;
    return { ok: true, value: { target: parsedTarget.value } };
  }
  if (raw['deltaX'] !== undefined || raw['deltaY'] !== undefined) {
    if (!isFiniteNum(raw['deltaX']) || !isFiniteNum(raw['deltaY'])) {
      return {
        ok: false,
        error: `Invalid ${pathLabel}: deltaX and deltaY must both be finite numbers.`,
      };
    }
    return { ok: true, value: { deltaX: raw['deltaX'], deltaY: raw['deltaY'] } };
  }
  if (raw['clientX'] !== undefined || raw['clientY'] !== undefined) {
    if (!isFiniteNum(raw['clientX']) || !isFiniteNum(raw['clientY'])) {
      return {
        ok: false,
        error: `Invalid ${pathLabel}: clientX and clientY must both be finite numbers.`,
      };
    }
    return { ok: true, value: { clientX: raw['clientX'], clientY: raw['clientY'] } };
  }
  return {
    ok: false,
    error: `Invalid ${pathLabel}: expected { target }, { deltaX, deltaY }, or { clientX, clientY }.`,
  };
}

function parseDriverStep(raw: unknown, index: number): ParseArgsResult<DriverStep> {
  const stepLabel = `ui_act steps[${String(index)}]`;
  if (!isRecord(raw) || typeof raw['kind'] !== 'string') {
    return {
      ok: false,
      error: `Invalid ${stepLabel}: expected an object with a string "kind" discriminant.`,
    };
  }

  switch (raw['kind']) {
    case 'click': {
      const target = parseTargetSpec(raw['target'], `${stepLabel}.target`);
      if (!target.ok) return target;
      const button = raw['button'];
      if (button !== undefined && button !== 'left' && button !== 'middle' && button !== 'right') {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.button: expected "left", "middle", or "right".`,
        };
      }
      const clickCount = raw['clickCount'];
      if (clickCount !== undefined && !isPosSafeInt(clickCount)) {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.clickCount: expected a positive integer.`,
        };
      }
      return {
        ok: true,
        value: {
          kind: 'click',
          target: target.value,
          ...(button !== undefined ? { button } : {}),
          ...(clickCount !== undefined ? { clickCount } : {}),
        },
      };
    }

    case 'fill': {
      const target = parseTargetSpec(raw['target'], `${stepLabel}.target`);
      if (!target.ok) return target;
      if (typeof raw['value'] !== 'string') {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.value: expected a string for fill.`,
        };
      }
      if (raw['submit'] !== undefined && typeof raw['submit'] !== 'boolean') {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.submit: expected a boolean.`,
        };
      }
      return {
        ok: true,
        value: {
          kind: 'fill',
          target: target.value,
          value: raw['value'],
          ...(raw['submit'] !== undefined ? { submit: raw['submit'] } : {}),
        },
      };
    }

    case 'setValue': {
      const target = parseTargetSpec(raw['target'], `${stepLabel}.target`);
      if (!target.ok) return target;
      const val = raw['value'];
      if (typeof val !== 'string' && !isFiniteNum(val)) {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.value: expected a string or finite number for setValue.`,
        };
      }
      return {
        ok: true,
        value: {
          kind: 'setValue',
          target: target.value,
          value: val,
        },
      };
    }

    case 'select': {
      const target = parseTargetSpec(raw['target'], `${stepLabel}.target`);
      if (!target.ok) return target;
      const val = raw['value'];
      if (typeof val === 'string') {
        return { ok: true, value: { kind: 'select', target: target.value, value: val } };
      }
      if (Array.isArray(val) && val.every((item): item is string => typeof item === 'string')) {
        return { ok: true, value: { kind: 'select', target: target.value, value: [...val] } };
      }
      return {
        ok: false,
        error: `Invalid ${stepLabel}.value: expected a string or array of strings for select.`,
      };
    }

    case 'press': {
      if (typeof raw['key'] !== 'string' || raw['key'].trim().length === 0) {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.key: expected a non-empty key string (e.g. "Enter" or "Control+a").`,
        };
      }
      let targetSpec: TargetSpec | undefined;
      if (raw['target'] !== undefined) {
        const parsedTarget = parseTargetSpec(raw['target'], `${stepLabel}.target`);
        if (!parsedTarget.ok) return parsedTarget;
        targetSpec = parsedTarget.value;
      }
      return {
        ok: true,
        value: {
          kind: 'press',
          key: raw['key'],
          ...(targetSpec !== undefined ? { target: targetSpec } : {}),
        },
      };
    }

    case 'drag': {
      const from = parseTargetSpec(raw['from'], `${stepLabel}.from`);
      if (!from.ok) return from;
      const to = parseDragDestination(raw['to'], `${stepLabel}.to`);
      if (!to.ok) return to;
      const steps = raw['steps'];
      if (steps !== undefined && !isPosSafeInt(steps)) {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.steps: expected a positive integer.`,
        };
      }
      return {
        ok: true,
        value: {
          kind: 'drag',
          from: from.value,
          to: to.value,
          ...(steps !== undefined ? { steps } : {}),
        },
      };
    }

    case 'navigate': {
      const hasUrl = raw['url'] !== undefined;
      const hasAction = raw['action'] !== undefined;
      if (hasUrl === hasAction) {
        return {
          ok: false,
          error: `Invalid ${stepLabel}: navigate requires exactly one of "url" or "action".`,
        };
      }
      if (hasUrl) {
        if (typeof raw['url'] !== 'string' || raw['url'].trim().length === 0) {
          return {
            ok: false,
            error: `Invalid ${stepLabel}.url: expected a non-empty URL string.`,
          };
        }
        return { ok: true, value: { kind: 'navigate', url: raw['url'] } };
      }
      const action = raw['action'];
      if (action !== 'reload' && action !== 'back' && action !== 'forward') {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.action: expected "reload", "back", or "forward".`,
        };
      }
      return { ok: true, value: { kind: 'navigate', action } };
    }

    case 'waitFor': {
      let targetSpec: TargetSpec | undefined;
      if (raw['target'] !== undefined) {
        const parsedTarget = parseTargetSpec(raw['target'], `${stepLabel}.target`);
        if (!parsedTarget.ok) return parsedTarget;
        targetSpec = parsedTarget.value;
      }
      const text = raw['text'];
      if (text !== undefined && typeof text !== 'string') {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.text: expected a string.`,
        };
      }
      const state = raw['state'];
      if (
        state !== undefined &&
        state !== 'attached' &&
        state !== 'visible' &&
        state !== 'hidden' &&
        state !== 'detached'
      ) {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.state: expected "attached", "visible", "hidden", or "detached".`,
        };
      }
      const idleMs = raw['idleMs'];
      if (idleMs !== undefined && !isNonNegFinite(idleMs)) {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.idleMs: expected a non-negative finite number.`,
        };
      }
      const timeoutMs = raw['timeoutMs'];
      if (timeoutMs !== undefined && !isNonNegFinite(timeoutMs)) {
        return {
          ok: false,
          error: `Invalid ${stepLabel}.timeoutMs: expected a non-negative finite number.`,
        };
      }
      if (targetSpec === undefined && text === undefined && idleMs === undefined) {
        return {
          ok: false,
          error: `Invalid ${stepLabel} ("waitFor"): specify at least one of "target", "text", or "idleMs".`,
        };
      }
      return {
        ok: true,
        value: {
          kind: 'waitFor',
          ...(targetSpec !== undefined ? { target: targetSpec } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(idleMs !== undefined ? { idleMs } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
      };
    }

    default:
      return {
        ok: false,
        error: `Invalid ${stepLabel}.kind "${raw['kind']}": expected click, fill, setValue, select, press, drag, navigate, or waitFor.`,
      };
  }
}

function normalizeScopeString(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const directRef = parseRefIdLike(trimmed);
  if (directRef !== null) {
    return directRef;
  }
  const directDriver = parseDriverIdLike(trimmed);
  if (directDriver !== null) {
    return `driver:${directDriver}`;
  }
  const ariaLineMatch = /^(?:-\s+)?([a-z]+)\s+"([^"]+)"(?:\s*\[ref=(e\d+)\])?:?$/i.exec(trimmed);
  if (ariaLineMatch) {
    if (ariaLineMatch[3] !== undefined) {
      const lineRef = parseRefIdLike(ariaLineMatch[3]);
      if (lineRef !== null) return lineRef;
    }
    const role = (ariaLineMatch[1] ?? '').toLowerCase();
    const name = ariaLineMatch[2] ?? '';
    return `${role}:${name}`;
  }
  return trimmed;
}

export function parseUiObserveArgs(raw: unknown): ParseArgsResult<UiObserveInput> {
  if (raw === undefined) {
    return { ok: true, value: {} };
  }
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: 'Invalid ui_observe arguments: expected an object or undefined.',
    };
  }
  let normalizedScope: string | undefined;
  if (raw['scope'] !== undefined) {
    if (typeof raw['scope'] !== 'string') {
      return {
        ok: false,
        error: 'Invalid ui_observe "scope": expected a string.',
      };
    }
    normalizedScope = normalizeScopeString(raw['scope']);
  }
  if (raw['includeAllText'] !== undefined && typeof raw['includeAllText'] !== 'boolean') {
    return {
      ok: false,
      error: 'Invalid ui_observe "includeAllText": expected a boolean.',
    };
  }
  return {
    ok: true,
    value: {
      ...(normalizedScope !== undefined ? { scope: normalizedScope } : {}),
      ...(raw['includeAllText'] !== undefined ? { includeAllText: raw['includeAllText'] } : {}),
    },
  };
}

export function parseUiActArgs(raw: unknown): ParseArgsResult<UiActInput> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: 'Invalid ui_act arguments: expected an object with "rev" and "steps".',
    };
  }
  if (!isNonNegSafeInt(raw['rev'])) {
    return {
      ok: false,
      error:
        'Invalid ui_act "rev": expected a non-negative integer snapshot revision (pass 0 if unobserved).',
    };
  }
  if (!Array.isArray(raw['steps'])) {
    return {
      ok: false,
      error: 'Invalid ui_act "steps": expected an array of DriverStep objects.',
    };
  }
  if (raw['timeoutMs'] !== undefined && !isNonNegFinite(raw['timeoutMs'])) {
    return {
      ok: false,
      error: 'Invalid ui_act "timeoutMs": expected a non-negative finite number.',
    };
  }

  const normalizedSteps: DriverStep[] = [];
  for (let i = 0; i < raw['steps'].length; i += 1) {
    const parsedStep = parseDriverStep(raw['steps'][i], i);
    if (!parsedStep.ok) return parsedStep;
    normalizedSteps.push(parsedStep.value);
  }

  return {
    ok: true,
    value: {
      rev: raw['rev'],
      steps: normalizedSteps,
      ...(raw['timeoutMs'] !== undefined ? { timeoutMs: raw['timeoutMs'] } : {}),
    },
  };
}

export function parseUiCaptureArgs(raw: unknown): ParseArgsResult<Omit<CaptureOptions, 'signal'>> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: 'Invalid ui_capture arguments: expected an object with "mode".',
    };
  }
  const mode = raw['mode'];
  if (mode === 'start_recording' || mode === 'stop_recording') {
    if (raw['target'] !== undefined) {
      return {
        ok: false,
        error: `Invalid ui_capture "target": target is only supported when mode is "screenshot".`,
      };
    }
    return { ok: true, value: { mode } };
  }
  if (mode !== 'screenshot') {
    return {
      ok: false,
      error:
        'Invalid ui_capture "mode": expected "screenshot", "start_recording", or "stop_recording".',
    };
  }

  let targetSpec: TargetSpec | undefined;
  if (raw['target'] !== undefined) {
    const parsedTarget = parseTargetSpec(raw['target'], 'ui_capture.target');
    if (!parsedTarget.ok) return parsedTarget;
    targetSpec = parsedTarget.value;
  }

  const format = raw['format'];
  if (format !== undefined && format !== 'webp' && format !== 'png') {
    return {
      ok: false,
      error: 'Invalid ui_capture "format": expected "webp" or "png".',
    };
  }

  const quality = raw['quality'];
  if (quality !== undefined && (!isFiniteNum(quality) || quality < 0 || quality > 1)) {
    return {
      ok: false,
      error: 'Invalid ui_capture "quality": expected a finite number between 0 and 1.',
    };
  }

  return {
    ok: true,
    value: {
      mode: 'screenshot',
      ...(targetSpec !== undefined ? { target: targetSpec } : {}),
      ...(format !== undefined ? { format } : {}),
      ...(quality !== undefined ? { quality } : {}),
    },
  };
}

export function parseUiEvalArgs(raw: unknown): ParseArgsResult<UiEvalInput> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: 'Invalid ui_eval arguments: expected an object with "expression".',
    };
  }
  if (typeof raw['expression'] !== 'string' || raw['expression'].trim().length === 0) {
    return {
      ok: false,
      error: 'Invalid ui_eval "expression": expected a non-empty JavaScript expression string.',
    };
  }
  if (raw['timeoutMs'] !== undefined && !isNonNegFinite(raw['timeoutMs'])) {
    return {
      ok: false,
      error: 'Invalid ui_eval "timeoutMs": expected a non-negative finite number.',
    };
  }
  return {
    ok: true,
    value: {
      expression: raw['expression'],
      ...(raw['timeoutMs'] !== undefined ? { timeoutMs: raw['timeoutMs'] } : {}),
    },
  };
}
