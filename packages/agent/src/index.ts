/**
 * `@inbrowser/agent` — agent runtime + agent-friendly CLI.
 *
 * The library surface (this module) exports the primitives the
 * playground UI consumes: `AgentSession`, `AgentStrategy`, `ToolRegistry`,
 * `LlmClient`, `MetricsCollector`, `SandboxObserver`, plus the default
 * `createReactLoopStrategy()` and `createAgentSession()`.
 *
 * The CLI surface lives under `@inbrowser/agent/cli` and the `agent` binary
 * — see `src/cli/main.ts` and the package's `AGENTS.md` for invariants.
 *
 * No React, no DOM, no localStorage, no fetch. All I/O is via injected
 * interfaces.
 */

export type { Workspace, StitchContext } from './types/workspace.js';
export { EMPTY_WORKSPACE } from './types/workspace.js';

export type { ProjectContext } from './types/project-context.js';

export type {
  RuntimeState,
  TerminalSection,
  TerminalEntry,
  RunSummary,
  DeployState,
  DeployMessage,
  ParseError,
  UiError,
} from './types/runtime.js';
export { EMPTY_RUNTIME } from './types/runtime.js';

export type {
  ChatMessage,
  ChatRole,
  ToolCall as ChatToolCall,
  TurnMetrics,
  TurnDetails,
  NormalizedMessage,
} from './types/chat.js';

export type {
  LlmClient,
  LlmClientFactory,
  LlmConfig,
  ChatRequest,
  ChatEvent,
  ToolDeclaration,
  JsonSchema,
  RawUsage,
} from './types/llm.js';
export { legacyProviderAsLlmClient } from './llm-adapter.js';
export type {
  LegacyProvider,
  LegacyChatTurnResult,
  LegacyChatCallbacks,
  LegacyChatMessage,
  LegacyToolDecl,
  LegacyProviderUsage,
  LegacyTurnDetails,
} from './llm-adapter.js';

export type {
  ToolHandler,
  ToolContext,
  ToolResult,
  ToolCall,
  ToolRegistry,
  ToolDispatch,
  SandboxHandle,
  LintFn,
  LintWarning,
  StitchClient,
} from './types/tools.js';
export { createToolRegistry, createDispatch, isParallelSafe, isPure } from './tools.js';

export type { Capabilities } from './types/capabilities.js';
export { DEFAULT_CAPABILITIES } from './types/capabilities.js';

export type {
  AgentSession,
  AgentSessionConfig,
  SessionEvent,
} from './types/session.js';
export { createAgentSession } from './session.js';

export type {
  AgentStrategy,
  StrategyRunInput,
  StrategyEvent,
} from './types/strategy.js';
export { createReactLoopStrategy } from './strategy.js';

export type {
  Tracer,
  TraceEvent,
  LlmRequestTrace,
  LlmResponseTrace,
  TurnDispatchCompleteTrace,
  ToolDeclarationView,
} from './types/trace.js';

export type { TurnTimingRow } from './diagnostics/timing.js';
export { turnTimingTable } from './diagnostics/timing.js';

export type {
  TruthfulnessFlag,
  TruthfulnessFlagCategory,
  TruthfulnessReport,
} from './diagnostics/index.js';
export { analyzeTruthfulness } from './diagnostics/index.js';

export type {
  PartialWorkspace,
  RunSnapshot,
  SkillName,
  SpecFn,
  SpecRegistry,
  SpecResult,
  SuccessSpecReference,
  TaskFixture,
  ValidationError,
  ValidationResult,
} from './eval/index.js';
export {
  SKILL_NAMES,
  SPEC_FINAL_RULES_EXCLUDES_LITERAL,
  SPEC_FINAL_RULES_INCLUDES_LITERAL,
  SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK,
  SPEC_REPORT_MENTIONS_ALL_OF,
  SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
  SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
  STARTER_SPEC_NAMES,
  applyWorkspaceOverrides,
  createSpecRegistry,
  evaluateSpec,
  finalRulesExcludesLiteral,
  finalRulesIncludesLiteral,
  finalRuntimeRunSummaryOk,
  parseFixture,
  registerStarterSpecs,
  reportMentionsAllOf,
  reportMentionsAtLeastOneOf,
  traceContainsToolCallByName,
  validateFixture,
} from './eval/index.js';

