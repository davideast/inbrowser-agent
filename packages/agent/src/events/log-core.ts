/**
 * Pure / browser-safe pieces of the event log surface:
 *
 *   - `EventLog`, `AppendDraft` — types describing the writer's
 *     contract; consumers (wrap, replay) describe handlers without
 *     pulling in the writer implementation.
 *   - `HOST_AGENT_ID` — string constant; canonical declaration is
 *     `types/events.ts` (also browser-safe).
 *   - `generateEventId`, `buildRollbackEvent`, `EventTooLargeError`,
 *     `DEFAULT_MAX_EVENT_BYTES` — pure helpers used by both the
 *     Node-side writer (`log.ts`) and the browser-safe `wrapMutating`
 *     decorator.
 *
 * The Node-side writer (`openEventLog`, `defaultProjectLogDir`) lives
 * in `./log.ts` and imports `node:fs` / `node:os`. Splitting along
 * this axis lets `wrap.ts` and the universal `@inbrowser/agent` entry
 * use the pure helpers without dragging Node imports into browser
 * bundles.
 */

import type {
  MutationEvent,
  MutationEventFilter,
  MutationPhase,
  ReverseOp,
} from '../types/events.js';

export { HOST_AGENT_ID } from '../types/events.js';

/**
 * Default per-event byte cap. Matches the Linux PIPE_BUF default and
 * stays well inside macOS's atomic-write window. Above this, append
 * atomicity isn't guaranteed and concurrent writers can interleave.
 */
export const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;

/**
 * Time-prefixed base36 id with an optional per-log sequence so two
 * appends within the same millisecond stay strictly sortable by
 * emission order. Without the sequence the only tiebreaker is the
 * random suffix, which can flip ordering — a real bug for
 * `replayEvents`'s sinceEventId cursor.
 */
export function generateEventId(
  now: () => number = Date.now,
  sequence?: number,
): string {
  const ts = now().toString(36).padStart(9, '0');
  const seq = sequence !== undefined ? `-${sequence.toString(36).padStart(4, '0')}` : '';
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}${seq}-${rand}`;
}

export class EventTooLargeError extends Error {
  override readonly name = 'EventTooLargeError';
  constructor(
    readonly bytes: number,
    readonly cap: number,
    readonly tool: string,
  ) {
    super(
      `event for tool=${tool} is ${bytes} bytes, exceeds cap ${cap}. ` +
      `Atomic append is not guaranteed above this size; concurrent writers can interleave. ` +
      `Raise via openEventLog({ maxEventBytes }) only if you accept the loss of atomicity guarantees, ` +
      `or shrink the payload (truncate before/after snapshots, omit large args).`,
    );
  }
}

export interface EventLog {
  readonly path: string;
  readonly projectId: string;
  /**
   * Append a single event. `id` + `ts` are auto-populated when absent
   * so callers can pass a partial draft. Returns the full event for
   * convenience (e.g. wrapMutating's plan-then-commit flow).
   */
  append(draft: AppendDraft): MutationEvent;
  /**
   * Read all events matching the filter. Returns an array, not a
   * stream — the log is small (tens to thousands of events).
   */
  read(filter?: MutationEventFilter): MutationEvent[];
  /**
   * Lazily-built cache of event ids that have already been applied
   * by `replayEvents` (i.e. an event with
   * `metadata.type === 'migrate_applied'` referencing them exists).
   * Invalidated on every `append`.
   */
  appliedEventIds(): Set<string>;
  /** Release resources. Idempotent. */
  close(): void;
}

export type AppendDraft = Omit<MutationEvent, 'id' | 'ts'> &
  Partial<Pick<MutationEvent, 'id' | 'ts'>>;

export function buildRollbackEvent(opts: {
  original: MutationEvent;
  reason: 'failure' | 'undo';
  reverseOp?: ReverseOp;
  agent: string;
  sessionId: string;
  now?: () => number;
}): AppendDraft {
  const nowFn = opts.now ?? Date.now;
  void nowFn;
  return {
    agent: opts.agent,
    sessionId: opts.sessionId,
    tool: opts.original.tool,
    phase: 'rollback' satisfies MutationPhase,
    target: opts.original.target,
    reversible: false,
    irreversibleReason: 'rollback events are terminal',
    ...(opts.reverseOp ? { reverseOp: opts.reverseOp } : {}),
    metadata: {
      reason: opts.reason,
      originalEventId: opts.original.id,
    },
  };
}
