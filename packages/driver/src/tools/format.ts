import {
  type ActResult,
  type CaptureResult,
  type DiagnosticsDelta,
  DriverError,
  type DriverErrorCode,
  type EvalResult,
  type ObservationSnapshot,
  type SemanticFingerprint,
  type SnapshotCanvasState,
  type SnapshotMediaState,
  type SnapshotNode,
} from '../types.js';

const DEFAULT_OBSERVE_MAX_YAML_CHARS = 16_000;
const DEFAULT_ACT_MAX_YAML_CHARS = 12_000;
const DEFAULT_EVAL_MAX_YAML_CHARS = 12_000;

function quoteYamlString(value: string): string {
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

function formatRoleToken(role: string): string {
  return /^[A-Za-z0-9_-]+$/.test(role) ? role : quoteYamlString(role);
}

function formatDriverToken(driverId: string): string {
  return /^[A-Za-z0-9_.:/-]+$/.test(driverId) ? driverId : quoteYamlString(driverId);
}

function isDiagnosticsClean(diagnostics: DiagnosticsDelta): boolean {
  return (
    diagnostics.compileOverlay === null &&
    diagnostics.consoleErrors.length === 0 &&
    diagnostics.pageErrors.length === 0 &&
    diagnostics.networkFailures.length === 0
  );
}

function appendDiagnosticsLines(lines: string[], diagnostics: DiagnosticsDelta): void {
  if (isDiagnosticsClean(diagnostics)) {
    return;
  }
  lines.push('diagnostics:');
  if (diagnostics.compileOverlay !== null) {
    lines.push(`  compileOverlay: ${quoteYamlString(diagnostics.compileOverlay)}`);
  }
  if (diagnostics.consoleErrors.length > 0) {
    lines.push('  consoleErrors:');
    for (const msg of diagnostics.consoleErrors) {
      lines.push(`    - ${quoteYamlString(msg)}`);
    }
  }
  if (diagnostics.pageErrors.length > 0) {
    lines.push('  pageErrors:');
    for (const msg of diagnostics.pageErrors) {
      lines.push(`    - ${quoteYamlString(msg)}`);
    }
  }
  if (diagnostics.networkFailures.length > 0) {
    lines.push('  networkFailures:');
    for (const nf of diagnostics.networkFailures) {
      lines.push(
        `    - ${String(nf.status)} ${formatRoleToken(nf.method)} ${quoteYamlString(nf.url)} ${quoteYamlString(nf.statusText)}`,
      );
    }
  }
}

function formatMediaAttrs(media: SnapshotMediaState): string {
  const parts: string[] = [
    media.paused ? 'paused' : 'playing',
    `time=${String(media.currentTime)}/${media.duration === null ? '?' : String(media.duration)}`,
  ];
  if (media.kind === 'video' || media.width > 0 || media.height > 0) {
    parts.push(`size=${String(media.width)}x${String(media.height)}`);
  }
  parts.push(media.ready ? 'ready' : 'ready=false');
  if (media.error !== null) {
    parts.push(`error=${quoteYamlString(media.error)}`);
  }
  return parts.join(' ');
}

function formatCanvasAttrs(canvas: SnapshotCanvasState): string {
  return `size=${String(canvas.width)}x${String(canvas.height)} nonBlank=${String(canvas.nonBlank)}`;
}

function formatSingleNodeLine(
  node: SnapshotNode,
  indentSpaces: number,
  includeChildrenColon: boolean,
): string {
  const indent = ' '.repeat(indentSpaces);
  const tokens: string[] = [`${indent}- ${formatRoleToken(node.role)}`];
  if (node.name.length > 0) {
    tokens.push(quoteYamlString(node.name));
  }
  if (node.ref !== undefined) {
    tokens.push(`[ref=${node.ref}]`);
  }
  if (node.driverId !== undefined && node.driverId.length > 0) {
    tokens.push(`[driver=${formatDriverToken(node.driverId)}]`);
  }
  if (node.intent !== undefined && node.intent.length > 0) {
    tokens.push(`intent=${quoteYamlString(node.intent)}`);
  }
  if (node.value !== undefined) {
    tokens.push(`value=${quoteYamlString(node.value)}`);
  }
  if (node.checked !== undefined) {
    tokens.push(`checked=${String(node.checked)}`);
  }
  if (node.disabled === true) {
    tokens.push('disabled');
  }
  if (node.expanded !== undefined) {
    tokens.push(`expanded=${String(node.expanded)}`);
  }
  if (node.min !== undefined) {
    tokens.push(`min=${String(node.min)}`);
  }
  if (node.max !== undefined) {
    tokens.push(`max=${String(node.max)}`);
  }
  if (node.media !== undefined) {
    tokens.push(formatMediaAttrs(node.media));
  }
  if (node.canvas !== undefined) {
    tokens.push(formatCanvasAttrs(node.canvas));
  }
  const hasChildren =
    includeChildrenColon && node.children !== undefined && node.children.length > 0;
  return `${tokens.join(' ')}${hasChildren ? ':' : ''}`;
}

function appendNodeTreeLines(
  lines: string[],
  nodes: readonly SnapshotNode[],
  indentSpaces: number,
  recurseChildren = true,
): void {
  for (const node of nodes) {
    const hasChildren = recurseChildren && node.children !== undefined && node.children.length > 0;
    lines.push(formatSingleNodeLine(node, indentSpaces, recurseChildren));
    if (hasChildren && node.children !== undefined) {
      appendNodeTreeLines(lines, node.children, indentSpaces + 2, true);
    }
  }
}

function truncateYaml(yaml: string, maxChars: number, defaultMaxChars: number): string {
  if (maxChars === Number.POSITIVE_INFINITY) {
    return yaml;
  }
  const effective = Number.isFinite(maxChars) ? maxChars : defaultMaxChars;
  const budget = Math.max(0, Math.floor(effective));
  if (yaml.length <= budget) {
    return yaml;
  }
  const maxDigits = String(yaml.length).length;
  const maxTrailerLength = `\n... (truncated ${'9'.repeat(maxDigits)} chars; pass scope to narrow)`
    .length;
  if (budget <= maxTrailerLength) {
    const fallback = `... (truncated ${String(yaml.length)} chars; pass scope to narrow)`;
    return fallback.slice(0, budget);
  }
  const prefixLimit = budget - maxTrailerLength;
  const rawPrefix = yaml.slice(0, prefixLimit);
  const lastNewline = rawPrefix.lastIndexOf('\n');
  const kept = lastNewline > 0 ? rawPrefix.slice(0, lastNewline) : rawPrefix;
  const omittedChars = yaml.length - kept.length;
  return `${kept}\n... (truncated ${String(omittedChars)} chars; pass scope to narrow)`;
}

function hintForDriverErrorCode(code: DriverErrorCode): string {
  switch (code) {
    case 'DRIVER_TARGET_NOT_FOUND':
      return 'Call ui_observe to refresh refs or select one of the listed candidates.';
    case 'DRIVER_TARGET_AMBIGUOUS':
      return 'Disambiguate the target using an exact ref (e.g. "e3") or pass nth in { role, name, nth }.';
    case 'DRIVER_EVAL_DISABLED':
      return 'JavaScript evaluation requires allowEval: true on both the PageDriver and createDriverTools.';
    case 'DRIVER_UNSUPPORTED':
      return 'This operation is unsupported by the active PageDriver backend.';
    case 'DRIVER_TIMEOUT':
      return 'Operation timed out or was cancelled; call ui_observe to inspect current UI state before retrying.';
    case 'DRIVER_DISPOSED':
      return 'The PageDriver instance has been disposed and can no longer execute commands.';
    case 'DRIVER_PROTOCOL':
      return 'Protocol transport failed communicating with the guest frame; call ui_observe to verify connectivity.';
  }
}

function formatCandidateLine(candidate: SemanticFingerprint): string {
  const parts = [
    `role=${quoteYamlString(candidate.role)}`,
    `name=${quoteYamlString(candidate.name)}`,
    `nth=${String(candidate.nth)}`,
  ];
  if (candidate.driverId !== undefined) {
    parts.push(`driver=${quoteYamlString(candidate.driverId)}`);
  }
  if (candidate.landmark !== undefined) {
    parts.push(`landmark=${quoteYamlString(candidate.landmark)}`);
  }
  return `  - ${parts.join(' ')}`;
}

export function formatValidationErrorYaml(message: string): string {
  return [
    'status: error',
    'code: INVALID_ARGUMENTS',
    `message: ${quoteYamlString(message)}`,
    'hint: "Check the tool schema parameters and retry."',
  ].join('\n');
}

interface DriverErrorShape {
  readonly code: DriverErrorCode;
  readonly message: string;
  readonly candidates?: readonly SemanticFingerprint[];
}

function isDriverErrorCode(value: unknown): value is DriverErrorCode {
  switch (value) {
    case 'DRIVER_TIMEOUT':
    case 'DRIVER_DISPOSED':
    case 'DRIVER_PROTOCOL':
    case 'DRIVER_UNSUPPORTED':
    case 'DRIVER_TARGET_NOT_FOUND':
    case 'DRIVER_TARGET_AMBIGUOUS':
    case 'DRIVER_EVAL_DISABLED':
      return true;
    default:
      return false;
  }
}

function isSemanticFingerprintLike(value: unknown): value is SemanticFingerprint {
  return (
    typeof value === 'object' &&
    value !== null &&
    'role' in value &&
    typeof value.role === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'nth' in value &&
    typeof value.nth === 'number' &&
    (!('landmark' in value) ||
      value.landmark === undefined ||
      typeof value.landmark === 'string') &&
    (!('driverId' in value) || value.driverId === undefined || typeof value.driverId === 'string')
  );
}

function extractDriverErrorShape(err: unknown): DriverErrorShape | null {
  if (err instanceof DriverError) {
    return err;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    isDriverErrorCode(err.code) &&
    'message' in err &&
    typeof err.message === 'string'
  ) {
    const rawCandidates = 'candidates' in err ? err.candidates : undefined;
    const candidates =
      Array.isArray(rawCandidates) && rawCandidates.every(isSemanticFingerprintLike)
        ? rawCandidates
        : undefined;
    return {
      code: err.code,
      message: err.message,
      ...(candidates !== undefined ? { candidates } : {}),
    };
  }
  return null;
}

export function formatToolErrorYaml(err: unknown): string {
  const driverErr = extractDriverErrorShape(err);
  if (driverErr !== null) {
    const lines = [
      'status: error',
      `code: ${driverErr.code}`,
      `message: ${quoteYamlString(driverErr.message)}`,
    ];
    if (driverErr.candidates !== undefined && driverErr.candidates.length > 0) {
      lines.push('candidates:');
      for (const candidate of driverErr.candidates) {
        lines.push(formatCandidateLine(candidate));
      }
    }
    lines.push(`hint: ${quoteYamlString(hintForDriverErrorCode(driverErr.code))}`);
    return lines.join('\n');
  }
  return [
    'status: error',
    'code: UNEXPECTED_ERROR',
    `message: ${quoteYamlString(err instanceof Error ? err.message : String(err))}`,
  ].join('\n');
}

export function formatObservationYaml(
  snapshot: ObservationSnapshot,
  maxChars = DEFAULT_OBSERVE_MAX_YAML_CHARS,
): string {
  const lines: string[] = [
    `rev: ${String(snapshot.rev)}`,
    `url: ${quoteYamlString(snapshot.url)}`,
    `title: ${quoteYamlString(snapshot.title)}`,
    `viewport: ${String(snapshot.viewport.width)}x${String(snapshot.viewport.height)}`,
  ];
  appendDiagnosticsLines(lines, snapshot.diagnostics);
  if (snapshot.elements.length === 0) {
    lines.push('elements: []');
  } else {
    lines.push('elements:');
    appendNodeTreeLines(lines, snapshot.elements, 2, true);
  }
  return truncateYaml(lines.join('\n'), maxChars, DEFAULT_OBSERVE_MAX_YAML_CHARS);
}

export function formatActResultYaml(
  result: ActResult,
  maxChars = DEFAULT_ACT_MAX_YAML_CHARS,
): string {
  const lines: string[] = [
    result.interruptedReason === undefined
      ? 'status: ok'
      : `interrupted: ${result.interruptedReason}`,
    `steps: ${String(result.completedSteps)}/${String(result.totalSteps)}`,
    `rev: ${String(result.rev)}`,
    `url: ${quoteYamlString(result.url)}`,
    `title: ${quoteYamlString(result.title)}`,
  ];

  if (result.error !== undefined) {
    lines.push(`error: ${quoteYamlString(result.error)}`);
  }

  appendDiagnosticsLines(lines, result.diagnostics);

  const { diff } = result;
  if (diff.fullReset) {
    lines.push('diff:');
    lines.push('  fullReset: true');
    const resetElements = diff.elements ?? [];
    if (resetElements.length === 0) {
      lines.push('  elements: []');
    } else {
      lines.push('  elements:');
      appendNodeTreeLines(lines, resetElements, 4, true);
    }
  } else if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) {
    lines.push('diff: none');
  } else {
    lines.push('diff:');
    if (diff.added.length > 0) {
      lines.push('  added:');
      appendNodeTreeLines(lines, diff.added, 4, true);
    }
    if (diff.changed.length > 0) {
      lines.push('  changed:');
      appendNodeTreeLines(lines, diff.changed, 4, false);
    }
    if (diff.removed.length > 0) {
      lines.push(`  removed: [${diff.removed.join(', ')}]`);
    }
  }

  return truncateYaml(lines.join('\n'), maxChars, DEFAULT_ACT_MAX_YAML_CHARS);
}

