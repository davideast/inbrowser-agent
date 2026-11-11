import type { EvalRpcParams } from '../protocol.js';
import { DriverError, type EvalResult } from '../types.js';
import { drainDiagnostics, ensureDiagnosticsInstalled } from './diagnostics.js';
import {
  El,
  HostMap,
  HostSet,
  HostWeakSet,
  NodeCtor,
  is,
  normSpace,
  origClearTimeout,
  origSetTimeout,
  rawAttr,
  reflectApply,
  reflectGet,
  tag,
  win,
} from './intrinsics.js';

export type SanitizedJsonValue =
  | null
  | boolean
  | number
  | string
  | SanitizedJsonValue[]
  | { readonly [key: string]: SanitizedJsonValue };

const AsyncFnCtor = /* @__PURE__ */ (() =>
  Object.getPrototypeOf(async function (): Promise<void> {}).constructor as typeof Function)(); // Invariant: intrinsic AsyncFunction constructor shares Function signature

function compileExpression(expr: string): () => unknown {
  let firstErr: unknown;
  for (const body of [`return (\n${expr}\n);`, expr]) {
    try {
      return AsyncFnCtor(body) as () => unknown; // Invariant: zero-arg compiled evaluator
    } catch (err) {
      firstErr ??= err;
    }
  }
  throw firstErr;
}

export function sanitizeEvalValue(
  val: unknown,
  seen: WeakSet<object> = new HostWeakSet<object>(),
  depth = 0,
): SanitizedJsonValue {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean' || typeof val === 'string') return val;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'bigint') return `${val}n`;
  if (typeof val === 'function') return `[Function: ${val.name || 'anon'}]`;
  if (typeof val !== 'object') return String(val);

  if (is(val, NodeCtor)) {
    const text = normSpace(val.textContent ?? '').slice(0, 120);
    const id = is(val, El) && rawAttr(val, 'id');
    const cls = is(val, El) && rawAttr(val, 'class');
    return {
      ...(is(val, El) ? { tag: tag(val) } : { nodeName: val.nodeName }),
      ...(id ? { id } : {}),
      ...(cls ? { className: cls } : {}),
      ...(text ? { text } : {}),
    };
  }
  if (val instanceof Error) {
    return { name: val.name, message: val.message, ...(val.stack ? { stack: val.stack } : {}) };
  }
  if (val instanceof Date) return Number.isFinite(val.getTime()) ? val.toISOString() : null;
  if (val instanceof RegExp) return String(val);
  if (seen.has(val)) return '[Circular]';
  if (depth >= 12) return '[MaxDepth]';

  seen.add(val);
  try {
    const recur = (item: unknown): SanitizedJsonValue => sanitizeEvalValue(item, seen, depth + 1);
    if (Array.isArray(val) || is(val, HostSet)) return [...val].map(recur);
    if (is(val, HostMap)) return [...val].map(([k, v]) => [recur(k), recur(v)]);
    const out: { [key: string]: SanitizedJsonValue } = {};
    for (const k of Object.keys(val)) {
      try {
        out[k] = recur(reflectGet(val, k));
      } catch (err) {
        out[k] = `[GetterError: ${String(err)}]`;
      }
    }
    return out;
  } finally {
    seen.delete(val);
  }
}

export async function evaluateInPreload(params: EvalRpcParams): Promise<EvalResult> {
  ensureDiagnosticsInstalled();
  const timeoutMs = params.timeoutMs ?? 5_000;
  const fn = compileExpression(params.expression);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => reflectApply(fn, win ?? globalThis, [])),
      new Promise<never>((_, reject) => {
        timer = origSetTimeout(
          () => reject(new DriverError('DRIVER_TIMEOUT', 'Eval timeout.')),
          timeoutMs,
        );
      }),
    ]);
    return { value: sanitizeEvalValue(raw), diagnostics: drainDiagnostics() };
  } finally {
    if (timer !== undefined) origClearTimeout(timer);
  }
}
