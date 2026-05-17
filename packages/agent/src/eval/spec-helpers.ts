/**
 * Starter library of common success specs.
 *
 * These helpers are intentionally crude. Golden-task authors compose
 * them through `SuccessSpecReference.args`; custom specs are written
 * only when crudeness is not enough.
 *
 * Registration is explicit. Callers create a registry and call
 * `registerStarterSpecs(registry)` to get all six helpers under their
 * documented names. No side-effect registration on import — that way
 * a host can choose to register a subset, swap in stricter variants,
 * or shadow a helper without monkey-patching this module.
 *
 * Each helper has a `family/spec-name` kebab-case identifier that
 * matches the form `validateFixture` enforces on
 * `SuccessSpecReference.name`. The constants below are exported so
 * fixture authors and reviewers have a single place to import the
 * canonical strings from.
 *
 * Argument shape and behavior are documented per-spec via JSDoc.
 * The framework treats `args` as `unknown`; each spec validates its
 * own shape and surfaces a clear `error` if the args are malformed,
 * rather than throwing. (The evaluator catches throws too, but a
 * structured error message is friendlier to read.)
 */

import type { RunSnapshot, SpecFn, SpecRegistry, SpecResult } from './spec-framework.js';

export const SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF = 'report-mentions/at-least-one-of';
export const SPEC_REPORT_MENTIONS_ALL_OF = 'report-mentions/all-of';
export const SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME = 'trace-contains-tool-call/by-name';
export const SPEC_FINAL_RULES_INCLUDES_LITERAL = 'final-rules-includes/literal';
export const SPEC_FINAL_RULES_EXCLUDES_LITERAL = 'final-rules-excludes/literal';
export const SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK = 'final-runtime/run-summary-ok';

export const SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT =
  'game-rules/simulator-accepts-positive-and-rejects-cheat';
export const SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT =
  'pyric-agents/lint-clean-and-rule-rejects-cheat';

/**
 * Args: `{ tokens: string[]; caseSensitive?: boolean }`.
 *
 * Passes when `assistantText` contains at least one of `tokens`.
 * Empty / non-array `tokens` is a malformed-args error.
 *
 * Example fixture reference:
 *
 *     {
 *       "name": "report-mentions/at-least-one-of",
 *       "args": { "tokens": ["open-write", "missing auth check"] }
 *     }
 */
export const reportMentionsAtLeastOneOf: SpecFn = (snapshot, args) => {
  const parsed = parseTokensArgs(args, { defaultCaseSensitive: false });
  if (!parsed.ok) return parsed.err;

  const haystack = parsed.caseSensitive
    ? snapshot.assistantText
    : snapshot.assistantText.toLowerCase();
  const needles = parsed.caseSensitive ? parsed.tokens : parsed.tokens.map((t) => t.toLowerCase());
  const matched = needles.filter((needle) => haystack.includes(needle));

  return {
    ok: matched.length > 0,
    detail: {
      matched,
      missing: needles.filter((needle) => !haystack.includes(needle)),
    },
  };
};

/**
 * Args: `{ tokens: string[]; caseSensitive?: boolean }`.
 *
 * Passes when `assistantText` contains every entry in `tokens`.
 * Empty / non-array `tokens` is a malformed-args error.
 *
 * Example fixture reference:
 *
 *     {
 *       "name": "report-mentions/all-of",
 *       "args": { "tokens": ["users", "open-write", "fix"] }
 *     }
 */
export const reportMentionsAllOf: SpecFn = (snapshot, args) => {
  const parsed = parseTokensArgs(args, { defaultCaseSensitive: false });
  if (!parsed.ok) return parsed.err;

  const haystack = parsed.caseSensitive
    ? snapshot.assistantText
    : snapshot.assistantText.toLowerCase();
  const needles = parsed.caseSensitive ? parsed.tokens : parsed.tokens.map((t) => t.toLowerCase());
  const missing = needles.filter((needle) => !haystack.includes(needle));

  return {
    ok: missing.length === 0,
    detail: {
      matched: needles.filter((needle) => haystack.includes(needle)),
      missing,
    },
  };
};

