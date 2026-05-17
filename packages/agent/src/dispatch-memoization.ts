/**
 * Content-addressed memoization layer over `createDispatch`.
 *
 * `createMemoizedDispatch(registry, options?)` returns a `ToolDispatch`-shaped
 * object that caches `ToolResult`s keyed on `(toolName, argsHash,
 * workspaceHash, runtimeHash)`. The cache is consulted only for handlers
 * tagged `pure` (see `isPure` in `./tools.ts`). Non-pure handlers bypass
 * the cache entirely and always execute. Errors from the underlying
 * dispatch propagate; they are NOT cached, since they may be transient.
 *
 * The returned object is structurally a `ToolDispatch` — strategies and
 * downstream code that already accept `ToolDispatch` use it transparently.
 * The one addition is `stats()`, which returns the running counters for
 * hits / misses / bypassed calls. The cache lives for the lifetime of
 * one `MemoizedDispatch` instance; there is no global state.
 *
 * Design notes:
 *
 * - Hashing uses FNV-1a 32-bit over a stable-stringified JSON
 *   representation. The cache is for short-running test loops; a
 *   cryptographic hash is overkill. Collisions are tolerable at our
 *   cache sizes, and the cost of a missed hit is at worst a recomputation.
 * - Argument keys are sorted at every level via `stableStringify` so two
 *   structurally-equal arg objects produce the same key regardless of
 *   property insertion order.
 * - Workspace hash covers `presetId`, `rules`, `code`, and `appSource`.
 *   `stitch` is excluded per the brief — pure tools don't read from it.
 * - Runtime hash is included only when `'runtime' \in keyComponents`.
 *   Defaults to `['workspace']`; opting into runtime opt-in keeps the
 *   default key small for the dominant pure-tool population.
 * - No eviction in v1. Eval runs are bounded; one instance per harness
 *   trial keeps cache growth bounded too.
 */

import { createDispatch, isPure } from './tools.js';
import type { RuntimeState } from './types/runtime.js';
import type {
  ToolCall,
  ToolContext,
  ToolDispatch,
  ToolHandler,
  ToolRegistry,
  ToolResult,
} from './types/tools.js';
import type { Workspace } from './types/workspace.js';

/** Which `ctx` fields contribute to the cache key. */
export type MemoKeyComponent = 'workspace' | 'runtime';

export interface MemoOptions {
  /**
   * Which `ctx` fields contribute to the cache key. Defaults to
   * `['workspace']`. Some pure tools depend on runtime; opt-in keeps
   * the default key small for tools that are workspace-determined.
   */
  keyComponents?: MemoKeyComponent[];
}

export interface MemoStats {
  /** Pure tool dispatched and a cached result was served. */
  hits: number;
  /** Pure tool dispatched, cache missed, underlying handler ran. */
  misses: number;
  /** Non-pure tool dispatched; cache layer was bypassed. */
  bypassed: number;
}

export interface MemoizedDispatch extends ToolDispatch {
  /** Snapshot of the running counters. Returns a fresh object on every call. */
  stats(): MemoStats;
}

/**
 * Wrap a registry in a memoizing dispatcher. The wrapper holds its own
 * cache; the underlying dispatch is the standard `createDispatch(registry)`.
 *
 * Non-pure handlers (including unknown-tool errors) bypass the cache and
 * are dispatched directly; `bypassed` is incremented for those calls.
 */
