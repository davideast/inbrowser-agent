/**
 * In-branch evidence for the memoization cache. This test demonstrates
 * the cache's behaviour under the workspace-state invariant:
 *
 *   1. Same call twice -> handler executes exactly once.
 *   2. Workspace changes -> handler executes again.
 *   3. Workspace reverts -> the original cached value is returned.
 *
 * If this test fails, the cache is incorrect under the invariant.
 */

import { describe, expect, test } from 'bun:test';
import {
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type ToolContext,
  type ToolHandler,
  type Workspace,
  createMemoizedDispatch,
  createToolRegistry,
} from '../src/index.js';

function ctxWith(workspace: Workspace): ToolContext {
  return {
    workspace,
    runtime: EMPTY_RUNTIME,
    signal: new AbortController().signal,
  };
}

describe('createMemoizedDispatch (effect test)', () => {
  test('cache hit on repeat, miss on workspace change, hit on workspace revert', async () => {
    const registry = createToolRegistry();

    // Stub pure tool with an execution counter. Returns a marker that
    // includes the count so we can prove the second-call result is the
    // cached one (not a fresh invocation).
    let executionCount = 0;
    const pureTool: ToolHandler<{ q: string }, { q: string; count: number }> = {
      name: 'path-discovery',
      description: 'stub pure tool',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      pure: true,
      async execute({ q }) {
        executionCount += 1;
        return {
          ok: true,
          summary: `executed ${executionCount}`,
          data: { q, count: executionCount },
        };
      },
    };
    registry.register(pureTool);

    const dispatch = createMemoizedDispatch(registry);

    const workspaceA: Workspace = {
      ...EMPTY_WORKSPACE,
      presetId: 'preset-a',
      rules: 'service cloud.firestore { match /a/{id} { allow read: if true; } }',
    };
    const workspaceB: Workspace = {
      ...EMPTY_WORKSPACE,
      presetId: 'preset-b',
      rules: 'service cloud.firestore { match /b/{id} { allow read: if false; } }',
    };

    const call = { id: 'c', name: 'path-discovery', args: { q: 'rules' } } as const;

    // 1. Dispatch twice with the same workspace.
    const r1 = await dispatch.execute({ ...call, id: '1' }, ctxWith(workspaceA));
    const r2 = await dispatch.execute({ ...call, id: '2' }, ctxWith(workspaceA));

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // The handler ran ONCE; the second result is the cached one.
    expect(executionCount).toBe(1);
    expect(r2).toBe(r1);
    expect((r2.data as { count: number }).count).toBe(1);
    expect(dispatch.stats()).toEqual({ hits: 1, misses: 1, bypassed: 0 });

    // 2. Change the workspace; dispatch again. Counter must advance.
    const r3 = await dispatch.execute({ ...call, id: '3' }, ctxWith(workspaceB));
    expect(r3.ok).toBe(true);
    expect(executionCount).toBe(2);
    expect((r3.data as { count: number }).count).toBe(2);
    expect(dispatch.stats()).toEqual({ hits: 1, misses: 2, bypassed: 0 });

    // 3. Revert to the original workspace; dispatch again. The original
    //    cached value (count=1) must come back, counter must NOT advance.
    const r4 = await dispatch.execute({ ...call, id: '4' }, ctxWith(workspaceA));
    expect(r4.ok).toBe(true);
    expect(executionCount).toBe(2); // still 2 — cache served the request
    expect((r4.data as { count: number }).count).toBe(1);
    expect(r4).toBe(r1); // exact same cached reference

    expect(dispatch.stats()).toEqual({ hits: 2, misses: 2, bypassed: 0 });
  });

  test('non-pure tool interleaved with pure tool does not affect pure cache', async () => {
    const registry = createToolRegistry();

    let pureCount = 0;
    let impureCount = 0;

    const pureTool: ToolHandler<{ q: string }, { count: number }> = {
      name: 'rules-stdlib-list',
      description: 'stub pure tool',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      pure: true,
      async execute() {
        pureCount += 1;
        return { ok: true, summary: `pure ${pureCount}`, data: { count: pureCount } };
      },
    };

    const impureTool: ToolHandler<{ q: string }, { count: number }> = {
      name: 'write-rules',
      description: 'stub non-pure tool',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      async execute() {
        impureCount += 1;
        return { ok: true, summary: `impure ${impureCount}`, data: { count: impureCount } };
      },
    };

    registry.register(pureTool);
    registry.register(impureTool);

    const dispatch = createMemoizedDispatch(registry);
    const ctx = ctxWith(EMPTY_WORKSPACE);

    await dispatch.execute({ id: '1', name: 'rules-stdlib-list', args: { q: 'a' } }, ctx);
    await dispatch.execute({ id: '2', name: 'write-rules', args: { q: 'a' } }, ctx);
    await dispatch.execute({ id: '3', name: 'rules-stdlib-list', args: { q: 'a' } }, ctx);
    await dispatch.execute({ id: '4', name: 'write-rules', args: { q: 'a' } }, ctx);

    // Pure ran ONCE (second dispatch was a hit). Impure ran every time.
    expect(pureCount).toBe(1);
    expect(impureCount).toBe(2);
    expect(dispatch.stats()).toEqual({ hits: 1, misses: 1, bypassed: 2 });
  });
});