/**
 * Args: `{ tool: string; minCount?: number }`.
 *
 * Passes when the trace contains at least `minCount` (default 1)
 * `tool_call` records emitted by the response trace for a tool named
 * `tool`. Tool calls are read off `llm_response` trace events, which
 * is where the agent loop records what the model asked for in each
 * iteration.
 *
 * Example fixture reference:
 *
 *     {
 *       "name": "trace-contains-tool-call/by-name",
 *       "args": { "tool": "rulesSimulator", "minCount": 1 }
 *     }
 */
export const traceContainsToolCallByName: SpecFn = (snapshot, args) => {
  const parsed = parseToolCallArgs(args);
  if (!parsed.ok) return parsed.err;

  let count = 0;
  for (const event of snapshot.trace) {
    if (event.kind !== 'llm_response') continue;
    for (const call of event.data.toolCalls) {
      if (call.name === parsed.tool) count += 1;
    }
  }

  return {
    ok: count >= parsed.minCount,
    detail: { tool: parsed.tool, count, minCount: parsed.minCount },
  };
};

/**
 * Args: `{ literal: string; caseSensitive?: boolean }`.
 *
 * Passes when `finalWorkspace.rules` contains `literal` as a substring.
 * `literal` must be a non-empty string.
 *
 * Example fixture reference:
 *
 *     {
 *       "name": "final-rules-includes/literal",
 *       "args": { "literal": "request.auth != null" }
 *     }
 */
export const finalRulesIncludesLiteral: SpecFn = (snapshot, args) => {
  return rulesContains(snapshot, args, /* shouldInclude */ true);
};

/**
 * Args: `{ literal: string; caseSensitive?: boolean }`.
 *
 * Passes when `finalWorkspace.rules` does NOT contain `literal` as a
 * substring. Useful for asserting that a planted antipattern has been
 * removed.
 *
 * Example fixture reference:
 *
 *     {
 *       "name": "final-rules-excludes/literal",
 *       "args": { "literal": "allow write: if true" }
 *     }
 */
export const finalRulesExcludesLiteral: SpecFn = (snapshot, args) => {
  return rulesContains(snapshot, args, /* shouldInclude */ false);
};

/**
 * Args: none (`undefined` or `{}`).
 *
 * Passes when `finalRuntime.runSummary` exists and `runSummary.ok` is
 * true — i.e. the most recent `runCode` invocation succeeded. Fails
 * when there is no run summary at all (the spec only makes sense for
 * fixtures whose skill is expected to run code).
 *
 * Example fixture reference:
 *
 *     { "name": "final-runtime/run-summary-ok" }
 */
export const finalRuntimeRunSummaryOk: SpecFn = (snapshot) => {
  const summary = snapshot.finalRuntime.runSummary;
  if (!summary) {
    return {
      ok: false,
      detail: { reason: 'no run summary captured' },
    };
  }
  return {
    ok: summary.ok === true,
    detail: {
      ok: summary.ok,
      durationMs: summary.durationMs,
      docsTouched: summary.docsTouched,
      errors: summary.errors,
      ...(summary.message ? { message: summary.message } : {}),
    },
  };
};

