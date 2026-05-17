/**
 * `agent undo` — reverse a previously-committed mutation.
 *
 * Lookup flow:
 *   1. Open the project's event log.
 *   2. Find the `commit`-phase event with id === --event.
 *   3. Refuse if `reversible: false` or `reverseOp` is missing.
 *   4. Refuse if a `rollback`-phase event already references this id
 *      (already undone — idempotent).
 *   5. Otherwise emit either:
 *      - A `undo_plan` event (when --dry-run is set), or
 *      - An `undo_invocation` plan describing the recorded reverseOp.
 *
 * **This subcommand does NOT actually invoke the reverseOp tool.**
 * That requires a `ToolRegistry` + `ToolContext` (LLM provider,
 * sandbox, etc.) which the headless CLI doesn't have — those live in
 * the host (the playground, or a specialized-agent process). The CLI
 * surfaces the plan + appends a `rollback` event to the log; the host
 * dispatches the actual reverse op when it re-reads the log.
 *
 * This split matches the rest of the CLI: it's a controller surface,
 * not a Firebase admin tool. Hosting the dispatch in-CLI would force
 * us to import @pyric/sandbox + @pyric/admin runtime deps just to
 * run an undo, which doesn't fit the "small, scriptable, headless"
 * design point.
 */

import { buildRollbackEvent } from '../../events/log-core.js';
import { openEventLog } from '../../events/log.js';
import type { MutationEvent } from '../../types/events.js';
import type { Emitter } from '../output.js';
import type { ParsedArgs } from '../parse.js';

export interface UndoCommandIO {
  emit: Emitter;
  openLog?: typeof openEventLog;
  now?: () => string;
}

export function undoCommand(args: ParsedArgs, io: UndoCommandIO): number {
  const projectId = args.options['project'] as string | undefined;
  const eventId = args.options['event'] as string | undefined;
  if (!projectId) throw new Error('agent undo: --project is required');
  if (!eventId) throw new Error('agent undo: --event is required');

  const eventsDir = args.options['events-dir'] as string | undefined;
  const dryRun = Boolean(args.options['dry-run']);
  const openLog = io.openLog ?? openEventLog;
  const now = io.now ?? (() => new Date().toISOString());

  const log = openLog({
    projectId,
    ...(eventsDir ? { logDir: eventsDir } : {}),
  });

  try {
    const all = log.read();
    const target = all.find((e) => e.id === eventId);
    if (!target) {
      io.emit.event(
        {
          type: 'error',
          name: 'NotFound',
          message: `event ${eventId} not found in project ${projectId}`,
        },
        () => `error: event ${eventId} not found`,
      );
      io.emit.finish();
      return 64;
    }
    if (target.phase !== 'commit') {
      io.emit.event(
        {
          type: 'error',
          name: 'NotCommit',
          message: `event ${eventId} is phase=${target.phase}; only commit events can be undone`,
        },
        () => `error: event ${eventId} is phase=${target.phase}; not a commit`,
      );
      io.emit.finish();
      return 64;
    }
    if (!target.reversible || !target.reverseOp) {
      io.emit.event(
        {
          type: 'error',
          name: 'Irreversible',
          message: `event ${eventId} is marked reversible:false`,
          reason: target.irreversibleReason ?? '(no reason recorded)',
        },
        () =>
          `error: event ${eventId} is irreversible (${target.irreversibleReason ?? 'no reason recorded'})`,
      );
      io.emit.finish();
      return 64;
    }
    const alreadyUndone = all.find(
      (e) =>
        e.phase === 'rollback' &&
        typeof e.metadata?.['originalEventId'] === 'string' &&
        e.metadata['originalEventId'] === eventId,
    );
    if (alreadyUndone) {
      io.emit.event(
        {
          type: 'error',
          name: 'AlreadyUndone',
          message: `event ${eventId} was already undone by ${alreadyUndone.id}`,
        },
        () => `error: event ${eventId} was already undone by ${alreadyUndone.id}`,
      );
      io.emit.finish();
      return 64;
    }

    const plan = buildUndoPlan(target, now);

    if (dryRun) {
      io.emit.event(
        { type: 'undo_plan', ...plan },
        () =>
          `[plan] undo · event=${eventId} · tool=${target.tool} → reverse with ${target.reverseOp?.tool}\n` +
          `  target: ${target.target.kind}:${target.target.path}\n` +
          `  args:   ${JSON.stringify(target.reverseOp?.args)}`,
      );
      io.emit.finish();
      return 0;
    }

    // Append a rollback event so the host (or the auditor) can see
    // that the undo was *requested*. The host is responsible for
    // actually invoking the reverseOp.tool against its dispatch.
    const rollback = log.append(
      buildRollbackEvent({
        original: target,
        reason: 'undo',
        reverseOp: target.reverseOp,
        agent: target.agent,
        sessionId: target.sessionId,
      }),
    );

    io.emit.event(
      {
        type: 'undo_recorded',
        rollbackEventId: rollback.id,
        ...plan,
        nextStep:
          `Invoke ${target.reverseOp.tool} via your host's ToolDispatch with the recorded args. ` +
          `The CLI cannot invoke tools directly — see undo.ts header for rationale.`,
      },
      () =>
        `[recorded] rollback ${rollback.id} for event ${eventId}\n` +
        `  reverseOp: ${target.reverseOp?.tool}(${JSON.stringify(target.reverseOp?.args)})\n` +
        `  next: invoke that tool via your host's ToolDispatch.`,
    );
    io.emit.finish();
    return 0;
  } finally {
    log.close();
  }
}

function buildUndoPlan(target: MutationEvent, now: () => string): Record<string, unknown> {
  return {
    ts: now(),
    eventId: target.id,
    originalTool: target.tool,
    originalAgent: target.agent,
    originalSessionId: target.sessionId,
    target: target.target,
    reverseOp: target.reverseOp,
  };
}
