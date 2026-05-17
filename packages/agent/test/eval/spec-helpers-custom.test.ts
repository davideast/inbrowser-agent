import { describe, expect, test } from 'bun:test';
import {
  CUSTOM_SPEC_NAMES,
  EMPTY_RUNTIME,
  EMPTY_WORKSPACE,
  type RunSnapshot,
  SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
  SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
  type TraceEvent,
  createSpecRegistry,
  evaluateSpec,
  registerAllSpecs,
  registerCustomSpecs,
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

describe('registerCustomSpecs', () => {
  test('registers exactly the custom spec names, in order', () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    expect(registry.names()).toEqual([...CUSTOM_SPEC_NAMES]);
    for (const name of CUSTOM_SPEC_NAMES) {
      expect(registry.has(name)).toBe(true);
    }
  });

  test('registerAllSpecs registers starter + custom together without conflict', () => {
    const registry = createSpecRegistry();
    registerAllSpecs(registry);
    expect(registry.has(SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT)).toBe(true);
    expect(registry.has(SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT)).toBe(true);
    // Sanity: a known starter spec is still registered.
    expect(registry.has('final-rules-includes/literal')).toBe(true);
  });
});

describe('custom spec: game-rules/simulator-accepts-positive-and-rejects-cheat (token shape)', () => {
  test('passes when every positive and cheat token is present in finalWorkspace.rules', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const rules =
      'allow update: if request.auth.uid == resource.data.host && ' +
      'request.resource.data.currentTurn == "guest" && request.resource.data.c4 == "X";';
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
        args: {
          database: 'firestore',
          positive: {
            description: 'host plays c4=X and flips turn',
            requiredTokens: ['currentTurn', 'c4', 'host'],
          },
          cheat: {
            description: 'guest writes before turn flip',
            rejectionTokens: ['request.auth.uid', 'currentTurn'],
          },
        },
      },
      emptySnapshot({ finalWorkspace: { ...EMPTY_WORKSPACE, rules } }),
    );
    expect(result.ok).toBe(true);
    const detail = result.detail as {
      missingPositive: string[];
      missingCheat: string[];
      database: string;
    };
    expect(detail.missingPositive).toEqual([]);
    expect(detail.missingCheat).toEqual([]);
    expect(detail.database).toBe('firestore');
  });

  test('fails with per-direction missing-token detail when a positive token is missing', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
        args: {
          positive: { requiredTokens: ['currentTurn', 'NOT_PRESENT'] },
          cheat: { rejectionTokens: ['request.auth'] },
        },
      },
      emptySnapshot({
        finalWorkspace: {
          ...EMPTY_WORKSPACE,
          rules: 'allow if request.auth != null && currentTurn == "X";',
        },
      }),
    );
    expect(result.ok).toBe(false);
    const detail = result.detail as { missingPositive: string[]; missingCheat: string[] };
    expect(detail.missingPositive).toEqual(['NOT_PRESENT']);
    expect(detail.missingCheat).toEqual([]);
  });

  test('fails with per-direction missing-token detail when a cheat token is missing', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
        args: {
          positive: { requiredTokens: ['allow'] },
          cheat: { rejectionTokens: ['NEVER_APPEARS'] },
        },
      },
      emptySnapshot({
        finalWorkspace: { ...EMPTY_WORKSPACE, rules: 'allow update: if false;' },
      }),
    );
    expect(result.ok).toBe(false);
    const detail = result.detail as { missingPositive: string[]; missingCheat: string[] };
    expect(detail.missingPositive).toEqual([]);
    expect(detail.missingCheat).toEqual(['NEVER_APPEARS']);
  });

  test('is case-sensitive (no false positive on a case-folded match)', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
        args: {
          positive: { requiredTokens: ['CURRENTTURN'] },
          cheat: { rejectionTokens: ['request.auth'] },
        },
      },
      emptySnapshot({
        finalWorkspace: { ...EMPTY_WORKSPACE, rules: 'currentTurn == request.auth.uid' },
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('custom spec: game-rules/simulator-accepts-positive-and-rejects-cheat (simulator shape)', () => {
  test('derives tokens from path + data when explicit token lists are absent (happy path)', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    // Cooked rules text that mentions every derived token from both
    // the positive and cheat simulator payloads. This is the v1
    // approximation: a real simulator iteration would run the moves
    // and compare allow/deny outcomes instead.
    const rules = [
      'match /games/g1 {',
      '  // board cells c0..c8, turn marker, move counter',
      "  // marks are 'X' or 'O' from board.c4 / board.c0",
      '  allow update: if request.resource.data.board.c4 == "X"',
      '    && request.resource.data.board.c0 == "O"',
      '    && request.resource.data.currentTurn in ["X", "O"]',
      '    && request.resource.data.moveCount > 0;',
      '}',
    ].join('\n');
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
        args: {
          database: 'rtdb',
          positive: {
            auth: { uid: 'uidA' },
            path: '/games/g1',
            op: 'update',
            data: { board: { c4: 'X' }, currentTurn: 'O', moveCount: 1 },
            expect: 'allow',
          },
          cheat: {
            auth: { uid: 'uidB' },
            path: '/games/g1',
            op: 'update',
            data: { board: { c0: 'O' }, currentTurn: 'X', moveCount: 1 },
            expect: 'deny',
          },
        },
      },
      emptySnapshot({ finalWorkspace: { ...EMPTY_WORKSPACE, rules } }),
    );
    expect(result.ok).toBe(true);
    const detail = result.detail as {
      database: string;
      positiveTokens: string[];
      cheatTokens: string[];
      missingPositive: string[];
      missingCheat: string[];
      approximation: string;
    };
    expect(detail.database).toBe('rtdb');
    // Sanity: derived positive tokens include path segment and string leaves.
    expect(detail.positiveTokens).toContain('games');
    expect(detail.positiveTokens).toContain('c4');
    expect(detail.positiveTokens).toContain('currentTurn');
    expect(detail.missingPositive).toEqual([]);
    expect(detail.missingCheat).toEqual([]);
    expect(detail.approximation).toContain('token-presence');
  });

  test('fails when a derived simulator-shape token is missing from the rules', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
        args: {
          positive: {
            path: '/games/g1',
            data: { board: { c4: 'X' } },
          },
          cheat: {
            path: '/games/g1',
            data: { board: { c0: 'O' } },
          },
        },
      },
      // Rules text is missing both `c4` and `c0` cell references.
      emptySnapshot({
        finalWorkspace: { ...EMPTY_WORKSPACE, rules: 'match /games/{id} { allow read: if true; }' },
      }),
    );
    expect(result.ok).toBe(false);
    const detail = result.detail as { missingPositive: string[]; missingCheat: string[] };
    expect(detail.missingPositive).toContain('c4');
    expect(detail.missingCheat).toContain('c0');
  });

  test('rejects malformed args (cheat missing)', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
        args: { positive: { requiredTokens: ['x'] } },
      },
      emptySnapshot(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid args');
    expect(result.error).toContain('cheat');
  });

  test('rejects malformed args (empty requiredTokens)', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
        args: {
          positive: { requiredTokens: [] },
          cheat: { rejectionTokens: ['x'] },
        },
      },
      emptySnapshot(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid args');
    expect(result.error).toContain('requiredTokens');
  });

  test('rejects malformed args (no tokens and no derivable simulator payload)', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
        args: {
          positive: { auth: { uid: 'x' } },
          cheat: { rejectionTokens: ['x'] },
        },
      },
      emptySnapshot(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid args');
  });
});

