import { describe, expect, test } from 'bun:test';
import {
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type RunSnapshot,
  SPEC_FINAL_RULES_EXCLUDES_LITERAL,
  SPEC_FINAL_RULES_INCLUDES_LITERAL,
  SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK,
  SPEC_REPORT_MENTIONS_ALL_OF,
  SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
  SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
  STARTER_SPEC_NAMES,
  type SpecFn,
  type SpecResult,
  type TraceEvent,
  createSpecRegistry,
  evaluateSpec,
  registerStarterSpecs,
} from '../../src/index.js';

function emptySnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    finalWorkspace: EMPTY_WORKSPACE,
    finalRuntime: EMPTY_RUNTIME,
    assistantText: '',
    trace: [],
    ...overrides,
  };
}

function llmResponseEvent(toolNames: string[]): TraceEvent {
  return {
    kind: 'llm_response',
    data: {
      requestId: 'turn-1#0',
      ts: 1_000,
      text: '',
      thinking: '',
      toolCalls: toolNames.map((name, i) => ({ id: `call-${i}`, name, args: {} })),
    },
  };
}

describe('SpecRegistry', () => {
  test('register / get / has / names round-trip', () => {
    const registry = createSpecRegistry();
    const fn: SpecFn = () => ({ ok: true });
    registry.register('demo/always-passes', fn);
    expect(registry.has('demo/always-passes')).toBe(true);
    expect(registry.get('demo/always-passes')).toBe(fn);
    expect(registry.names()).toEqual(['demo/always-passes']);
  });

  test('register throws on malformed name', () => {
    const registry = createSpecRegistry();
    expect(() => registry.register('NotKebab', () => ({ ok: true }))).toThrow(
      /spec name must match/,
    );
    expect(() => registry.register('missing-slash', () => ({ ok: true }))).toThrow(
      /spec name must match/,
    );
    expect(() => registry.register('demo/Trailing', () => ({ ok: true }))).toThrow(
      /spec name must match/,
    );
  });

  test('register throws on duplicate name', () => {
    const registry = createSpecRegistry();
    registry.register('demo/x', () => ({ ok: true }));
    expect(() => registry.register('demo/x', () => ({ ok: false }))).toThrow(
      /spec already registered/,
    );
  });

  test('get / has return undefined / false for unknown names', () => {
    const registry = createSpecRegistry();
    expect(registry.get('demo/missing')).toBeUndefined();
    expect(registry.has('demo/missing')).toBe(false);
  });
});

describe('evaluateSpec', () => {
  test('returns ok:false with a clear message when spec is not registered', async () => {
    const registry = createSpecRegistry();
    const result = await evaluateSpec(registry, { name: 'demo/missing' }, emptySnapshot());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('spec not registered: demo/missing');
  });

  test('awaits async specs', async () => {
    const registry = createSpecRegistry();
    registry.register('demo/async-pass', async () => {
      await Promise.resolve();
      return { ok: true, detail: { source: 'async' } };
    });
    const result = await evaluateSpec(registry, { name: 'demo/async-pass' }, emptySnapshot());
    expect(result.ok).toBe(true);
    expect(result.detail).toEqual({ source: 'async' });
  });

  test('passes args through to the spec body', async () => {
    const registry = createSpecRegistry();
    let seen: unknown;
    registry.register('demo/echo-args', (_snapshot, args) => {
      seen = args;
      return { ok: true };
    });
    await evaluateSpec(
      registry,
      { name: 'demo/echo-args', args: { hello: 'world', n: 3 } },
      emptySnapshot(),
    );
    expect(seen).toEqual({ hello: 'world', n: 3 });
  });

  test('passes args=undefined cleanly when fixture omits them', async () => {
    const registry = createSpecRegistry();
    let seen: unknown = 'sentinel';
    registry.register('demo/no-args', (_snapshot, args) => {
      seen = args;
      return { ok: true };
    });
    await evaluateSpec(registry, { name: 'demo/no-args' }, emptySnapshot());
    expect(seen).toBeUndefined();
  });

  test('catches synchronous throws and converts them to a SpecResult', async () => {
    const registry = createSpecRegistry();
    registry.register('demo/throws-sync', () => {
      throw new Error('boom');
    });
    const result = await evaluateSpec(registry, { name: 'demo/throws-sync' }, emptySnapshot());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('spec "demo/throws-sync" threw: boom');
  });

  test('catches asynchronous rejections and converts them to a SpecResult', async () => {
    const registry = createSpecRegistry();
    registry.register('demo/throws-async', async () => {
      await Promise.resolve();
      throw new Error('async boom');
    });
    const result = await evaluateSpec(registry, { name: 'demo/throws-async' }, emptySnapshot());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('async boom');
  });

  test('reports an error when a spec returns a non-SpecResult value', async () => {
    const registry = createSpecRegistry();
    registry.register('demo/bad-return', (() => 'not a result') as unknown as SpecFn);
    const result = await evaluateSpec(registry, { name: 'demo/bad-return' }, emptySnapshot());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('returned a non-SpecResult value');
  });
});