// Eval harness runner surface. The eval-side `RunRecord` is exposed
// here as `EvalRunRecord` to avoid colliding with the
// per-MCP-tool-call `RunRecord` exported below from
// `./metrics/runs.js`. The eval barrel (`./eval/index.js`) keeps the
// natural `RunRecord` name; downstream eval branches typically
// import from there.
export type { RunRecord as EvalRunRecord } from './eval/run-record.js';
export type {
  RunFixtureInput,
  RunFixturesDeps,
  RunFixturesOptions,
} from './eval/runner.js';
export { defaultSystemPromptBuilder, runFixture, runFixtures } from './eval/runner.js';

// Eval harness metric collector. Consumes `EvalRunRecord[]` plus an
// optional parallel `SpecResult[]` and produces one `MetricsTable`
// per fixture. See `eval/metric-collector.ts` for the eight metrics.
export type {
  AggregateStat,
  AggregatedMetrics,
  CollectMetricsInput,
  MetricsTable,
  TrialMetrics,
} from './eval/metric-collector.js';
export {
  aggregateTrials,
  collectMetrics,
  extractTrialMetrics,
} from './eval/metric-collector.js';

export type {
  MetricsCollector,
  RecordTurnInput,
  SessionTotals,
} from './types/metrics.js';
export {
  computeTurnMetrics,
  createMetricsCollector,
  findPricing,
} from './metrics.js';

export type { Storage } from './types/storage.js';
export { noopStorage, createMemoryStorage } from './types/storage.js';
export { createLocalStorageAdapter } from './storage.js';

export type {
  ObserverEvent,
  SandboxObserver,
} from './types/observer.js';
export { combineObservers, noopObserver } from './types/observer.js';

export type {
  AgentDefinition,
  AgentTool,
  AgentContext,
  AgentToolResult,
} from './types/agent.js';

// Node-only modules — the stdio MCP server and the run-log writer
// import `node:fs` / `node:path` / `node:os` and can't ship to the
// browser. Consumers that need them (the CLI, the MCP entrypoint)
// import the files directly via their relative paths.

export type { ServeAgentsOptions, ServeAgentsHandle } from './mcp/serve.js';

export type {
  RunRecord,
  RunRecordFilter,
  RunLog,
  OpenRunLogOptions,
} from './metrics/runs.js';

export type {
  MutationEvent,
  MutationEventFilter,
  MutationPhase,
  MutationTarget,
  ReverseOp,
  TargetKind,
} from './types/events.js';
// Browser-safe events utilities — wrap, replay, codec. These live
// in files that don't import `node:fs` / `node:os`, so they're safe
// on the universal entry. Import them DIRECTLY (not via
// `./events/index.js`) because that barrel re-exports `./events/log.js`,
// which DOES pull in Node builtins.
//
// Node-only event log values (openEventLog, defaultProjectLogDir,
// HOST_AGENT_ID, etc.) live on `@inbrowser/agent/node` — see src/node.ts.
export { wrapMutating, isWrappedHandler, WRAPPED_MARKER } from './events/wrap.js';
export type { WrapMutatingOptions } from './events/wrap.js';
export { replayEvents, ReplayInvariantError } from './events/replay.js';
export type { ReplayOptions, ReplayProgress } from './events/replay.js';
export {
  defaultEventValueCodec,
  identityCodec,
  composeCodecs,
  walkValue,
  ENVELOPE_KEY,
} from './events/codec.js';
export type { EventValueCodec } from './events/codec.js';

// Type-only re-exports — `EventLog` + `AppendDraft` describe the
// log writer's contract (browser-safe, defined in `log-core.ts`).
// `EventLogIO` + `OpenEventLogOptions` describe the Node-side
// writer's options and live in `log.ts`; including them here is
// type-only so `node:fs` doesn't leak into the universal entry.
export type { EventLog, AppendDraft } from './events/log-core.js';
export type { EventLogIO, OpenEventLogOptions } from './events/log.js';
