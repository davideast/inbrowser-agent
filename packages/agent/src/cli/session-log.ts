/**
 * Per-session NDJSON log writer. Every CLI run gets one file at
 * `<log-dir>/<sessionId>.ndjson` (unless --no-log). Each line is one
 * event from the same stream the CLI emits — session_start, turn
 * events, tool_call, tool_result, sandbox_event, turn_end, session_end.
 *
 * The final `session_end` event carries the metrics totals so the file
 * is self-contained: an agent can `tail` the last line for a summary
 * or stream the whole file for a full replay.
 */

import { existsSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

export interface SessionLog {
  readonly path: string | null;
  write(event: Record<string, unknown>): void;
  close(): void;
}

const NOOP_LOG: SessionLog = {
  path: null,
  write() {},
  close() {},
};

export function defaultLogDir(): string {
  return `${homedir()}/.pyric/sessions`;
}

export interface OpenSessionLogOptions {
  /** Absolute or already-resolved directory. Pass null/undefined to use the default. */
  logDir?: string | null;
  sessionId: string;
  /** When true, returns a no-op writer. */
  disabled?: boolean;
  /** Defaults to fs primitives; injectable for tests. */
  io?: {
    existsSync: typeof existsSync;
    mkdirSync: typeof mkdirSync;
    openSync: typeof openSync;
    writeSync: typeof writeSync;
    closeSync: typeof closeSync;
  };
}

export function openSessionLog(opts: OpenSessionLogOptions): SessionLog {
  if (opts.disabled) return NOOP_LOG;
  const dir = opts.logDir && opts.logDir.length > 0 ? opts.logDir : defaultLogDir();
  const path = `${dir.replace(/\/$/, '')}/${opts.sessionId}.ndjson`;
  const io = opts.io ?? { existsSync, mkdirSync, openSync, writeSync, closeSync };
  if (!io.existsSync(dir)) io.mkdirSync(dir, { recursive: true });
  // Also defensively ensure the parent of `path` exists when the session id
  // contains a '/' — disallowed by hardening, but cheap to guard.
  const parent = dirname(path);
  if (parent && !io.existsSync(parent)) io.mkdirSync(parent, { recursive: true });
  const fd = io.openSync(path, 'a');
  let closed = false;
  return {
    path,
    write(event) {
      if (closed) return;
      io.writeSync(fd, JSON.stringify(event) + '\n');
    },
    close() {
      if (closed) return;
      closed = true;
      io.closeSync(fd);
    },
  };
}
