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

/** Stable list of starter spec names, in registration order. */
export const STARTER_SPEC_NAMES: readonly string[] = [
  SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
  SPEC_REPORT_MENTIONS_ALL_OF,
  SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
  SPEC_FINAL_RULES_INCLUDES_LITERAL,
  SPEC_FINAL_RULES_EXCLUDES_LITERAL,
  SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK,
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

function argsErr(message: string): ArgsErr {
  return { ok: false, err: { ok: false, error: `invalid args: ${message}` } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
