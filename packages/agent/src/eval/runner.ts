/**
 * `runFixture` + `runFixtures` — the eval harness's session driver.
 *
 * Given a `TaskFixture`, an `LlmClient`, and a tool surface, the
 * runner:
 *
 *   1. Builds the seeded `Workspace` from `EMPTY_WORKSPACE +
 *      fixture.initialState`.
 *   2. Threads that workspace through the system prompt builder and
 *      the per-call `ToolContext` so the agent sees the seeded
 *      state.
 *   3. Plugs a buffering `Tracer` into the session so every
 *      `TraceEvent` (request, response, dispatch-complete) lands in
 *      the captured record.
 *   4. Submits the fixture's prompt and drains the session event
 *      stream, shadow-tracking workspace + runtime patches as they
 *      flow back through `tool_finished` events.
 *   5. Returns a `RunRecord` with the trace, the final workspace +
 *      runtime, the concatenated assistant text, timing, and a
 *      `error` slot that is `null` on a clean finish or a string on
 *      any non-success outcome.
 *
 * Errors never throw out of `runFixture`. An aborted run, a
 * wall-clock cap exceeded, a session-emitted `error` event, or an
 * unexpected exception all resolve to a `RunRecord` with `error` set
 * and a partial trace.
 *
 * The runner is browser-safe — no `node:*` imports. Persistence
 * helpers (if anyone wants them) belong in
 * `runner-persistence-node.ts` and route through `src/node.ts`. That
 * file does not exist in v1 by design; downstream consumers can
 * persist in-memory records however they like.
 */

import { createMetricsCollector } from '../metrics.js';
import { createAgentSession } from '../session.js';
import { createReactLoopStrategy } from '../strategy.js';
import type { LlmClient } from '../types/llm.js';
import type { RuntimeState } from '../types/runtime.js';
import { EMPTY_RUNTIME } from '../types/runtime.js';
import type { SessionEvent } from '../types/session.js';
import type { AgentStrategy } from '../types/strategy.js';
import type { ToolContext, ToolDispatch, ToolHandler, ToolResult } from '../types/tools.js';
import type { TraceEvent, Tracer } from '../types/trace.js';
import { EMPTY_WORKSPACE, type Workspace } from '../types/workspace.js';
import { type TaskFixture, applyWorkspaceOverrides } from './fixture.js';
import type { RunRecord } from './run-record.js';

/**
 * Input contract for `runFixture`. The caller supplies the fixture,
 * the LLM client, and the tool surface; the runner owns everything
 * else.
 */
export interface RunFixtureInput {
  fixture: TaskFixture;
  /** The chat client the strategy will drive. Tests pass a canned
   *  stub; production code wires the real provider adapter. */
  llm: LlmClient;
  /** Tool dispatcher the session uses to execute tool calls. Tests
   *  can pass `createDispatch(createToolRegistry())` for the no-tool
   *  path. */
  tools: ToolDispatch;
  /** Tool handlers the LLM should see this run. Empty when the
   *  fixture is exercised against a no-tool baseline. */
  toolList: ToolHandler[];
  /** Optional strategy override. Defaults to a fresh
   *  `createReactLoopStrategy()`. */
  strategy?: AgentStrategy;
  /** Zero-indexed trial number. Defaults to 0. The batch driver
   *  passes the trial it is currently on. */
  trial?: number;
  /** Optional external abort signal. Wired into the session's
   *  `submit()` call. */
  signal?: AbortSignal;
  /** Optional wall-clock cap in ms. When the run exceeds this, the
   *  runner aborts the session and resolves with `error` set. Absent
   *  means no cap. */
  maxWallClockMs?: number;
  /** Optional seed echoed back through the `RunRecord` for
   *  traceability. Not consumed by the runner; strategies + LLM
   *  clients decide whether to honor it. */
  seed?: number;
  /** Optional system-prompt builder. Defaults to the canonical
   *  fixture-aware prompt — see `defaultSystemPromptBuilder` for the
   *  shape. */
  systemPromptBuilder?: (workspace: Workspace, runtime: RuntimeState) => string;
}

/**
 * Drive a single `TaskFixture` end-to-end and resolve with a
 * `RunRecord` describing the captured run. Never throws.
 */
