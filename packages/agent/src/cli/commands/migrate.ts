/**
 * `agent migrate` — plan + record the forward replay of a project's
 * mutation event log against a (host-supplied) production dispatch.
 *
 * Mirrors the controller/runtime split established by `agent undo`:
 *   - The CLI plans the replay (lists every commit event that would
 *     fire) and optionally records a `migrate_intent` marker. It does
 *     NOT dispatch tools — that requires a real dispatch wired to
 *     services (e.g. live Firestore).
 *   - The host (a script, a deploy agent, an automation pipeline)
 *     reads the intent and calls `replayEvents()` from the library
 *     surface against its production registry. The library function
 *     writes `migrate_applied` markers as it goes.
 *
 * Output: NDJSON, one `migrate_plan` event per commit + a final
 * `migrate_intent_recorded` line when `--record` is set.
 */

import { openEventLog } from '../../events/log.js';
import type { Emitter } from '../output.js';
import type { ParsedArgs } from '../parse.js';

export interface MigrateCommandIO {
  emit: Emitter;
  openLog?: typeof openEventLog;
  now?: () => string;
}

export function migrateCommand(args: ParsedArgs, io: MigrateCommandIO): number {
  const projectId = args.options['project'] as string | undefined;
  if (!projectId) throw new Error('agent migrate: --project is required');

  const eventsDir = args.options['events-dir'] as string | undefined;
  const since = args.options['since-event'] as string | undefined;
  const toolsCsv = args.options['tools'] as string[] | string | undefined;
  const recordIntent = Boolean(args.options['record']);
  const openLog = io.openLog ?? openEventLog;
  const now = io.now ?? (() => new Date().toISOString());

  const toolAllow: Set<string> | null = (() => {
    if (Array.isArray(toolsCsv)) return new Set(toolsCsv);
    if (typeof toolsCsv === 'string') return new Set(toolsCsv.split(',').map((s) => s.trim()).filter(Boolean));
    return null;
  })();

  const log = openLog({
    projectId,
    ...(eventsDir ? { logDir: eventsDir } : {}),
  });

  try {
    const candidates = log
      .read({ phase: 'commit' })
      // Don't replay our own bookkeeping markers from prior runs.
      .filter(
        (e) =>
          (e.metadata as { type?: string } | undefined)?.type !== 'migrate_applied' &&
          (e.metadata as { type?: string } | undefined)?.type !== 'migrate_intent',
      )
      .filter((e) => (since ? e.id >= since : true))
      .filter((e) => (toolAllow ? toolAllow.has(e.tool) : true));

    const eligibleWithArgs = candidates.filter((e) => e.args !== undefined);
    const skippedLegacy = candidates.length - eligibleWithArgs.length;

    for (const event of eligibleWithArgs) {
      io.emit.event(
        {
          type: 'migrate_plan',
          ts: now(),
          eventId: event.id,
          tool: event.tool,
          target: event.target,
          args: event.args,
        },
        () =>
          `[plan] ${event.id} → ${event.tool}(${JSON.stringify(event.args)}) on ${event.target.kind}:${event.target.path}`,
      );
    }

    if (recordIntent) {
      const intent = log.append({
        agent: 'host',
        sessionId: `migrate-${Date.now().toString(36)}`,
        tool: 'migrate',
        phase: 'commit',
        target: { kind: 'other', path: `migrate/intent` },
        reversible: false,
        irreversibleReason: 'migrate_intent markers are bookkeeping, not state changes',
        metadata: {
          type: 'migrate_intent',
          ...(since ? { sinceEventId: since } : {}),
          ...(toolAllow ? { toolAllowlist: Array.from(toolAllow) } : {}),
          plannedEventIds: eligibleWithArgs.map((e) => e.id),
        },
      });
      io.emit.event(
        {
          type: 'migrate_intent_recorded',
          ts: now(),
          intentEventId: intent.id,
          plannedCount: eligibleWithArgs.length,
          skippedLegacy,
          nextStep:
            `Invoke replayEvents() from @inbrowser/agent against your production ToolDispatch. ` +
            `Pass { log, dispatch, toolContext } plus the same filters (sinceEventId, toolAllowlist) recorded on this intent.`,
        },
        () =>
          `[recorded] migrate intent ${intent.id}\n` +
          `  planned: ${eligibleWithArgs.length} events\n` +
          (skippedLegacy > 0 ? `  skipped (legacy / no args): ${skippedLegacy}\n` : '') +
          `  next: invoke replayEvents() against your production ToolDispatch.`,
      );
    } else {
      io.emit.event(
        {
          type: 'migrate_summary',
          ts: now(),
          plannedCount: eligibleWithArgs.length,
          skippedLegacy,
        },
        () =>
          `[summary] ${eligibleWithArgs.length} replayable events` +
          (skippedLegacy > 0 ? ` · ${skippedLegacy} legacy (no args)` : '') +
          `\n  add --record to append a migrate_intent marker for host pickup.`,
      );
    }

    io.emit.finish();
    return 0;
  } finally {
    log.close();
  }
}