export function createMemoizedDispatch(
  registry: ToolRegistry,
  options?: MemoOptions,
): MemoizedDispatch {
  const keyComponents: MemoKeyComponent[] = options?.keyComponents ?? ['workspace'];
  const includeRuntime = keyComponents.includes('runtime');
  const includeWorkspace = keyComponents.includes('workspace');

  const underlying = createDispatch(registry);
  const cache = new Map<string, ToolResult>();
  const counters: MemoStats = { hits: 0, misses: 0, bypassed: 0 };

  return {
    async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
      const handler = findHandler(registry, call.name);
      // Non-pure handlers (and unknown tools) skip the cache. Unknown
      // tools surface their error message through the underlying
      // dispatch unchanged — the cache layer is invisible on the
      // non-pure path.
      if (!handler || !isPure(handler)) {
        counters.bypassed += 1;
        return underlying.execute(call, ctx);
      }

      const key = buildCacheKey(call, ctx, includeWorkspace, includeRuntime);
      const cached = cache.get(key);
      if (cached !== undefined) {
        counters.hits += 1;
        return cached;
      }

      // Cache miss. Underlying dispatch runs; the result is cached on
      // success. Note: `createDispatch` already converts thrown
      // handlers into `{ ok: false, summary: '... threw: ...' }`
      // results, so we never observe a thrown error here. The brief
      // says "errors propagate, are not cached" — that maps to
      // `ok === false` here. We cache only successful results.
      const result = await underlying.execute(call, ctx);
      counters.misses += 1;
      if (result.ok) {
        cache.set(key, result);
      }
      return result;
    },
    stats(): MemoStats {
      return { ...counters };
    },
  };
}

/**
 * Build the deterministic cache key for `(toolName, argsHash,
 * workspaceHash, runtimeHash)`. Components are joined with `|` so a
 * single string is hashable in one pass on lookup.
 */
function buildCacheKey(
  call: ToolCall,
  ctx: ToolContext,
  includeWorkspace: boolean,
  includeRuntime: boolean,
): string {
  const argsKey = hashFnv1a32(stableStringify(call.args));
  const wsKey = includeWorkspace ? hashFnv1a32(stableStringify(workspaceShape(ctx.workspace))) : '';
  const rtKey = includeRuntime ? hashFnv1a32(stableStringify(runtimeShape(ctx.runtime))) : '';
  return `${call.name}|${argsKey}|${wsKey}|${rtKey}`;
}

/**
 * Project the workspace into the subset of fields a pure tool can
 * legitimately read. `stitch` is excluded — design context is
 * orthogonal to the documented pure-tool population (rules-stdlib-list,
 * path-discovery, etc.). Two workspaces that differ only in `stitch`
 * are treated as equivalent for cache purposes.
 */
function workspaceShape(ws?: Workspace): Record<string, unknown> {
  if (!ws) return { _present: false };
  return {
    presetId: ws.presetId,
    rules: ws.rules,
    code: ws.code,
    appSource: ws.appSource,
  };
}

/**
 * Project the runtime into a stable shape. Only included in the cache
 * key when the caller opts into `'runtime'` in `keyComponents`.
 */
function runtimeShape(rt?: RuntimeState): Record<string, unknown> {
  if (!rt) return { _present: false };
  return {
    terminal: rt.terminal,
    runSummary: rt.runSummary,
    deploy: rt.deploy,
    parseError: rt.parseError,
    uiErrors: rt.uiErrors,
    sandboxVersion: rt.sandboxVersion,
  };
}

/**
 * Stable JSON serialization: object keys are sorted alphabetically at
 * every nesting level. Arrays preserve order (they are positional).
 * Functions, symbols, `undefined` properties are omitted (standard
 * JSON behaviour). `null` is preserved.
 *
 * This is intentionally not `JSON.stringify(value)` — that emits keys
 * in insertion order, so two structurally-equal arg objects assembled
 * differently would produce different cache keys.
 */
export function stableStringify(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${serialize(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  // Functions, symbols, bigints — fall back to a stable string form.
  // Pure tool args should never contain these; the fallback is defensive.
  return JSON.stringify(String(value));
}

/**
 * FNV-1a 32-bit hash. Returns the lowercase hex string. Fast,
 * dependency-free, and collision-tolerable at our cache sizes.
 * Iterates the UTF-16 code units of the input; sufficient for our
 * stably-stringified JSON payloads, which only contain ASCII control
 * characters and JSON syntax tokens plus user-supplied string data.
 */
export function hashFnv1a32(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiplication via shifts (avoids precision loss).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Lookup a handler by name without exposing a `get` method on the
 * registry interface. Mirrors the helper in `tools.ts`; duplicated here
 * to keep the memoization module independent of internal helpers.
 */
function findHandler(registry: ToolRegistry, name: string): ToolHandler | undefined {
  if (!registry.has(name)) return undefined;
  return registry.list().find((h) => h.name === name);
}