/**
 * Args: `{ database?: 'firestore' | 'rtdb'; positive: PositiveArgs; cheat: CheatArgs }`.
 *
 * Both-direction check: the generated rules should accept a defined
 * positive move AND reject a defined cheating attempt. The fixture
 * supplies one side under `positive` and the other under `cheat`.
 *
 * V1 approximation: token-presence over `finalWorkspace.rules`. A
 * future iteration would replace this with an actual Firestore /
 * Realtime Database security-rules simulator call, exercising the
 * `positive` move (expecting `allow`) and the `cheat` move
 * (expecting `deny`). Wiring that simulator is out of scope for v1
 * because it requires either the Firebase rules-emulator process
 * (Node-only, slow to start, off-limits in a browser-safe surface)
 * or a bundled WASM rules interpreter — neither of which the eval
 * harness has today.
 *
 * The approximation supports two arg-shapes so it can serve both
 * the brief's documented shape and the simulator-style shape the
 * generative fixtures already use on disk:
 *
 *   1. Token shape (explicit, preferred for future-authored fixtures):
 *        positive: { description?: string; requiredTokens: string[] }
 *        cheat:    { description?: string; rejectionTokens: string[] }
 *      Each token list is checked as case-sensitive substrings on
 *      `finalWorkspace.rules`.
 *
 *   2. Simulator shape (used by the existing fixtures):
 *        positive: { auth, path, op, data, expect: 'allow' }
 *        cheat:    { auth, path, op, data, expect: 'deny' }
 *      Tokens are derived from the simulator-side `data` and `path`
 *      values — each string-valued leaf and the path segment are
 *      required to appear in the rules text. The expectation field
 *      (`allow` / `deny`) is recorded in the detail payload but is
 *      not used by the token check; the actual accept/reject
 *      decision is what the future simulator iteration would
 *      validate.
 *
 * Passes iff every derived positive token AND every derived cheat
 * token appears in `finalWorkspace.rules`. Otherwise returns
 * `{ ok: false, detail: { missingPositive, missingCheat } }`.
 *
 * Example fixture reference (simulator shape):
 *
 *     {
 *       "name": "game-rules/simulator-accepts-positive-and-rejects-cheat",
 *       "args": {
 *         "database": "rtdb",
 *         "positive": { "auth": { "uid": "uidA" }, "path": "/games/g1",
 *                       "op": "update", "data": { ... }, "expect": "allow" },
 *         "cheat":    { "auth": { "uid": "uidB" }, "path": "/games/g1",
 *                       "op": "update", "data": { ... }, "expect": "deny" }
 *       }
 *     }
 */
export const gameRulesSimulatorAcceptsPositiveAndRejectsCheat: SpecFn = (snapshot, args) => {
  const parsed = parseGameRulesSimulatorArgs(args);
  if (!parsed.ok) return parsed.err;

  const rules = snapshot.finalWorkspace.rules;
  const missingPositive = parsed.positiveTokens.filter((token) => !rules.includes(token));
  const missingCheat = parsed.cheatTokens.filter((token) => !rules.includes(token));

  const ok = missingPositive.length === 0 && missingCheat.length === 0;
  return {
    ok,
    detail: {
      database: parsed.database,
      positiveTokens: parsed.positiveTokens,
      cheatTokens: parsed.cheatTokens,
      missingPositive,
      missingCheat,
      approximation: 'token-presence (v1; future iteration: real rules simulator)',
    },
  };
};

/**
 * Args: `{ lintToolName?: string; cheat?: CheatArgs; cheatAttempt?: CheatArgs }`.
 *
 * Two-part check: (1) the agent successfully called the pyric lint
 * tool during the run, AND (2) the resulting rules text contains the
 * tokens that should be present if the cheating attempt is
 * structurally rejected by the rules.
 *
 * V1 approximation:
 *   - Step 1 walks `snapshot.trace` for any `llm_response` event
 *     containing a tool call whose name matches `lintToolName`
 *     (default `lint_firestore_rules`). If absent, returns
 *     `{ ok: false, detail: { reason: 'lint-not-called' } }`. The
 *     pyric lint tool's success/failure is observable in the
 *     assistant's reasoning and in the tool result, but capturing
 *     the precise `tool_result` event shape across providers is
 *     fragile — checking that the tool was *called* is the right
 *     v1 signal. A future iteration would also verify the lint
 *     tool's result was `ok: true` at the trace level.
 *   - Step 2 checks `finalWorkspace.rules` includes every token in
 *     the cheat's `rejectionTokens`. The cheat may be supplied
 *     under either `cheat` (the brief's name) or `cheatAttempt`
 *     (the name the existing fixture uses). When the cheat is
 *     simulator-shaped (no `rejectionTokens`, only `data` + `path`),
 *     tokens are derived from those leaves the same way as
 *     `gameRulesSimulatorAcceptsPositiveAndRejectsCheat`.
 *
 * Returns `{ ok: true }` on success, or
 * `{ ok: false, detail: { reason: 'rejection-tokens-missing', missing } }`
 * on the second-step failure.
 *
 * Example fixture reference:
 *
 *     {
 *       "name": "pyric-agents/lint-clean-and-rule-rejects-cheat",
 *       "args": {
 *         "lintToolName": "lint_firestore_rules",
 *         "cheatAttempt": { "path": "/orders/orderA", "op": "create",
 *                           "data": { ... }, "expect": "deny" }
 *       }
 *     }
 */
