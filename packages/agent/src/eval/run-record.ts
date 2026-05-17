/**
 * `RunRecord` — the eval harness's per-trial capture envelope.
 *
 * One `RunRecord` is produced for each `runFixture` call. It is the
 * stable contract every downstream phase-one branch consumes:
 *
 *   - `eval/metric-collector` derives the eight metrics from a record.
 *   - `eval/comparison-report` aggregates records across trials and
 *     compares two sets.
 *   - `eval/success-spec-framework` uses `finalWorkspace`, `trace`,
 *     and `assistantText` as inputs to its spec functions.
 *
 * The shape is intentionally narrow and frozen-in-place: everything
 * the metric collector needs already lives elsewhere (the trace
 * carries usage, tool calls, and turn boundaries; the final
 * workspace + runtime describe the agent-visible end state). The
 * runner does not aggregate, does not derive metrics, and does not
 * decide pass/fail. Those are downstream concerns by design.
 *
 * Browser-safe — no Node imports. The runner that produces these is
 * also browser-safe in v1; a future on-disk persistence helper would
 * live behind `@inbrowser/agent/node`.
 *
 * Note on naming: `@inbrowser/agent` also exports an unrelated
 * `RunRecord` from `metrics/runs.ts` (a per-MCP-tool-call NDJSON
 * record). To avoid breaking that public surface, the eval-side type
 * is re-exported from the package root as `EvalRunRecord`. Within the
 * eval barrel and inside this branch, the natural `RunRecord` name is
 * used.
 */

import type { RuntimeState } from '../types/runtime.js';
import type { TraceEvent } from '../types/trace.js';
import type { Workspace } from '../types/workspace.js';
import type { TaskFixture } from './fixture.js';

export interface RunRecord {
  /** The input fixture, echoed verbatim so a record is
   *  self-describing and a downstream reader does not have to
   *  cross-reference an external fixture id to know what was run. */
  fixture: TaskFixture;
  /** Zero-indexed trial number for this fixture. When a batch driver
   *  runs N trials per fixture, the i-th trial carries `trial: i`. */
  trial: number;
  /** Every trace event emitted by the strategy during this run, in
   *  emission order. Includes `llm_request`, `llm_response`, and
   *  `turn_dispatch_complete` events. Empty when no events were
   *  emitted before an early abort. */
  trace: TraceEvent[];
  /** The `Workspace` value at the end of the run. Equal to the
   *  fixture-seeded workspace when no tool produced a workspace
   *  patch. Frozen by the session, so safe to share by reference. */
  finalWorkspace: Workspace;
  /** The `RuntimeState` at the end of the run. Same freezing
   *  guarantees as `finalWorkspace`. */
  finalRuntime: RuntimeState;
  /** Concatenated assistant text across every turn in this run. A
   *  convenience for spec evaluators that match against assistant
   *  output — they do not have to re-walk the trace. */
  assistantText: string;
  /** Wall-clock ms at run start. Captured by the runner immediately
   *  before it submits the prompt. */
  startedAt: number;
  /** Wall-clock ms at run completion (or termination). Captured by
   *  the runner immediately after the session event stream drains or
   *  the run is aborted. */
  completedAt: number;
  /** Optional seed echoed from `runFixture`'s input. Threaded for
   *  traceability only — v1 does not enforce determinism on
   *  strategies or LLM clients. */
  seed?: number;
  /** `null` on a clean finish. A string when the run terminated for
   *  any non-success reason: external abort, max wall-clock
   *  exceeded, an unexpected exception thrown by the session, or a
   *  session-emitted `error` event. */
  error: string | null;
}