describe('custom spec: pyric-agents/lint-clean-and-rule-rejects-cheat', () => {
  test('passes when lint tool was called AND rejection tokens are present', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const rules =
      'match /orders/{orderId} { ' +
      '  allow create: if request.resource.data.claimedPrice == ' +
      '    get(/databases/$(database)/documents/menu/$(request.resource.data.itemId)).data.price; ' +
      '}';
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
        args: {
          lintToolName: 'lint_firestore_rules',
          cheat: {
            description: 'order at tampered price',
            rejectionTokens: ['claimedPrice', 'menu'],
          },
        },
      },
      emptySnapshot({
        trace: [llmResponseEvent(['draft_firestore_rules', 'lint_firestore_rules'])],
        finalWorkspace: { ...EMPTY_WORKSPACE, rules },
      }),
    );
    expect(result.ok).toBe(true);
    const detail = result.detail as { lintCallCount: number; lintToolName: string };
    expect(detail.lintCallCount).toBe(1);
    expect(detail.lintToolName).toBe('lint_firestore_rules');
  });

  test('accepts the simulator-shape arg with cheatAttempt and derives rejection tokens', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    // Rules text that mentions every derived token from the
    // simulator-shape cheatAttempt: path segments and string leaves
    // of `data`. (Numeric leaves like `claimedPrice: 1` are
    // intentionally not derived; only the key `claimedPrice` is.)
    const rules = [
      '// orderA at user-1 for burger menu item',
      'match /orders/{orderId} {',
      '  allow create: if request.resource.data.userId == request.auth.uid',
      '    && request.resource.data.itemId == "burger"',
      '    && request.resource.data.claimedPrice ==',
      '       get(/databases/$(database)/documents/menu/$(request.resource.data.itemId)).data.price;',
      '}',
    ].join('\n');
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
        args: {
          lintToolName: 'lint_firestore_rules',
          cheatAttempt: {
            path: '/orders/orderA',
            op: 'create',
            data: { userId: 'user-1', itemId: 'burger', claimedPrice: 1 },
            expect: 'deny',
          },
        },
      },
      emptySnapshot({
        trace: [llmResponseEvent(['lint_firestore_rules'])],
        finalWorkspace: { ...EMPTY_WORKSPACE, rules },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test('fails with reason=lint-not-called when no matching tool call is in the trace', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
        args: {
          cheat: { rejectionTokens: ['claimedPrice'] },
        },
      },
      emptySnapshot({
        trace: [llmResponseEvent(['write_firestore_rules'])],
        finalWorkspace: {
          ...EMPTY_WORKSPACE,
          rules:
            'match /orders/{orderId} { allow create: if request.resource.data.claimedPrice > 0; }',
        },
      }),
    );
    expect(result.ok).toBe(false);
    const detail = result.detail as { reason: string; lintToolName: string };
    expect(detail.reason).toBe('lint-not-called');
    // Default lint tool name is documented as `lint_firestore_rules`.
    expect(detail.lintToolName).toBe('lint_firestore_rules');
  });

  test('fails with reason=rejection-tokens-missing when lint was called but tokens are absent', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
        args: {
          lintToolName: 'lint_firestore_rules',
          cheat: { rejectionTokens: ['claimedPrice', 'menu'] },
        },
      },
      emptySnapshot({
        trace: [llmResponseEvent(['lint_firestore_rules', 'lint_firestore_rules'])],
        finalWorkspace: {
          ...EMPTY_WORKSPACE,
          rules: 'match /orders/{orderId} { allow create: if true; }',
        },
      }),
    );
    expect(result.ok).toBe(false);
    const detail = result.detail as {
      reason: string;
      missing: string[];
      lintCallCount: number;
    };
    expect(detail.reason).toBe('rejection-tokens-missing');
    expect(detail.missing).toEqual(['claimedPrice', 'menu']);
    expect(detail.lintCallCount).toBe(2);
  });

  test('honors a custom lintToolName', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const passing = await evaluateSpec(
      registry,
      {
        name: SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
        args: {
          lintToolName: 'pyric.lint',
          cheat: { rejectionTokens: ['ok'] },
        },
      },
      emptySnapshot({
        trace: [llmResponseEvent(['pyric.lint'])],
        finalWorkspace: { ...EMPTY_WORKSPACE, rules: 'ok' },
      }),
    );
    expect(passing.ok).toBe(true);

    const missing = await evaluateSpec(
      registry,
      {
        name: SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
        args: {
          lintToolName: 'pyric.lint',
          cheat: { rejectionTokens: ['ok'] },
        },
      },
      emptySnapshot({
        trace: [llmResponseEvent(['lint_firestore_rules'])], // default name; should NOT match
        finalWorkspace: { ...EMPTY_WORKSPACE, rules: 'ok' },
      }),
    );
    expect(missing.ok).toBe(false);
    expect((missing.detail as { reason: string }).reason).toBe('lint-not-called');
  });

  test('rejects malformed args (no cheat / cheatAttempt)', async () => {
    const registry = createSpecRegistry();
    registerCustomSpecs(registry);
    const result = await evaluateSpec(
      registry,
      {
        name: SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
        args: { lintToolName: 'lint_firestore_rules' },
      },
      emptySnapshot(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid args');
  });
});
