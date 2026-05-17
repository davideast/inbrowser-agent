/**
 * Project event log — NDJSON append-only writer. Node-only.
 *
 * Pure helpers (`generateEventId`, `buildRollbackEvent`, `HOST_AGENT_ID`,
 * `EventTooLargeError`, `DEFAULT_MAX_EVENT_BYTES`) and the `EventLog`
 * + `AppendDraft` types live in `./log-core.ts` — that file is
 * browser-safe and is what `wrap.ts` / `replay.ts` import.
 *
 * Each Firebase project gets one log at
 * `~/.pyric/projects/<projectId>/events.ndjson`. Every mutating tool
 * call emits at least two lines (plan + commit); failures get a
 * rollback line. `agent events` reads + filters; `agent undo` consults
 * the log to find the matching commit event and invoke its reverseOp.
 *
 * Design notes:
 *   - **Append-only.** Never rewrite. `agent undo` doesn't delete the
 *     committed event; it appends a new `rollback`-phase event that
 *     references the original id. This keeps the file replayable.
 *   - **Atomic per-event writes.** Each `append()` is one
 *     `appendFileSync` call so multi-process writers can't interleave
 *     within an event. Events have a hard byte cap (default 64KB) to
 *     stay inside the kernel's atomic-append window on Linux + macOS.
 *   - **Synchronous IO.** The log is small. A streaming reader would
 *     be over-engineering today.
 *   - **Injectable fs.** Tests pass a fake `io` object so they don't
 *     hit the real disk.
 *   - **Codec hook.** `args`, `before`, `after` are run through an
 *     `EventValueCodec` on append + decoded on read.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import type {
  MutationEvent,
  MutationEventFilter,
  ReverseOp,
} from '../types/events.js';
import {
  defaultEventValueCodec,
  type EventValueCodec,
} from './codec.js';
import {
  DEFAULT_MAX_EVENT_BYTES,
  EventTooLargeError,
  generateEventId,
  type AppendDraft,
  type EventLog,
} from './log-core.js';

// Convenience re-exports — Node-side callers can grab everything
// log-related from one entry. Browser-safe callers (wrap.ts,
// replay.ts) import from `./log-core.js` directly to avoid pulling
// `node:fs` into the universal `@inbrowser/agent` entry.
export {
  HOST_AGENT_ID,
  DEFAULT_MAX_EVENT_BYTES,
  generateEventId,
  EventTooLargeError,
  buildRollbackEvent,
} from './log-core.js';
export type { EventLog, AppendDraft } from './log-core.js';

export function defaultProjectLogDir(): string {
  return `${homedir()}/.pyric/projects`;
}

export interface EventLogIO {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  appendFileSync: typeof appendFileSync;
  readFileSync: typeof readFileSync;
}

const DEFAULT_IO: EventLogIO = {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
};

export interface OpenEventLogOptions {
  projectId: string;
  /** Absolute path to the directory containing per-project subdirs.
   *  Defaults to `~/.pyric/projects`. */
  logDir?: string;
  /** Defaults to fs primitives; injectable for tests. */
  io?: EventLogIO;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Codec for `args` / `before` / `after`. Default round-trips
   *  Date / Uint8Array / bigint / undefined. Pass a composed codec
   *  for Firestore types — see `codec.ts:composeCodecs`. */
  codec?: EventValueCodec;
  /** Per-event byte cap. Defaults to 64KB. Exceeding throws
   *  `EventTooLargeError`. */
  maxEventBytes?: number;
}

