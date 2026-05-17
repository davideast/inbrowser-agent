/**
 * `replayEvents()` — forward replay of a project's event log against a
 * caller-supplied `ToolDispatch`.
 *
 * Pair to `wrapMutating()` + `agent undo`:
 *   - `wrapMutating` writes structured events as a side effect of
 *     running tools.
 *   - `undoCommand` walks the log backwards (commit → rollback) to
 *     reverse a single mutation.
 *   - `replayEvents()` walks the log forwards (`commit` events in id
 *     order) and re-dispatches each tool with its recorded args, so
 *     the same mutations can be re-applied to a *different* dispatch
 *     (typical case: dev simulator → production registry).
 *
 * Idempotency:
 *   - Each successfully-applied event gets a `migrate_applied` marker
 *     event written back to the same log (or a separate target log
 *     when `targetLog` is provided). Re-running `replayEvents()` skips
 *     events whose marker is already present, so partial-failure +
 *     retry is safe.
 *   - The caller can additionally provide `shouldApply` to gate
 *     events. The callback fires for every event (it is NOT a
 *     conflict-only hook); the caller is responsible for whatever
 *     state-read or business logic decides apply / skip / abort.
 *
 * Boundaries:
 *   - This function calls `dispatch.execute()`. It is therefore
 *     *not* CLI-safe — it expects a real dispatch wired to real
 *     services. The `agent migrate` subcommand only PLANS replay; the
 *     host runs `replayEvents()` against its prod dispatch.
 *   - **The dispatch handlers MUST be unwrapped.** If you re-apply
 *     `wrapMutating()` at replay time, each replayed event spawns a
 *     fresh plan/commit pair on the target log — and a subsequent
 *     replay run would try to re-replay those. Wrap on the system
 *     that PRODUCES the log; do not wrap on the system that CONSUMES
 *     it via replay.
 */

import type { ToolContext, ToolDispatch, ToolResult } from '../types/tools.js';
import type { EventLog } from './log-core.js';
import type { MutationEvent } from '../types/events.js';

export interface ReplayOptions {
  /** Source log to read commits from. */
  log: EventLog;
  /** Dispatch to invoke each replayed tool against.
   *  **MUST register unwrapped handlers** — see file header. */
  dispatch: ToolDispatch;
  /** Factory producing a fresh `ToolContext` per dispatch call. */
  toolContext(): ToolContext;
  /** Replay only events with id >= this id (inclusive). Lexically
   *  compared — works because event ids are time-prefixed base36. */
  sinceEventId?: string;
  /** Restrict to these tool names. Unset → replay every commit. */
  toolAllowlist?: readonly string[];
  /** Skip events whose `target.path` matches any of these. */
  pathDenyList?: readonly string[];
  /**
   * Per-event resolver. Fires for every event *after* it passes the
   * tool / path / already-applied filters. Use it to read target
   * state and decide apply / skip / abort — replayEvents itself does
   * not read target state. Default: 'apply' for all events.
   *
   * Renamed from the previous `onConflict` to better reflect what it
   * actually does (it is not a conflict-only hook).
   */
  shouldApply?: (event: MutationEvent) => 'apply' | 'skip' | 'abort';
  /** When true: emit `plan` progress events but do NOT call dispatch.
   *  No `migrate_applied` markers are written. */
  dryRun?: boolean;
  /** Optional separate log to write the `migrate_applied` markers
   *  into. Defaults to the source log. Useful when the prod
   *  environment maintains its own event log. */
  targetLog?: EventLog;
  /** Agent identifier stamped on the `migrate_applied` markers.
   *  Defaults to 'replay'. */
  agent?: string;
  /** Session id stamped on markers. Defaults to a synthesized id. */
  sessionId?: string;
}

export type ReplayProgress =
  | { type: 'plan'; event: MutationEvent }
  | { type: 'applied'; event: MutationEvent; markerId: string; result: ToolResult }
  | { type: 'skipped'; event: MutationEvent; reason: 'already_applied' | 'tool_denied' | 'path_denied' | 'shouldapply_skip' }
  | { type: 'error'; event: MutationEvent; message: string }
  | { type: 'done'; total: number; applied: number; skipped: number; errors: number };

