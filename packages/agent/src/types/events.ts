/**
 * `MutationEvent` — the canonical record a mutating tool emits to the
 * project event log. Three phases:
 *
 *   - `plan` — emitted before the tool actually runs. Records intent +
 *     captured "before" snapshot. Always present.
 *   - `commit` — emitted after the tool returns successfully. Records
 *     "after" snapshot + the `reverseOp` (when one exists) so `agent
 *     undo` can roll it back.
 *   - `rollback` — emitted when execution failed mid-flight, or when
 *     `agent undo` reverses a previously-committed event. Helps the
 *     auditor distinguish "started but never finished" from "finished
 *     and later undone."
 *
 * The log is **append-only NDJSON** at
 * `~/.pyric/projects/<projectId>/events.ndjson`. The whole point is
 * that the file is replayable + diffable — never overwrite, never
 * mutate previous lines.
 *
 * See `plans/specialized-firebase-agents.md` §7 for the design rationale.
 */

export type MutationPhase = 'plan' | 'commit' | 'rollback';

export type TargetKind =
  | 'doc' // a single document path
  | 'collection' // a collection (or subcollection) path
  | 'rules' // ruleset release
  | 'index' // composite/single-field index
  | 'service' // a GCP service (firebasestorage, firestore, …)
  | 'bucket' // a Storage bucket
  | 'hosting' // a Hosting release
  | 'functions' // a Functions deploy
  | 'workspace' // the in-process workspace (rules/code/app)
  | 'other';

export interface MutationTarget {
  kind: TargetKind;
  /**
   * Stable, fully-qualified identifier for the target. Examples:
   *   - `users/alice`
   *   - `projects/my-app/rulesets/active`
   *   - `firebasestorage.googleapis.com`
   *   - `my-app.firebasestorage.app`
   *   - `workspace.rules`
   */
  path: string;
  /** Optional friendly label. */
  label?: string;
}

export interface ReverseOp {
  /** Tool name to invoke to reverse the committed mutation. */
  tool: string;
  /** Arguments to pass. The tool MUST be registered in the same
   *  ToolRegistry the caller used; otherwise undo cannot resolve it. */
  args: unknown;
  /** Free-form human-readable description of the reverse action. */
  description?: string;
}

export interface MutationEvent {
  /** Sortable, opaque event id (timestamp-prefixed). */
  id: string;
  /** ISO-8601 timestamp the event was emitted at. */
  ts: string;
  /** Agent that emitted it. `'host'` for direct CLI / library use. */
  agent: string;
  /** Session id from `AgentSession`. */
  sessionId: string;
  /** Tool that did (or planned) the mutation. */
  tool: string;
  /** Args the tool was invoked with. Stored verbatim so the event can
   *  be **replayed** against a different `ToolDispatch` (e.g. a
   *  production registry pointed at live Firestore). Optional for
   *  back-compat with legacy event files written before this field
   *  existed; legacy events can't be replayed without it. */
  args?: unknown;
  /** Lifecycle phase. */
  phase: MutationPhase;
  /** What was (or would be) mutated. */
  target: MutationTarget;
  /** Captured pre-image. Absent when the API doesn't expose one or the
   *  caller opted out. */
  before?: unknown;
  /** Captured post-image. Always present for `commit` phase. */
  after?: unknown;
  /** Whether the API supports reversing this mutation. Hard-false for
   *  irreversible ops (service enablement, hosting release rollbacks
   *  past retention window, etc) — `agent undo` refuses with the
   *  message in `irreversibleReason`. */
  reversible: boolean;
  /** When `reversible: false`, why. Surfaced to the user. */
  irreversibleReason?: string;
  /** When `reversible: true`, the tool+args to invoke to roll back.
   *  Absent during `plan` phase (intent, not commitment); always
   *  present on `commit` phase for reversible events. */
  reverseOp?: ReverseOp;
  /** Free-form metadata the host can stash on the event. The event log
   *  treats this as opaque — readers can use it to correlate with their
   *  own systems (Linear ticket id, deploy build number, etc). */
  metadata?: Record<string, unknown>;
}

export interface MutationEventFilter {
  /** Restrict to a single session. */
  sessionId?: string;
  /** Restrict to a single tool name. */
  tool?: string;
  /** Restrict to a single agent. */
  agent?: string;
  /** ISO-8601 lower bound (inclusive). */
  since?: string;
  /** ISO-8601 upper bound (exclusive). */
  until?: string;
  /** Restrict to a single phase. */
  phase?: MutationPhase;
  /** Restrict to a single target kind. */
  targetKind?: TargetKind;
  /** Restrict by event id (for undo). */
  id?: string;
}

/**
 * Identifier used in event records when the host didn't name an agent.
 * Lives in the types module (zero side effects) so it's safe on the
 * universal `@inbrowser/agent` entry — the value lives in `events/log.ts`
 * too, but that file imports `node:fs` / `node:os` and can't ship to
 * the browser.
 */
export const HOST_AGENT_ID = 'host';