export function openEventLog(opts: OpenEventLogOptions): EventLog {
  if (!/^[a-zA-Z0-9_.-]+$/.test(opts.projectId)) {
    throw new Error(
      `openEventLog: projectId ${JSON.stringify(opts.projectId)} contains disallowed characters; use [a-zA-Z0-9_.-]+`,
    );
  }
  const io = opts.io ?? DEFAULT_IO;
  const now = opts.now ?? Date.now;
  const baseDir = opts.logDir ?? defaultProjectLogDir();
  const projectDir = `${baseDir.replace(/\/$/, '')}/${opts.projectId}`;
  const path = `${projectDir}/events.ndjson`;
  const codec = opts.codec ?? defaultEventValueCodec;
  const maxBytes = opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;

  if (!io.existsSync(projectDir)) io.mkdirSync(projectDir, { recursive: true });

  // Strictly-monotonic counter — combined with the millisecond
  // timestamp, makes ids sortable in emission order even when many
  // appends share a `Date.now()` value.
  let sequence = 0;
  let closed = false;
  // Lazy-built cache of `migrate_applied` originalEventIds. Invalidated
  // on every append so the next read rebuilds it.
  let _appliedCache: Set<string> | null = null;

  function ensureOpen() {
    if (closed) throw new Error(`event log ${path} is closed`);
  }

  function appendEvent(draft: AppendDraft): MutationEvent {
    ensureOpen();
    const event: MutationEvent = {
      id: draft.id ?? generateEventId(now, sequence++),
      ts: draft.ts ?? new Date(now()).toISOString(),
      agent: draft.agent,
      sessionId: draft.sessionId,
      tool: draft.tool,
      ...(draft.args !== undefined ? { args: codec.encode(draft.args) } : {}),
      phase: draft.phase,
      target: draft.target,
      ...(draft.before !== undefined ? { before: codec.encode(draft.before) } : {}),
      ...(draft.after !== undefined ? { after: codec.encode(draft.after) } : {}),
      reversible: draft.reversible,
      ...(draft.irreversibleReason ? { irreversibleReason: draft.irreversibleReason } : {}),
      ...(draft.reverseOp
        ? { reverseOp: encodeReverseOp(draft.reverseOp, codec) }
        : {}),
      ...(draft.metadata ? { metadata: draft.metadata } : {}),
    };
    const line = JSON.stringify(event) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > maxBytes) {
      throw new EventTooLargeError(bytes, maxBytes, draft.tool);
    }
    io.appendFileSync(path, line);
    _appliedCache = null;
    return event;
  }

  function readAll(filter?: MutationEventFilter): MutationEvent[] {
    ensureOpen();
    if (!io.existsSync(path)) return [];
    const raw = io.readFileSync(path, 'utf8');
    if (!raw) return [];
    const out: MutationEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let parsed: MutationEvent;
      try {
        parsed = JSON.parse(line) as MutationEvent;
      } catch {
        // Skip malformed lines — append-only files can become corrupt
        // if a writer crashes mid-write. Surfacing as a hard error
        // would prevent `agent events` from ever working again.
        continue;
      }
      const decoded: MutationEvent = {
        ...parsed,
        ...(parsed.args !== undefined ? { args: codec.decode(parsed.args) } : {}),
        ...(parsed.before !== undefined ? { before: codec.decode(parsed.before) } : {}),
        ...(parsed.after !== undefined ? { after: codec.decode(parsed.after) } : {}),
        ...(parsed.reverseOp
          ? { reverseOp: decodeReverseOp(parsed.reverseOp, codec) }
          : {}),
      };
      if (filter && !matches(decoded, filter)) continue;
      out.push(decoded);
    }
    return out;
  }

  function appliedEventIds(): Set<string> {
    if (_appliedCache !== null) return _appliedCache;
    const set = new Set<string>();
    for (const ev of readAll()) {
      const md = ev.metadata as { type?: string; appliedEventId?: string } | undefined;
      if (md?.type === 'migrate_applied' && typeof md.appliedEventId === 'string') {
        set.add(md.appliedEventId);
      }
    }
    _appliedCache = set;
    return set;
  }

  return {
    path,
    projectId: opts.projectId,
    append: appendEvent,
    read: readAll,
    appliedEventIds,
    close() {
      if (closed) return;
      closed = true;
    },
  };
}

function encodeReverseOp(op: ReverseOp, codec: EventValueCodec): ReverseOp {
  return {
    tool: op.tool,
    args: codec.encode(op.args),
    ...(op.description ? { description: op.description } : {}),
  };
}
function decodeReverseOp(op: ReverseOp, codec: EventValueCodec): ReverseOp {
  return {
    tool: op.tool,
    args: codec.decode(op.args),
    ...(op.description ? { description: op.description } : {}),
  };
}

function matches(event: MutationEvent, filter: MutationEventFilter): boolean {
  if (filter.id && event.id !== filter.id) return false;
  if (filter.sessionId && event.sessionId !== filter.sessionId) return false;
  if (filter.tool && event.tool !== filter.tool) return false;
  if (filter.agent && event.agent !== filter.agent) return false;
  if (filter.phase && event.phase !== filter.phase) return false;
  if (filter.targetKind && event.target.kind !== filter.targetKind) return false;
  if (filter.since && event.ts < filter.since) return false;
  if (filter.until && event.ts >= filter.until) return false;
  return true;
}