describe('registerStarterSpecs', () => {
  test('registers all starter spec names', () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    expect(registry.names()).toEqual([...STARTER_SPEC_NAMES]);
    for (const name of STARTER_SPEC_NAMES) {
      expect(registry.has(name)).toBe(true);
    }
  });
});

describe('starter spec: report-mentions/at-least-one-of', () => {
  test('passes when assistantText contains at least one token', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
        args: { tokens: ['open-write', 'broken-auth'] },
      },
      emptySnapshot({
        assistantText: 'The rules contain an open-write vulnerability on /users.',
      }),
    );
    expect(result.ok).toBe(true);
    expect((result.detail as { matched: string[] }).matched).toContain('open-write');
  });

  test('fails when none of the tokens appear', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
        args: { tokens: ['ZZZ', 'YYY'] },
      },
      emptySnapshot({ assistantText: 'unrelated content' }),
    );
    expect(result.ok).toBe(false);
  });

  test('rejects malformed args', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF, args: { tokens: [] } },
      emptySnapshot({ assistantText: 'anything' }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid args');
  });

  test('case-insensitive by default; honors caseSensitive=true', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const ciHit = await evaluateSpec(
      registry,
      { name: SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF, args: { tokens: ['OPEN-WRITE'] } },
      emptySnapshot({ assistantText: 'we found an open-write hole' }),
    );
    expect(ciHit.ok).toBe(true);
    const csMiss = await evaluateSpec(
      registry,
      {
        name: SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
        args: { tokens: ['OPEN-WRITE'], caseSensitive: true },
      },
      emptySnapshot({ assistantText: 'we found an open-write hole' }),
    );
    expect(csMiss.ok).toBe(false);
  });
});

describe('starter spec: report-mentions/all-of', () => {
  test('passes when every token appears', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_REPORT_MENTIONS_ALL_OF, args: { tokens: ['users', 'open-write'] } },
      emptySnapshot({ assistantText: 'open-write on /users is bad' }),
    );
    expect(result.ok).toBe(true);
  });

  test('fails when any token is missing and reports it in detail', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_REPORT_MENTIONS_ALL_OF, args: { tokens: ['users', 'auth-check'] } },
      emptySnapshot({ assistantText: 'mentions users only' }),
    );
    expect(result.ok).toBe(false);
    const detail = result.detail as { missing: string[] };
    expect(detail.missing).toContain('auth-check');
  });
});

