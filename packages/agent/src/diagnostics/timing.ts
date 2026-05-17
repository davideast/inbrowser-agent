/**
 * Wall-clock split helper. Consumes a captured `TraceEvent[]` and
 * returns one `TurnTimingRow` per ReAct iteration, with the
 * iteration's language-model time and tool-dispatch time as
 * separate columns.
 *
 * Pairing rule: events are matched by `requestId`. An iteration
 * with only an `llm_request` (e.g. mid-stream error before
 * `llm_response`) yields a row with `llmMs: undefined` and
 * `dispatchMs: undefined`. An iteration with `llm_request` +
 * `llm_response` but no `turn_dispatch_complete` (the final
 * assistant turn that emits no tool calls) yields `llmMs` and
 * `dispatchMs: undefined`. Missing endpoints never throw.
 *
 * `totalMs` is the iteration's full wall-clock from request
 * dispatch through the tool-dispatch close — i.e. `dispatchEndMs -
 * requestStartMs`. It is `undefined` whenever either endpoint is
 * missing.
 */

import type { TraceEvent } from '../types/trace.js';

export interface TurnTimingRow {
  /** Session-scoped turn id. Multiple rows share a `turnId` when
   *  the turn ran multiple ReAct iterations. */
  turnId: string;
  /** 0-indexed ReAct iteration within the turn. Unique together
   *  with `turnId`; identical to the iteration index encoded in
   *  `requestId`. */
  iteration: number;
  /** Stable id for the row. Matches
   *  `LlmRequestTrace.requestId` / `LlmResponseTrace.requestId` /
   *  `TurnDispatchCompleteTrace.requestId`. */
  requestId: string;
  /** Wall-clock ms spent in the language model: response timestamp
   *  minus request timestamp. `undefined` if either endpoint is
   *  missing (e.g. mid-stream error). */
  llmMs: number | undefined;
  /** Wall-clock ms spent in tool dispatch: turn-dispatch-complete
   *  timestamp minus response timestamp. `undefined` for the final
   *  assistant turn (no tool calls → no dispatch event) or when
   *  the response endpoint is missing. */
  dispatchMs: number | undefined;
  /** Wall-clock ms across the full iteration: turn-dispatch-complete
   *  timestamp minus request timestamp. `undefined` when either
   *  endpoint is missing. */
  totalMs: number | undefined;
}

interface PerRequestAccumulator {
  turnId: string | undefined;
  iteration: number | undefined;
  requestTs: number | undefined;
  responseTs: number | undefined;
  dispatchTs: number | undefined;
  /** Insertion order, so the output preserves trace ordering when
   *  multiple iterations share timestamps. */
  firstSeenAt: number;
}

export function turnTimingTable(events: readonly TraceEvent[]): TurnTimingRow[] {
  const byRequestId = new Map<string, PerRequestAccumulator>();

  const touch = (requestId: string): PerRequestAccumulator => {
    let acc = byRequestId.get(requestId);
    if (!acc) {
      acc = {
        turnId: undefined,
        iteration: undefined,
        requestTs: undefined,
        responseTs: undefined,
        dispatchTs: undefined,
        firstSeenAt: byRequestId.size,
      };
      byRequestId.set(requestId, acc);
    }
    return acc;
  };

  for (const ev of events) {
    if (ev.kind === 'llm_request') {
      const acc = touch(ev.data.requestId);
      acc.turnId = ev.data.turnId;
      acc.iteration = ev.data.iteration;
      acc.requestTs = ev.data.ts;
    } else if (ev.kind === 'llm_response') {
      const acc = touch(ev.data.requestId);
      acc.responseTs = ev.data.ts;
    } else if (ev.kind === 'turn_dispatch_complete') {
      const acc = touch(ev.data.requestId);
      // `llm_request` is the canonical source for turnId/iteration,
      // but fall through to the dispatch event so an out-of-order or
      // truncated trace still produces a useful row.
      acc.turnId = acc.turnId ?? ev.data.turnId;
      acc.iteration = acc.iteration ?? ev.data.iteration;
      acc.dispatchTs = ev.data.ts;
    }
  }

  const rows: TurnTimingRow[] = [];
  for (const [requestId, acc] of byRequestId) {
    const llmMs =
      acc.requestTs !== undefined && acc.responseTs !== undefined
        ? acc.responseTs - acc.requestTs
        : undefined;
    const dispatchMs =
      acc.responseTs !== undefined && acc.dispatchTs !== undefined
        ? acc.dispatchTs - acc.responseTs
        : undefined;
    const totalMs =
      acc.requestTs !== undefined && acc.dispatchTs !== undefined
        ? acc.dispatchTs - acc.requestTs
        : undefined;
    rows.push({
      turnId: acc.turnId ?? 'turn-anon',
      iteration: acc.iteration ?? 0,
      requestId,
      llmMs,
      dispatchMs,
      totalMs,
    });
  }

  rows.sort((a, b) => {
    const accA = byRequestId.get(a.requestId)!;
    const accB = byRequestId.get(b.requestId)!;
    return accA.firstSeenAt - accB.firstSeenAt;
  });

  return rows;
}
