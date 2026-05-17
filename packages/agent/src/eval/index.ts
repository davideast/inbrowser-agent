export type {
  PartialWorkspace,
  SkillName,
  SuccessSpecReference,
  TaskFixture,
  ValidationError,
  ValidationResult,
} from './fixture.js';
export { SKILL_NAMES, applyWorkspaceOverrides, parseFixture, validateFixture } from './fixture.js';

export type { RunRecord } from './run-record.js';
export type {
  RunFixtureInput,
  RunFixturesDeps,
  RunFixturesOptions,
} from './runner.js';
export { defaultSystemPromptBuilder, runFixture, runFixtures } from './runner.js';

export type { RunSnapshot, SpecFn, SpecRegistry, SpecResult } from './spec-framework.js';
export { createSpecRegistry, evaluateSpec } from './spec-framework.js';

export type {
  AggregateStat,
  AggregatedMetrics,
  CollectMetricsInput,
  MetricsTable,
  TrialMetrics,
} from './metric-collector.js';
export { aggregateTrials, collectMetrics, extractTrialMetrics } from './metric-collector.js';

export type {
  CompareMetricsInput,
  ComparisonFixture,
  ComparisonLabel,
  ComparisonMetricName,
  ComparisonReport,
  ComparisonRow,
  Polarity,
} from './comparison-report.js';
export { POLARITY, compareMetrics, renderJson, renderMarkdown } from './comparison-report.js';

export {
  CUSTOM_SPEC_NAMES,
  SPEC_FINAL_RULES_EXCLUDES_LITERAL,
  SPEC_FINAL_RULES_INCLUDES_LITERAL,
  SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK,
  SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
  SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
  SPEC_REPORT_MENTIONS_ALL_OF,
  SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
  SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
  STARTER_SPEC_NAMES,
  finalRulesExcludesLiteral,
  finalRulesIncludesLiteral,
  finalRuntimeRunSummaryOk,
  gameRulesSimulatorAcceptsPositiveAndRejectsCheat,
  pyricAgentsLintCleanAndRuleRejectsCheat,
  registerAllSpecs,
  registerCustomSpecs,
  registerStarterSpecs,
  reportMentionsAllOf,
  reportMentionsAtLeastOneOf,
  traceContainsToolCallByName,
} from './spec-helpers.js';
