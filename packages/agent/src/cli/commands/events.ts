/**
 * `agent events` — read + filter the per-project mutation event log.
 *
 * Emits one event per NDJSON line. Field filtering (`--fields`)
 * applies to each event. Read-only — never appends.
 *
 * Bookkeeping markers (`migrate_applied`, `migrate_intent`) are
 * **excluded by default** so users querying "what changed?" don't
 * see audit-of-the-audit rows mixed in. Pass `--include-bookkeeping`
 * to opt back in.
 */

import { openEventLog } from '../../events/log.js';
import type { MutationEventFilter, MutationPhase, TargetKind } from '../../types/events.js';
import type { Emitter } from '../output.js';
import type { ParsedArgs } from '../parse.js';

export interface EventsCommandIO {
  emit: Emitter;
  /** Injectable for tests; defaults to `openEventLog`. */
  openLog?: typeof openEventLog;
}

export function eventsCommand(args: ParsedArgs, io: EventsCommandIO): number {
  const projectId = args.options['project'] as string | undefined;
  if (!projectId) {
    throw new Error('agent events: --project is required');
  }

  const eventsDir = args.options['events-dir'] as string | undefined;
  const openLog = io.openLog ?? openEventLog;

  const log = openLog({
    projectId,
    ...(eventsDir ? { logDir: eventsDir } : {}),
  });

  const filter: MutationEventFilter = {};
  if (typeof args.options['session'] === 'string') filter.sessionId = args.options['session'];
  if (typeof args.options['tool'] === 'string') filter.tool = args.options['tool'] as string;
  if (typeof args.options['agent'] === 'string') filter.agent = args.options['agent'] as string;
  if (typeof args.options['phase'] === 'string') filter.phase = args.options['phase'] as MutationPhase;
  if (typeof args.options['since'] === 'string') filter.since = args.options['since'] as string;
  if (typeof args.options['until'] === 'string') filter.until = args.options['until'] as string;
  if (typeof args.options['target-kind'] === 'string') {
    filter.targetKind = args.options['target-kind'] as TargetKind;
  }

  const includeBookkeeping = Boolean(args.options['include-bookkeeping']);

  try {
    const events = log.read(filter).filter((e) => {
      if (includeBookkeeping) return true;
      const type = (e.metadata as { type?: string } | undefined)?.type;
      return type !== 'migrate_applied' && type !== 'migrate_intent';
    });
    for (const event of events) {
      io.emit.event(
        event as unknown as Record<string, unknown>,
        () =>
          `${event.ts} ${event.phase.padEnd(8)} ${event.tool.padEnd(20)} ${event.target.kind}:${event.target.path}` +
          (event.reversible ? '' : ' [irreversible]'),
      );
    }
    io.emit.finish();
    return 0;
  } finally {
    log.close();
  }
}