describe('starter spec: trace-contains-tool-call/by-name', () => {
  test('passes when the trace contains at least one matching tool call', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
        args: { tool: 'rulesSimulator' },
      },
      emptySnapshot({ trace: [llmResponseEvent(['rulesSimulator', 'discoverPaths'])] }),
    );
    expect(result.ok).toBe(true);
    expect((result.detail as { count: number }).count).toBe(1);
  });

  test('honors minCount', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const trace: TraceEvent[] = [
      llmResponseEvent(['rulesSimulator']),
      llmResponseEvent(['rulesSimulator', 'rulesSimulator']),
    ];
    const passes = await evaluateSpec(
      registry,
      {
        name: SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
        args: { tool: 'rulesSimulator', minCount: 3 },
      },
      emptySnapshot({ trace }),
    );
    expect(passes.ok).toBe(true);
    const fails = await evaluateSpec(
      registry,
      {
        name: SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
        args: { tool: 'rulesSimulator', minCount: 4 },
      },
      emptySnapshot({ trace }),
    );
    expect(fails.ok).toBe(false);
  });

  test('fails when no matching tool call appears', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME, args: { tool: 'missingTool' } },
      emptySnapshot({ trace: [llmResponseEvent(['somethingElse'])] }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('starter spec: final-rules-includes/literal', () => {
  test('passes when rules contain the literal', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_FINAL_RULES_INCLUDES_LITERAL, args: { literal: 'request.auth != null' } },
      emptySnapshot({
        finalWorkspace: {
          ...EMPTY_WORKSPACE,
          rules: 'allow read: if request.auth != null;',
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test('fails when rules do not contain the literal', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_FINAL_RULES_INCLUDES_LITERAL, args: { literal: 'request.auth != null' } },
      emptySnapshot({
        finalWorkspace: { ...EMPTY_WORKSPACE, rules: 'allow read: if true;' },
      }),
    );
    expect(result.ok).toBe(false);
  });

  test('case-sensitive by default for rules to avoid false positives on case-folded operators', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_FINAL_RULES_INCLUDES_LITERAL, args: { literal: 'REQUEST.AUTH' } },
      emptySnapshot({
        finalWorkspace: {
          ...EMPTY_WORKSPACE,
          rules: 'allow read: if request.auth != null;',
        },
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('starter spec: final-rules-excludes/literal', () => {
  test('passes when rules do not contain the literal', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_FINAL_RULES_EXCLUDES_LITERAL, args: { literal: 'allow write: if true' } },
      emptySnapshot({
        finalWorkspace: {
          ...EMPTY_WORKSPACE,
          rules: 'allow write: if request.auth != null;',
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test('fails when rules still contain the planted antipattern', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_FINAL_RULES_EXCLUDES_LITERAL, args: { literal: 'allow write: if true' } },
      emptySnapshot({
        finalWorkspace: { ...EMPTY_WORKSPACE, rules: 'allow write: if true;' },
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('starter spec: final-runtime/run-summary-ok', () => {
  test('passes when the most recent runSummary is ok', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK },
      emptySnapshot({
        finalRuntime: {
          ...EMPTY_RUNTIME,
          runSummary: { ok: true, durationMs: 12, docsTouched: 1, errors: 0 },
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test('fails when the most recent runSummary is not ok', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK },
      emptySnapshot({
        finalRuntime: {
          ...EMPTY_RUNTIME,
          runSummary: { ok: false, durationMs: 0, docsTouched: 0, errors: 1, message: 'denied' },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect((result.detail as { message?: string }).message).toBe('denied');
  });

  test('fails with an explanatory detail when no run summary exists', async () => {
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const result = await evaluateSpec(
      registry,
      { name: SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK },
      emptySnapshot(),
    );
    expect(result.ok).toBe(false);
    expect((result.detail as { reason: string }).reason).toContain('no run summary');
  });
});

describe('SpecResult shape', () => {
  test('starter specs only return SpecResult-compatible values', async () => {
    // Smoke test: every starter spec, run with valid args on an empty
    // snapshot, returns a result with `ok` as a boolean.
    const registry = createSpecRegistry();
    registerStarterSpecs(registry);
    const cases: Array<{ name: string; args?: Record<string, unknown> }> = [
      { name: SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF, args: { tokens: ['x'] } },
      { name: SPEC_REPORT_MENTIONS_ALL_OF, args: { tokens: ['x'] } },
      { name: SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME, args: { tool: 'x' } },
      { name: SPEC_FINAL_RULES_INCLUDES_LITERAL, args: { literal: 'x' } },
      { name: SPEC_FINAL_RULES_EXCLUDES_LITERAL, args: { literal: 'x' } },
      { name: SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK },
    ];
    for (const c of cases) {
      const result: SpecResult = await evaluateSpec(registry, c, emptySnapshot());
      expect(typeof result.ok).toBe('boolean');
    }
  });
});
