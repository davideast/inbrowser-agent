/**
 * `wrapMutating()` — decorate a `ToolHandler` so every invocation emits
 * plan + commit (or plan + rollback) events to a project's event log.
 *
 * Each wrapped handler is still a regular `ToolHandler` — it can be
 * registered in any `ToolRegistry` and dispatched normally. The
 * wrapping is invisible to the strategy / session.
 *
 * ## CRITICAL INVARIANT: wrap on the producer, NOT on the consumer
 *
 * Wrap your handlers on the system that PRODUCES the log (the dev
 * environment, the agent session generating mutations). Do NOT wrap
 * the handlers on the system that CONSUMES the log via
 * `replayEvents()`. If you do:
 *
 *   1. Each replayed event spawns its own plan/commit pair on the
 *      target log (not just a `migrate_applied` marker).
 *   2. A subsequent replay run sees those new commits and tries to
 *      re-replay them — loop possible.
 *
 * In code: dev registers `wrapMutating(setDoc, {...})`. Prod
 * registers the BARE `setDoc` (no wrap). `replayEvents` dispatches
 * dev's log against prod's bare registry. Markers go to the log;
 * mutations go to prod state. Auditable from either side.
 *
 * Use `isWrappedHandler(handler)` to assert: a defensive check
 * before dispatching unknown registries through replay.
 *
 * ## Pattern
 *
 *   const wrapped = wrapMutating(writeRulesHandler, {
 *     log,
 *     sessionId: 'sess-1',
 *     target: (args) => ({ kind: 'workspace', path: 'workspace.rules' }),
 *     snapshot: async (_args, ctx) => ctx.workspace.rules,
 *     reverseOp: (args, _result) => ({
 *       tool: 'writeRules',
 *       args: { source: args.previousSource },
 *     }),
 *   });
 *
 * ## Failure semantics
 *
 *   - Handler throws / promise rejects → emit rollback event with
 *     `reason: 'failure'`, re-throw. The strategy / dispatcher sees
 *     the error normally.
 *   - Handler returns `{ ok: false }` → still emit commit (the
 *     mutation didn't happen, but the *intent* was reached and the
 *     audit log should show the attempt + result). Most external API
 *     handlers follow this pattern.
 */

import type { MutationEvent, MutationTarget, ReverseOp } from '../types/events.js';
import type { ToolContext, ToolHandler, ToolResult } from '../types/tools.js';
import { type EventLog, HOST_AGENT_ID, buildRollbackEvent } from './log-core.js';

export interface WrapMutatingOptions<A, D> {
  /** Where to append events. */
  log: EventLog;
  /** Session id used on every event. Same id as the active AgentSession. */
  sessionId: string;
  /** Naming the agent that's invoking this tool. Default: `'host'`. */
  agent?: string;
  /** Compute the `target` field from the handler's args. Called for
   *  both the plan and commit events. */
  target: (args: A, ctx: ToolContext) => MutationTarget;
  /** Optional snapshot of the *before* state. Called once, before
   *  execute. Returned value lands on the plan event AND the commit
   *  event so an auditor can diff. */
  snapshot?: (args: A, ctx: ToolContext) => Promise<unknown> | unknown;
  /** Compute the reverse operation. Called after a successful execute.
   *  Receives the `before` value `opts.snapshot` returned (or `undefined`
   *  when no snapshot was configured) so the reverse can restore the
   *  exact pre-mutation state. Return `null` (or omit the option) for
   *  irreversible mutations — the commit event then carries
   *  `reversible: false`. */
  reverseOp?: (
    args: A,
    result: ToolResult<D>,
    ctx: ToolContext,
    before: unknown,
  ) => ReverseOp | null;
  /** When `reverseOp` is omitted entirely (not just returning null on
   *  a given call), default to false. Set to true for handlers that
   *  *could* be reversible but don't need to declare the reverse op
   *  ahead of time (rare). */
  reversibleByDefault?: boolean;
  /** When the mutation is irreversible, why. Surfaced to `agent undo`. */
  irreversibleReason?: string;
  /** Optional static metadata stamped on every event from this tool. */
  metadata?: Record<string, unknown>;
}

/**
 * Non-enumerable marker added to every `wrapMutating()` output.
 * Used by `isWrappedHandler` to assert "this handler is NOT what
 * you want in a prod replay target."
 */
export const WRAPPED_MARKER: unique symbol = Symbol.for('@inbrowser/agent/wrapMutating');

/**
 * Returns true when `handler` was produced by `wrapMutating()`.
 * Use this in your replay target's setup to assert that no handler
 * is wrapped — wrapped handlers in a replay target spawn runaway
 * plan/commit cascades. See `wrapMutating`'s header.
 */
export function isWrappedHandler(handler: ToolHandler): boolean {
  return (handler as unknown as Record<symbol, boolean>)[WRAPPED_MARKER] === true;
}

export function wrapMutating<A = unknown, D = unknown>(
  handler: ToolHandler<A, D>,
  opts: WrapMutatingOptions<A, D>,
): ToolHandler<A, D> {
  const agent = opts.agent ?? HOST_AGENT_ID;

  const wrapped: ToolHandler<A, D> = {
    name: handler.name,
    description: handler.description,
    parameters: handler.parameters,
    ...(handler.available ? { available: handler.available } : {}),
    async execute(args, ctx) {
      const target = opts.target(args, ctx);
      const before = opts.snapshot ? await opts.snapshot(args, ctx) : undefined;

      const planEvent: MutationEvent = opts.log.append({
        agent,
        sessionId: opts.sessionId,
        tool: handler.name,
        args,
        phase: 'plan',
        target,
        ...(before !== undefined ? { before } : {}),
        reversible: opts.reversibleByDefault ?? !!opts.reverseOp,
        ...(opts.irreversibleReason ? { irreversibleReason: opts.irreversibleReason } : {}),
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      });
      void planEvent;

      let result: ToolResult<D>;
      try {
        result = await handler.execute(args, ctx);
      } catch (err) {
        opts.log.append(
          buildRollbackEvent({
            original: planEvent,
            reason: 'failure',
            agent,
            sessionId: opts.sessionId,
          }),
        );
        throw err;
      }

      const reverseOp = opts.reverseOp ? opts.reverseOp(args, result, ctx, before) : null;

      opts.log.append({
        agent,
        sessionId: opts.sessionId,
        tool: handler.name,
        args,
        phase: 'commit',
        target,
        ...(before !== undefined ? { before } : {}),
        after: result.data,
        reversible: !!reverseOp,
        ...(reverseOp ? { reverseOp } : {}),
        ...(reverseOp
          ? {}
          : opts.irreversibleReason
            ? { irreversibleReason: opts.irreversibleReason }
            : {}),
        metadata: {
          ...(opts.metadata ?? {}),
          planEventId: planEvent.id,
          ok: result.ok,
          ...(result.summary ? { summary: result.summary } : {}),
        },
      });

      return result;
    },
  };
  // Stamp the wrapped marker as a non-enumerable property so it
  // doesn't leak into JSON serialization (e.g. inside tool decls).
  Object.defineProperty(wrapped, WRAPPED_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return wrapped;
}