export async function runFixture(input: RunFixtureInput): Promise<RunRecord> {
  const trial = input.trial ?? 0;
  const trace: TraceEvent[] = [];
  const tracer: Tracer = {
    emit(event) {
      trace.push(event);
    },
  };

  // Seed workspace + runtime from the fixture. The session does not
  // accept a seeded workspace at construction time, so we shadow it:
  // the seeded value is the one the agent sees (via systemPrompt +
  // toolContext), and `tool_finished` events carry the patches we
  // need to overlay back onto the shadow.
  let shadowWorkspace: Workspace = applyWorkspaceOverrides(
    EMPTY_WORKSPACE,
    input.fixture.initialState,
  );
  let shadowRuntime: RuntimeState = EMPTY_RUNTIME;

  // Compose the external signal with our own controller so we can
  // abort cleanly on the wall-clock cap.
  const internalAbort = new AbortController();
  const linkedSignal = linkSignals(input.signal, internalAbort.signal);

  // Wall-clock cap. `unref()` would be nicer but is Node-only; we
  // just clear the timer on a clean finish.
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  let wallClockExceeded = false;
  if (typeof input.maxWallClockMs === 'number' && input.maxWallClockMs > 0) {
    wallClockTimer = setTimeout(() => {
      wallClockExceeded = true;
      internalAbort.abort();
    }, input.maxWallClockMs);
  }

  const startedAt = Date.now();
  let assistantText = '';
  let error: string | null = null;

  const strategy = input.strategy ?? createReactLoopStrategy();
  const promptBuilder = input.systemPromptBuilder ?? defaultSystemPromptBuilder;

  // toolContext factory threads the live shadow workspace + runtime
  // into every per-call context, so tools that depend on the
  // workspace see the seeded state rather than the session's empty
  // baseline.
  const toolContext = (): ToolContext => ({
    workspace: shadowWorkspace,
    runtime: shadowRuntime,
    signal: linkedSignal,
  });

  let session: ReturnType<typeof createAgentSession>;
  try {
    session = createAgentSession({
      strategy,
      llm: input.llm,
      tools: input.tools,
      toolList: input.toolList,
      toolContext,
      // The system prompt is built from the SEEDED workspace, not the
      // session's empty baseline. The session calls this once per
      // submit with its own (empty) workspace; we ignore that and
      // pass our shadow instead.
      systemPromptBuilder: (_ws, _rt) => promptBuilder(shadowWorkspace, shadowRuntime),
      metrics: createMetricsCollector(),
      history: [],
      tracer,
    });
  } catch (e) {
    if (wallClockTimer) clearTimeout(wallClockTimer);
    return {
      fixture: input.fixture,
      trial,
      trace,
      finalWorkspace: shadowWorkspace,
      finalRuntime: shadowRuntime,
      assistantText: '',
      startedAt,
      completedAt: Date.now(),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      error: errorMessage(e),
    };
  }

  try {
    const events: AsyncIterable<SessionEvent> = session.submit(input.fixture.prompt, linkedSignal);
    for await (const ev of events) {
      if (ev.kind === 'text') {
        assistantText += ev.chunk;
      } else if (ev.kind === 'tool_finished') {
        const result = ev.result as ToolResult;
        if (result.workspacePatch) {
          shadowWorkspace = mergeWorkspace(shadowWorkspace, result.workspacePatch);
        }
        if (result.runtimePatch) {
          shadowRuntime = mergeRuntime(shadowRuntime, result.runtimePatch);
        }
      } else if (ev.kind === 'error') {
        // The session emitted an error event mid-stream; the stream
        // closes after this. Record it as the run's error.
        if (error === null) error = ev.message;
      }
    }
  } catch (e) {
    error = errorMessage(e);
  } finally {
    if (wallClockTimer) clearTimeout(wallClockTimer);
  }

  // Wall-clock cap takes precedence over a generic 'aborted' message
  // so the caller can tell why the run ended.
  if (wallClockExceeded && (error === null || /abort/i.test(error))) {
    error = `runFixture: exceeded maxWallClockMs (${input.maxWallClockMs}ms)`;
  } else if (
    error === null &&
    (linkedSignal.aborted || input.signal?.aborted === true) &&
    !sawCompletion(trace)
  ) {
    // External abort with no session-emitted error and no terminal
    // turn — record an aborted message so consumers do not have to
    // probe the signal themselves.
    error = 'runFixture: aborted';
  }

  return {
    fixture: input.fixture,
    trial,
    trace,
    finalWorkspace: shadowWorkspace,
    finalRuntime: shadowRuntime,
    assistantText,
    startedAt,
    completedAt: Date.now(),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    error,
  };
}

/**
 * Options for `runFixtures`. Sequential by default; `parallelism` is
 * accepted for forward-compatibility but v1 honors only `1`. Records
 * are returned in input order regardless.
 */
export interface RunFixturesOptions {
  /** Number of trials per fixture. Defaults to 1. */
  trials?: number;
  /** Forward-compatibility hint. v1 always runs sequentially. A
   *  future implementation may honor values > 1; downstream branches
   *  should pass `1` (or omit) until then. */
  parallelism?: number;
  /** Optional external abort signal. Forwarded to every `runFixture`
   *  call; an abort short-circuits the remaining trials. */
  signal?: AbortSignal;
  /** Optional wall-clock cap per trial. Forwarded as-is. */
  maxWallClockMs?: number;
  /** Optional seed factory. Called once per (fixture, trial). The
   *  return value is echoed onto the produced `RunRecord.seed`. */
  seed?: (fixture: TaskFixture, trial: number) => number;
}