export const pyricAgentsLintCleanAndRuleRejectsCheat: SpecFn = (snapshot, args) => {
  const parsed = parsePyricLintArgs(args);
  if (!parsed.ok) return parsed.err;

  let lintCalled = false;
  let lintCallCount = 0;
  for (const event of snapshot.trace) {
    if (event.kind !== 'llm_response') continue;
    for (const call of event.data.toolCalls) {
      if (call.name === parsed.lintToolName) {
        lintCalled = true;
        lintCallCount += 1;
      }
    }
  }

  if (!lintCalled) {
    return {
      ok: false,
      detail: {
        reason: 'lint-not-called',
        lintToolName: parsed.lintToolName,
        approximation: 'lint-tool-called (v1; future iteration: also verify lint result ok:true)',
      },
    };
  }

  const rules = snapshot.finalWorkspace.rules;
  const missing = parsed.rejectionTokens.filter((token) => !rules.includes(token));
  if (missing.length > 0) {
    return {
      ok: false,
      detail: {
        reason: 'rejection-tokens-missing',
        lintToolName: parsed.lintToolName,
        lintCallCount,
        rejectionTokens: parsed.rejectionTokens,
        missing,
        approximation: 'token-presence (v1; future iteration: real rules simulator)',
      },
    };
  }

  return {
    ok: true,
    detail: {
      lintToolName: parsed.lintToolName,
      lintCallCount,
      rejectionTokens: parsed.rejectionTokens,
      approximation:
        'lint-called + token-presence (v1; future iteration: real lint result + rules simulator)',
    },
  };
};

/**
 * Register every starter spec on a registry. Idempotency is not a
 * design goal — calling this twice on the same registry throws (the
 * registry rejects duplicate registrations on purpose). Callers that
 * want a subset should call `registry.register()` themselves.
 */
export function registerStarterSpecs(registry: SpecRegistry): void {
  registry.register(SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF, reportMentionsAtLeastOneOf);
  registry.register(SPEC_REPORT_MENTIONS_ALL_OF, reportMentionsAllOf);
  registry.register(SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME, traceContainsToolCallByName);
  registry.register(SPEC_FINAL_RULES_INCLUDES_LITERAL, finalRulesIncludesLiteral);
  registry.register(SPEC_FINAL_RULES_EXCLUDES_LITERAL, finalRulesExcludesLiteral);
  registry.register(SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK, finalRuntimeRunSummaryOk);
}

/**
 * Register every custom (post-starter) spec on a registry. Sibling
 * to `registerStarterSpecs`. Splitting the two keeps the meaning of
 * "starter" stable as new custom specs are added.
 */
export function registerCustomSpecs(registry: SpecRegistry): void {
  registry.register(
    SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
    gameRulesSimulatorAcceptsPositiveAndRejectsCheat,
  );
  registry.register(
    SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
    pyricAgentsLintCleanAndRuleRejectsCheat,
  );
}

/**
 * Umbrella that registers every spec the library ships — both the
 * starter library and the custom helpers. Equivalent to calling
 * `registerStarterSpecs(registry)` followed by
 * `registerCustomSpecs(registry)`.
 */
export function registerAllSpecs(registry: SpecRegistry): void {
  registerStarterSpecs(registry);
  registerCustomSpecs(registry);
}

/** Stable list of starter spec names, in registration order. */
export const STARTER_SPEC_NAMES: readonly string[] = [
  SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
  SPEC_REPORT_MENTIONS_ALL_OF,
  SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
  SPEC_FINAL_RULES_INCLUDES_LITERAL,
  SPEC_FINAL_RULES_EXCLUDES_LITERAL,
  SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK,
];

/** Stable list of custom spec names, in registration order. */
export const CUSTOM_SPEC_NAMES: readonly string[] = [
  SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
  SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
];

// ---------------------------------------------------------------------------
// Internal arg parsing helpers. Each starter spec calls one of these and
// returns the `err` SpecResult unchanged on a parse failure, so the
// fixture author sees the same error shape across the library.
// ---------------------------------------------------------------------------