export function formatCaptureResultYaml(result: CaptureResult): string {
  const lines: string[] = [
    'status: ok',
    `mimeType: ${quoteYamlString(result.mimeType)}`,
    `width: ${String(result.width)}`,
    `height: ${String(result.height)}`,
    `byteLength: ${String(result.bytes.byteLength)}`,
    `modeUsed: ${result.modeUsed}`,
  ];
  if (result.durationMs !== undefined) {
    lines.push(`durationMs: ${String(result.durationMs)}`);
  }
  return lines.join('\n');
}

type SafeJsonScalarOrContainer =
  | null
  | boolean
  | number
  | string
  | SafeJsonScalarOrContainer[]
  | { [key: string]: SafeJsonScalarOrContainer };

function toSafeJsonValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): SafeJsonScalarOrContainer {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return `${String(value)}n`;
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value !== 'object') return String(value);

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (value instanceof RegExp) {
    return String(value);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack !== undefined ? { stack: value.stack } : {}),
    };
  }
  if (seen.has(value)) return '[Circular]';
  if (depth >= 12) return '[MaxDepth]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toSafeJsonValue(item, seen, depth + 1));
    }
    if (value instanceof Set) {
      return [...value].map((item) => toSafeJsonValue(item, seen, depth + 1));
    }
    if (value instanceof Map) {
      return [...value.entries()].map(([k, v]) => [
        toSafeJsonValue(k, seen, depth + 1),
        toSafeJsonValue(v, seen, depth + 1),
      ]);
    }
    const out: { [key: string]: SafeJsonScalarOrContainer } = {};
    for (const k of Object.keys(value)) {
      try {
        out[k] = toSafeJsonValue(Reflect.get(value, k), seen, depth + 1);
      } catch (err) {
        out[k] = `[GetterError: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function formatEvalResultYaml(
  result: EvalResult,
  maxChars = DEFAULT_EVAL_MAX_YAML_CHARS,
): string {
  const safeVal = toSafeJsonValue(result.value);
  const serializedValue = JSON.stringify(safeVal)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  const lines: string[] = ['status: ok', `value: ${serializedValue}`];
  appendDiagnosticsLines(lines, result.diagnostics);
  return truncateYaml(lines.join('\n'), maxChars, DEFAULT_EVAL_MAX_YAML_CHARS);
}