/**
 * Static dependencies that every fixture in the batch shares — the
 * LLM client, the tool dispatch, the tool list, and (optionally) a
 * strategy factory. Kept separate from `RunFixturesOptions` so the
 * caller can vary trial-count knobs without re-supplying the heavy
 * dependencies.
 */
export interface RunFixturesDeps {
  llm: LlmClient;
  tools: ToolDispatch;
  toolList: ToolHandler[];
  /** Optional strategy factory — called once per trial so each trial
   *  gets a fresh strategy. Defaults to `createReactLoopStrategy()`. */
  strategy?: () => AgentStrategy;
  /** Optional system-prompt builder forwarded to every trial. */
  systemPromptBuilder?: (workspace: Workspace, runtime: RuntimeState) => string;
}

/**
 * Drive every fixture in `fixtures` for `trials` trials each.
 * Returns records in `(fixture, trial)` order — the i-th fixture's
 * trials come before the (i+1)-th fixture's trials, and within each
 * fixture trial 0 comes before trial 1, etc.
 *
 * Sequential by design; see `RunFixturesOptions.parallelism`. The
 * eval harness's job is reproducible measurement, not throughput.
 */
export async function runFixtures(
  fixtures: readonly TaskFixture[],
  deps: RunFixturesDeps,
  options: RunFixturesOptions = {},
): Promise<RunRecord[]> {
  const trials = options.trials ?? 1;
  const out: RunRecord[] = [];
  for (const fixture of fixtures) {
    for (let trial = 0; trial < trials; trial++) {
      if (options.signal?.aborted) {
        // Synthesize a placeholder record so callers can see which
        // trial was skipped. Trace + state are empty; error
        // carries the abort.
        out.push({
          fixture,
          trial,
          trace: [],
          finalWorkspace: applyWorkspaceOverrides(EMPTY_WORKSPACE, fixture.initialState),
          finalRuntime: EMPTY_RUNTIME,
          assistantText: '',
          startedAt: Date.now(),
          completedAt: Date.now(),
          error: 'runFixtures: aborted before trial start',
        });
        continue;
      }
      const seed = options.seed ? options.seed(fixture, trial) : undefined;
      const strategy = deps.strategy ? deps.strategy() : undefined;
      const record = await runFixture({
        fixture,
        llm: deps.llm,
        tools: deps.tools,
        toolList: deps.toolList,
        ...(strategy ? { strategy } : {}),
        trial,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.maxWallClockMs !== undefined ? { maxWallClockMs: options.maxWallClockMs } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(deps.systemPromptBuilder ? { systemPromptBuilder: deps.systemPromptBuilder } : {}),
      });
      out.push(record);
    }
  }
  return out;
}

/**
 * Default system prompt builder used when the caller does not supply
 * one. Intentionally minimal — production callers should pass their
 * own. The eval harness uses this only so a test can run end-to-end
 * without wiring a real prompt.
 */
export function defaultSystemPromptBuilder(workspace: Workspace, runtime: RuntimeState): string {
  const parts: string[] = ['You are an evaluation harness agent.'];
  if (workspace.rules) parts.push(`Rules:\n${workspace.rules}`);
  if (workspace.code) parts.push(`Code:\n${workspace.code}`);
  if (workspace.appSource) parts.push(`App:\n${workspace.appSource}`);
  if (runtime.runSummary) parts.push(`Last run: ${JSON.stringify(runtime.runSummary)}`);
  return parts.join('\n\n');
}

function mergeWorkspace(base: Workspace, patch: Partial<Workspace>): Workspace {
  // Mirror session.ts freezing semantics so consumers see a frozen
  // shadow workspace too. The cost is one shallow clone per patch,
  // which is negligible in eval scenarios.
  return Object.freeze({
    ...base,
    ...patch,
    stitch: Object.freeze({
      ...base.stitch,
      ...(patch.stitch ?? {}),
    }),
  }) as Workspace;
}

function mergeRuntime(base: RuntimeState, patch: Partial<RuntimeState>): RuntimeState {
  return Object.freeze({
    ...base,
    ...patch,
    terminal: Object.freeze([
      ...(patch.terminal ?? base.terminal),
    ]) as unknown as RuntimeState['terminal'],
    uiErrors: Object.freeze([
      ...(patch.uiErrors ?? base.uiErrors),
    ]) as unknown as RuntimeState['uiErrors'],
  }) as RuntimeState;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Combine two abort signals (one optional) into a single signal. */
function linkSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (!external) return internal;
  if (external.aborted) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  const controller = new AbortController();
  if (internal.aborted) {
    controller.abort();
    return controller.signal;
  }
  external.addEventListener('abort', () => controller.abort(), { once: true });
  internal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller.signal;
}

function sawCompletion(trace: TraceEvent[]): boolean {
  // A clean finish emits at least one llm_response. If we have any
  // response trace, treat the run as having reached the strategy
  // proper rather than being aborted before it started.
  for (const ev of trace) {
    if (ev.kind === 'llm_response') return true;
  }
  return false;
}
