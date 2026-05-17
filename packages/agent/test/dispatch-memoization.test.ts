import { describe, expect, test } from 'bun:test';
import { hashFnv1a32, stableStringify } from '../src/dispatch-memoization.js';
import {
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type ToolContext,
  type ToolHandler,
  createMemoizedDispatch,
  createToolRegistry,
} from '../src/index.js';

function fakeCtx(over?: Partial<ToolContext>): ToolContext {
  return {
    workspace: EMPTY_WORKSPACE,
    runtime: EMPTY_RUNTIME,
    signal: new AbortController().signal,
    ...over,
  };
}

/** A pure handler that increments a per-instance counter on every call. */
function makeCountingPureTool(name = 'list-stdlib'): {
  handler: ToolHandler<{ q: string }, { q: string; n: number }>;
  count(): number;
  reset(): void;
} {
  let n = 0;
  const handler: ToolHandler<{ q: string }, { q: string; n: number }> = {
    name,
    description: 'pure tool used by tests',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    pure: true,
    async execute({ q }) {
      n += 1;
      return { ok: true, summary: `n=${n}`, data: { q, n } };
    },
  };
  return {
    handler,
    count: () => n,
    reset: () => {
      n = 0;
    },
  };
}

/** A non-pure handler with the same shape — never cached. */
function makeCountingImpureTool(name = 'write-rules'): {
  handler: ToolHandler<{ q: string }, { q: string; n: number }>;
  count(): number;
} {
  let n = 0;
  const handler: ToolHandler<{ q: string }, { q: string; n: number }> = {
    name,
    description: 'non-pure tool used by tests',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    // pure omitted -> defaults to false via isPure().
    async execute({ q }) {
      n += 1;
      return { ok: true, summary: `n=${n}`, data: { q, n } };
    },
  };
  return { handler, count: () => n };
}