const APPLIED_MARKER_TYPE = 'migrate_applied';

export class ReplayInvariantError extends Error {
  override readonly name = 'ReplayInvariantError';
}

export async function* replayEvents(opts: ReplayOptions): AsyncIterable<ReplayProgress> {
  const targetLog = opts.targetLog ?? opts.log;
  const agent = opts.agent ?? 'replay';
  const sessionId = opts.sessionId ?? `replay-${Date.now().toString(36)}`;
  const toolAllow = opts.toolAllowlist ? new Set(opts.toolAllowlist) : null;
  const pathDeny = opts.pathDenyList ? new Set(opts.pathDenyList) : null;
  const applied = opts.dryRun ? new Set<string>() : targetLog.appliedEventIds();

  const all = opts.log
    .read({ phase: 'commit' })
    // Markers written by a prior `replayEvents()` run are themselves
    // commit-phase events — exclude them so re-runs don't try to
    // replay bookkeeping rows.
    .filter((e) => (e.metadata as { type?: string } | undefined)?.type !== APPLIED_MARKER_TYPE);
  // Stable in-emission-order (event ids are lexically sortable by ts prefix).
  all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let total = 0;
  let appliedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const event of all) {
    if (opts.sinceEventId && event.id < opts.sinceEventId) continue;
    total += 1;

    if (toolAllow && !toolAllow.has(event.tool)) {
      yield { type: 'skipped', event, reason: 'tool_denied' };
      skippedCount += 1;
      continue;
    }
    if (pathDeny && pathDeny.has(event.target.path)) {
      yield { type: 'skipped', event, reason: 'path_denied' };
      skippedCount += 1;
      continue;
    }
    if (event.args === undefined) {
      // Every commit event written by wrapMutating carries args. An
      // event without args is either a bookkeeping marker (caught
      // above) or a manually-appended commit that didn't follow the
      // protocol — fail loudly rather than silently skipping.
      throw new ReplayInvariantError(
        `event ${event.id} has phase=commit and target.kind=${event.target.kind} but no args. ` +
        `Commit events emitted by wrapMutating always carry args. ` +
        `If you're appending commits manually, include args. ` +
        `Reading log: ${opts.log.path}`,
      );
    }
    if (!opts.dryRun && applied.has(event.id)) {
      yield { type: 'skipped', event, reason: 'already_applied' };
      skippedCount += 1;
      continue;
    }

    if (opts.dryRun) {
      yield { type: 'plan', event };
      continue;
    }

    const decision = opts.shouldApply ? opts.shouldApply(event) : 'apply';
    if (decision === 'abort') {
      yield { type: 'error', event, message: 'shouldApply returned abort' };
      errorCount += 1;
      return;
    }
    if (decision === 'skip') {
      yield { type: 'skipped', event, reason: 'shouldapply_skip' };
      skippedCount += 1;
      continue;
    }

    try {
      const result = await opts.dispatch.execute(
        { id: `replay-${event.id}`, name: event.tool, args: event.args },
        opts.toolContext(),
      );
      if (!result.ok) {
        yield { type: 'error', event, message: result.summary };
        errorCount += 1;
        continue;
      }
      const marker = targetLog.append({
        agent,
        sessionId,
        tool: event.tool,
        phase: 'commit',
        target: { kind: 'other', path: `replay/${event.id}` },
        reversible: false,
        irreversibleReason: 'migrate_applied markers are bookkeeping, not state changes',
        metadata: {
          type: APPLIED_MARKER_TYPE,
          appliedEventId: event.id,
          originalTool: event.tool,
          originalTarget: event.target,
        },
      });
      yield { type: 'applied', event, markerId: marker.id, result };
      appliedCount += 1;
    } catch (err) {
      yield { type: 'error', event, message: err instanceof Error ? err.message : String(err) };
      errorCount += 1;
    }
  }

  yield { type: 'done', total, applied: appliedCount, skipped: skippedCount, errors: errorCount };
}