interface TokensArgs {
  ok: true;
  tokens: string[];
  caseSensitive: boolean;
}

interface ToolCallArgs {
  ok: true;
  tool: string;
  minCount: number;
}

interface LiteralArgs {
  ok: true;
  literal: string;
  caseSensitive: boolean;
}

interface ArgsErr {
  ok: false;
  err: SpecResult;
}

function parseTokensArgs(
  args: unknown,
  opts: { defaultCaseSensitive: boolean },
): TokensArgs | ArgsErr {
  if (!isPlainObject(args)) {
    return argsErr('args must be an object with a `tokens` string[] field');
  }
  const { tokens, caseSensitive } = args as { tokens?: unknown; caseSensitive?: unknown };
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return argsErr('args.tokens must be a non-empty string[]');
  }
  if (!tokens.every((t): t is string => typeof t === 'string' && t.length > 0)) {
    return argsErr('args.tokens must contain only non-empty strings');
  }
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
    return argsErr('args.caseSensitive must be a boolean when present');
  }
  return {
    ok: true,
    tokens,
    caseSensitive: caseSensitive === undefined ? opts.defaultCaseSensitive : caseSensitive,
  };
}

function parseToolCallArgs(args: unknown): ToolCallArgs | ArgsErr {
  if (!isPlainObject(args)) {
    return argsErr('args must be an object with a `tool` string field');
  }
  const { tool, minCount } = args as { tool?: unknown; minCount?: unknown };
  if (typeof tool !== 'string' || tool.length === 0) {
    return argsErr('args.tool must be a non-empty string');
  }
  if (
    minCount !== undefined &&
    (typeof minCount !== 'number' || !Number.isInteger(minCount) || minCount < 1)
  ) {
    return argsErr('args.minCount must be a positive integer when present');
  }
  return {
    ok: true,
    tool,
    minCount: typeof minCount === 'number' ? minCount : 1,
  };
}

function parseLiteralArgs(args: unknown): LiteralArgs | ArgsErr {
  if (!isPlainObject(args)) {
    return argsErr('args must be an object with a `literal` string field');
  }
  const { literal, caseSensitive } = args as { literal?: unknown; caseSensitive?: unknown };
  if (typeof literal !== 'string' || literal.length === 0) {
    return argsErr('args.literal must be a non-empty string');
  }
  if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
    return argsErr('args.caseSensitive must be a boolean when present');
  }
  return {
    ok: true,
    literal,
    caseSensitive: caseSensitive === undefined ? true : caseSensitive,
  };
}

function rulesContains(snapshot: RunSnapshot, args: unknown, shouldInclude: boolean): SpecResult {
  const parsed = parseLiteralArgs(args);
  if (!parsed.ok) return parsed.err;
  const haystack = parsed.caseSensitive
    ? snapshot.finalWorkspace.rules
    : snapshot.finalWorkspace.rules.toLowerCase();
  const needle = parsed.caseSensitive ? parsed.literal : parsed.literal.toLowerCase();
  const includes = haystack.includes(needle);
  return {
    ok: shouldInclude ? includes : !includes,
    detail: { literal: parsed.literal, includes },
  };
}

interface GameRulesSimulatorArgs {
  ok: true;
  database: 'firestore' | 'rtdb' | undefined;
  positiveTokens: string[];
  cheatTokens: string[];
}

interface PyricLintArgs {
  ok: true;
  lintToolName: string;
  rejectionTokens: string[];
}

function parseGameRulesSimulatorArgs(args: unknown): GameRulesSimulatorArgs | ArgsErr {
  if (!isPlainObject(args)) {
    return argsErr('args must be an object with `positive` and `cheat` fields');
  }
  const { database, positive, cheat } = args as {
    database?: unknown;
    positive?: unknown;
    cheat?: unknown;
  };
  if (database !== undefined && database !== 'firestore' && database !== 'rtdb') {
    return argsErr('args.database must be "firestore" or "rtdb" when present');
  }
  if (!isPlainObject(positive)) {
    return argsErr('args.positive must be an object');
  }
  if (!isPlainObject(cheat)) {
    return argsErr('args.cheat must be an object');
  }
  const positiveTokens = deriveSideTokens(positive, 'positive', 'requiredTokens');
  if (!positiveTokens.ok) return positiveTokens;
  const cheatTokens = deriveSideTokens(cheat, 'cheat', 'rejectionTokens');
  if (!cheatTokens.ok) return cheatTokens;
  return {
    ok: true,
    database: database as 'firestore' | 'rtdb' | undefined,
    positiveTokens: positiveTokens.tokens,
    cheatTokens: cheatTokens.tokens,
  };
}