describe('createMemoizedDispatch', () => {
  test('caches on identical key and reports a hit', async () => {
    const r = createToolRegistry();
    const t = makeCountingPureTool();
    r.register(t.handler);
    const dispatch = createMemoizedDispatch(r);

    const first = await dispatch.execute(
      { id: '1', name: 'list-stdlib', args: { q: 'rules' } },
      fakeCtx(),
    );
    const second = await dispatch.execute(
      { id: '2', name: 'list-stdlib', args: { q: 'rules' } },
      fakeCtx(),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Second call returns the SAME cached result reference.
    expect(second).toBe(first);
    expect(t.count()).toBe(1);
    expect(dispatch.stats()).toEqual({ hits: 1, misses: 1, bypassed: 0 });
  });

  test('cache key is order-independent across argument property order', async () => {
    const r = createToolRegistry();
    const handler: ToolHandler<Record<string, unknown>, Record<string, unknown>> = {
      name: 'shape',
      description: 'pure tool with multi-key args',
      parameters: { type: 'object' },
      pure: true,
      async execute(args) {
        return { ok: true, summary: 'ok', data: args };
      },
    };
    r.register(handler);
    const dispatch = createMemoizedDispatch(r);

    await dispatch.execute({ id: '1', name: 'shape', args: { a: 1, b: 2 } }, fakeCtx());
    await dispatch.execute({ id: '2', name: 'shape', args: { b: 2, a: 1 } }, fakeCtx());

    // Two structurally equal arg objects must hit the cache.
    expect(dispatch.stats()).toEqual({ hits: 1, misses: 1, bypassed: 0 });
  });

  test('miss on different args', async () => {
    const r = createToolRegistry();
    const t = makeCountingPureTool();
    r.register(t.handler);
    const dispatch = createMemoizedDispatch(r);

    await dispatch.execute({ id: '1', name: 'list-stdlib', args: { q: 'a' } }, fakeCtx());
    await dispatch.execute({ id: '2', name: 'list-stdlib', args: { q: 'b' } }, fakeCtx());

    expect(t.count()).toBe(2);
    expect(dispatch.stats()).toEqual({ hits: 0, misses: 2, bypassed: 0 });
  });

  test('miss on different workspace', async () => {
    const r = createToolRegistry();
    const t = makeCountingPureTool();
    r.register(t.handler);
    const dispatch = createMemoizedDispatch(r);

    const ctxA = fakeCtx();
    const ctxB = fakeCtx({
      workspace: { ...EMPTY_WORKSPACE, rules: 'match /foo { allow read: if true; }' },
    });

    await dispatch.execute({ id: '1', name: 'list-stdlib', args: { q: 'rules' } }, ctxA);
    await dispatch.execute({ id: '2', name: 'list-stdlib', args: { q: 'rules' } }, ctxB);

    expect(t.count()).toBe(2);
    expect(dispatch.stats()).toEqual({ hits: 0, misses: 2, bypassed: 0 });
  });

  test('workspace.stitch changes do NOT bust the cache (stitch excluded)', async () => {
    const r = createToolRegistry();
    const t = makeCountingPureTool();
    r.register(t.handler);
    const dispatch = createMemoizedDispatch(r);

    const ctxA = fakeCtx();
    const ctxB = fakeCtx({
      workspace: {
        ...EMPTY_WORKSPACE,
        stitch: { projectId: 'p1', latestScreenUrl: 'http://x', brief: 'b' },
      },
    });

    await dispatch.execute({ id: '1', name: 'list-stdlib', args: { q: 'rules' } }, ctxA);
    await dispatch.execute({ id: '2', name: 'list-stdlib', args: { q: 'rules' } }, ctxB);

    expect(t.count()).toBe(1);
    expect(dispatch.stats()).toEqual({ hits: 1, misses: 1, bypassed: 0 });
  });

  test('runtime is NOT in the default key — runtime changes do not bust the cache', async () => {
    const r = createToolRegistry();
    const t = makeCountingPureTool();
    r.register(t.handler);
    const dispatch = createMemoizedDispatch(r); // default keyComponents: ['workspace']

    const ctxA = fakeCtx();
    const ctxB = fakeCtx({
      runtime: { ...EMPTY_RUNTIME, sandboxVersion: 7 },
    });

    await dispatch.execute({ id: '1', name: 'list-stdlib', args: { q: 'rules' } }, ctxA);
    await dispatch.execute({ id: '2', name: 'list-stdlib', args: { q: 'rules' } }, ctxB);

    expect(t.count()).toBe(1);
    expect(dispatch.stats()).toEqual({ hits: 1, misses: 1, bypassed: 0 });
  });

  test('opt-in runtime in keyComponents busts the cache on runtime change', async () => {
    const r = createToolRegistry();
    const t = makeCountingPureTool();
    r.register(t.handler);
    const dispatch = createMemoizedDispatch(r, { keyComponents: ['workspace', 'runtime'] });

    const ctxA = fakeCtx();
    const ctxB = fakeCtx({
      runtime: { ...EMPTY_RUNTIME, sandboxVersion: 99 },
    });

    await dispatch.execute({ id: '1', name: 'list-stdlib', args: { q: 'rules' } }, ctxA);
    await dispatch.execute({ id: '2', name: 'list-stdlib', args: { q: 'rules' } }, ctxB);

    expect(t.count()).toBe(2);
    expect(dispatch.stats()).toEqual({ hits: 0, misses: 2, bypassed: 0 });
  });

  test('non-pure tools bypass the cache; counter advances every call', async () => {
    const r = createToolRegistry();
    const t = makeCountingImpureTool();
    r.register(t.handler);
    const dispatch = createMemoizedDispatch(r);

    await dispatch.execute({ id: '1', name: 'write-rules', args: { q: 'x' } }, fakeCtx());
    await dispatch.execute({ id: '2', name: 'write-rules', args: { q: 'x' } }, fakeCtx());
    await dispatch.execute({ id: '3', name: 'write-rules', args: { q: 'x' } }, fakeCtx());

    expect(t.count()).toBe(3);
    expect(dispatch.stats()).toEqual({ hits: 0, misses: 0, bypassed: 3 });
  });

  test('pure: false explicitly also bypasses', async () => {
    const r = createToolRegistry();
    let n = 0;
    const handler: ToolHandler = {
      name: 'explicit-impure',
      description: 'pure set to false explicitly',
      parameters: { type: 'object' },
      pure: false,
      async execute() {
        n += 1;
        return { ok: true, summary: 'ok' };
      },
    };
    r.register(handler);
    const dispatch = createMemoizedDispatch(r);

    await dispatch.execute({ id: '1', name: 'explicit-impure', args: {} }, fakeCtx());
    await dispatch.execute({ id: '2', name: 'explicit-impure', args: {} }, fakeCtx());

    expect(n).toBe(2);
    expect(dispatch.stats()).toEqual({ hits: 0, misses: 0, bypassed: 2 });
  });

  test('mixed pure + non-pure dispatch accumulates stats correctly', async () => {
    const r = createToolRegistry();
    const pure = makeCountingPureTool('pure-a');
    const impure = makeCountingImpureTool('impure-a');
    r.register(pure.handler);
    r.register(impure.handler);
    const dispatch = createMemoizedDispatch(r);

    await dispatch.execute({ id: '1', name: 'pure-a', args: { q: 'x' } }, fakeCtx());
    await dispatch.execute({ id: '2', name: 'pure-a', args: { q: 'x' } }, fakeCtx());
    await dispatch.execute({ id: '3', name: 'impure-a', args: { q: 'x' } }, fakeCtx());
    await dispatch.execute({ id: '4', name: 'pure-a', args: { q: 'y' } }, fakeCtx());
    await dispatch.execute({ id: '5', name: 'impure-a', args: { q: 'x' } }, fakeCtx());

    expect(pure.count()).toBe(2);
    expect(impure.count()).toBe(2);
    expect(dispatch.stats()).toEqual({ hits: 1, misses: 2, bypassed: 2 });
  });

  test('failed (ok: false) results are NOT cached — re-dispatch re-runs the handler', async () => {
    const r = createToolRegistry();
    // Throwing handler → createDispatch wraps into { ok: false }.
    let n = 0;
    const handler: ToolHandler = {
      name: 'flaky-pure',
      description: 'pure but throws',
      parameters: { type: 'object' },
      pure: true,
      async execute() {
        n += 1;
        throw new Error(`boom-${n}`);
      },
    };
    r.register(handler);
    const dispatch = createMemoizedDispatch(r);

    const first = await dispatch.execute({ id: '1', name: 'flaky-pure', args: {} }, fakeCtx());
    const second = await dispatch.execute({ id: '2', name: 'flaky-pure', args: {} }, fakeCtx());

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(first.summary).toContain('boom-1');
    expect(second.summary).toContain('boom-2');
    // Two real executions — error was not cached, so the second dispatch
    // re-ran the handler.
    expect(n).toBe(2);
    expect(dispatch.stats()).toEqual({ hits: 0, misses: 2, bypassed: 0 });
  });

  test('explicit { ok: false } results from a pure tool are not cached either', async () => {
    const r = createToolRegistry();
    let n = 0;
    const handler: ToolHandler = {
      name: 'soft-fail-pure',
      description: 'pure tool that returns ok: false',
      parameters: { type: 'object' },
      pure: true,
      async execute() {
        n += 1;
        return { ok: false, summary: `soft fail ${n}` };
      },
    };
    r.register(handler);
    const dispatch = createMemoizedDispatch(r);

    await dispatch.execute({ id: '1', name: 'soft-fail-pure', args: {} }, fakeCtx());
    await dispatch.execute({ id: '2', name: 'soft-fail-pure', args: {} }, fakeCtx());

    expect(n).toBe(2);
    expect(dispatch.stats()).toEqual({ hits: 0, misses: 2, bypassed: 0 });
  });

  test('unknown tool name is bypassed and returns the underlying error', async () => {
    const r = createToolRegistry();
    const dispatch = createMemoizedDispatch(r);
    const result = await dispatch.execute({ id: '1', name: 'does-not-exist', args: {} }, fakeCtx());
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Unknown tool');
    expect(dispatch.stats()).toEqual({ hits: 0, misses: 0, bypassed: 1 });
  });

  test('stats() returns a snapshot — mutating the returned object is harmless', async () => {
    const r = createToolRegistry();
    const t = makeCountingPureTool();
    r.register(t.handler);
    const dispatch = createMemoizedDispatch(r);

    await dispatch.execute({ id: '1', name: 'list-stdlib', args: { q: 'a' } }, fakeCtx());
    const snap = dispatch.stats();
    snap.hits = 999;
    snap.misses = 999;
    snap.bypassed = 999;
    expect(dispatch.stats()).toEqual({ hits: 0, misses: 1, bypassed: 0 });
  });

  test('two MemoizedDispatch instances have independent caches', async () => {
    const r = createToolRegistry();
    const t = makeCountingPureTool();
    r.register(t.handler);

    const dispatchA = createMemoizedDispatch(r);
    const dispatchB = createMemoizedDispatch(r);

    await dispatchA.execute({ id: '1', name: 'list-stdlib', args: { q: 'x' } }, fakeCtx());
    await dispatchB.execute({ id: '2', name: 'list-stdlib', args: { q: 'x' } }, fakeCtx());

    expect(t.count()).toBe(2);
    expect(dispatchA.stats()).toEqual({ hits: 0, misses: 1, bypassed: 0 });
    expect(dispatchB.stats()).toEqual({ hits: 0, misses: 1, bypassed: 0 });
  });
});

describe('stableStringify (cache-key helper)', () => {
  test('sorts keys at every nesting level', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: { y: 1, x: 2 } })).toBe(stableStringify({ a: { x: 2, y: 1 } }));
  });

  test('preserves array order (positional)', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  test('drops undefined object properties (JSON-compatible)', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  test('serializes null and booleans the same as JSON', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
  });
});

describe('hashFnv1a32 (cache-key helper)', () => {
  test('returns an 8-char lowercase hex string', () => {
    const h = hashFnv1a32('hello');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  test('is deterministic for identical input', () => {
    expect(hashFnv1a32('inbrowser')).toBe(hashFnv1a32('inbrowser'));
  });

  test('different inputs produce different hashes (no trivial collision on short strings)', () => {
    expect(hashFnv1a32('a')).not.toBe(hashFnv1a32('b'));
    expect(hashFnv1a32('foo')).not.toBe(hashFnv1a32('fooo'));
  });

  test('the empty string hashes to the FNV offset basis', () => {
    expect(hashFnv1a32('')).toBe('811c9dc5');
  });
});