function parsePyricLintArgs(args: unknown): PyricLintArgs | ArgsErr {
  if (!isPlainObject(args)) {
    return argsErr('args must be an object');
  }
  const obj = args as {
    lintToolName?: unknown;
    cheat?: unknown;
    cheatAttempt?: unknown;
  };
  if (obj.lintToolName !== undefined && typeof obj.lintToolName !== 'string') {
    return argsErr('args.lintToolName must be a string when present');
  }
  if (typeof obj.lintToolName === 'string' && obj.lintToolName.length === 0) {
    return argsErr('args.lintToolName must be a non-empty string when present');
  }
  const cheat = obj.cheat ?? obj.cheatAttempt;
  if (!isPlainObject(cheat)) {
    return argsErr('args.cheat (or args.cheatAttempt) must be an object');
  }
  const cheatTokens = deriveSideTokens(cheat, 'cheat', 'rejectionTokens');
  if (!cheatTokens.ok) return cheatTokens;
  return {
    ok: true,
    lintToolName: typeof obj.lintToolName === 'string' ? obj.lintToolName : 'lint_firestore_rules',
    rejectionTokens: cheatTokens.tokens,
  };
}

interface DerivedTokens {
  ok: true;
  tokens: string[];
}

/**
 * Two arg-shapes are supported per the v1 approximation:
 *
 *   1. Explicit token list under `requiredTokens` / `rejectionTokens`.
 *      Validated as a non-empty string[] of non-empty entries.
 *   2. Simulator-style payload with `data` (object) and/or `path`
 *      (string). String-valued leaves of `data` plus the `path`
 *      (when present) are treated as required tokens. Numeric or
 *      boolean leaves are intentionally skipped — they would
 *      collide with arbitrary numbers and `true`/`false` literals
 *      in the rules text and produce false-positive matches.
 *
 * An empty derived token list is a malformed-args error so a
 * misconfigured fixture surfaces immediately rather than silently
 * passing.
 */
function deriveSideTokens(
  side: Record<string, unknown>,
  label: string,
  tokensField: 'requiredTokens' | 'rejectionTokens',
): DerivedTokens | ArgsErr {
  const explicit = side[tokensField];
  if (explicit !== undefined) {
    if (!Array.isArray(explicit) || explicit.length === 0) {
      return argsErr(`args.${label}.${tokensField} must be a non-empty string[] when present`);
    }
    if (!explicit.every((t): t is string => typeof t === 'string' && t.length > 0)) {
      return argsErr(`args.${label}.${tokensField} must contain only non-empty strings`);
    }
    return { ok: true, tokens: explicit };
  }
  const collected: string[] = [];
  const path = side.path;
  if (typeof path === 'string' && path.length > 0) {
    for (const segment of path.split('/')) {
      if (segment.length > 0) collected.push(segment);
    }
  }
  if (side.data !== undefined) {
    collectStringLeaves(side.data, collected);
  }
  if (collected.length === 0) {
    return argsErr(
      `args.${label} must supply either ${tokensField}: string[] or a simulator-style payload ` +
        `(path/data) from which tokens can be derived`,
    );
  }
  // De-dup while preserving insertion order.
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const t of collected) {
    if (!seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  }
  return { ok: true, tokens };
}

function collectStringLeaves(value: unknown, sink: string[]): void {
  if (typeof value === 'string') {
    if (value.length > 0) sink.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, sink);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      sink.push(key);
      collectStringLeaves((value as Record<string, unknown>)[key], sink);
    }
  }
  // numbers, booleans, null, undefined: intentionally skipped.
}

function argsErr(message: string): ArgsErr {
  return { ok: false, err: { ok: false, error: `invalid args: ${message}` } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
