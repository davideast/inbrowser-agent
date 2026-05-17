/**
 * Per-call run record — `~/.pyric/projects/<projectId>/runs.ndjson`.
 *
 * Distinct from `events.ndjson` (mutation audit) and
 * `<sessionId>.ndjson` (per-session event stream). Runs is a single,
 * project-scoped, append-only NDJSON file that captures one record per
 * agent tool invocation. The schema carries a `mode` discriminator so
 * inference-mode and inverse-mode runs land in the same file for easy
 * A/B comparison.
 *
 * Why a separate file rather than reusing the session log: a session
 * log scopes to one conversation; a run record scopes to one *call*
 * across modes. The host-driven (inverse) flow has no session id —
 * each MCP tool call is its own run.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import type { EventLogIO } from '../events/log.js';

export interface RunRecord {
  /** Time-prefixed base36; sortable by emission order. */
  runId: string;
  /** ISO-8601 timestamp. */
  ts: string;
  /** AgentDefinition.name, e.g. 'hello-firestore'. */
  agent: string;
  /** AgentTool.name, e.g. 'design_firestore_hello_schema'. */
  tool: string;
  /** Discriminator across the dual-mode story. */
  mode: 'inference' | 'inverse';
  outcome: 'ok' | 'failed';
  durationMs: number;
  /** Hash a preview tool returned; consumed by the commit tool. */
  planHash?: string;
  /** Event log ids written this call. */
  eventIds: string[];
  /** Truncated error message when outcome !== 'ok'. */
  errorSummary?: string;
}

export type RunRecordFilter = Partial<
  Pick<RunRecord, 'agent' | 'tool' | 'mode' | 'outcome'>
>;

export interface RunLog {
  readonly path: string;
  readonly projectId: string;
  append(record: RunRecord): void;
  read(filter?: RunRecordFilter): RunRecord[];
  close(): void;
}

export interface OpenRunLogOptions {
  projectId: string;
  /** Defaults to `~/.pyric/projects`. */
  logDir?: string;
  /** Injectable IO for tests. Same shape as `events/log.ts`. */
  io?: EventLogIO;
  /** Injectable clock. */
  now?: () => number;
}

const DEFAULT_IO: EventLogIO = {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
};

export function defaultRunsLogDir(): string {
  return `${homedir()}/.pyric/projects`;
}

/** Time-prefixed base36 id; matches generateEventId's shape. */
export function generateRunId(now: () => number = Date.now): string {
  const ts = now().toString(36).padStart(9, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${ts}-${rand}`;
}

export function openRunLog(opts: OpenRunLogOptions): RunLog {
  if (!/^[a-zA-Z0-9_.-]+$/.test(opts.projectId)) {
    throw new Error(
      `openRunLog: projectId ${JSON.stringify(opts.projectId)} contains disallowed characters; use [a-zA-Z0-9_.-]+`,
    );
  }
  const io = opts.io ?? DEFAULT_IO;
  const baseDir = opts.logDir ?? defaultRunsLogDir();
  const projectDir = `${baseDir.replace(/\/$/, '')}/${opts.projectId}`;
  const path = `${projectDir}/runs.ndjson`;

  if (!io.existsSync(projectDir)) io.mkdirSync(projectDir, { recursive: true });

  let closed = false;

  function ensureOpen() {
    if (closed) throw new Error(`run log ${path} is closed`);
  }

  return {
    path,
    projectId: opts.projectId,
    append(record) {
      ensureOpen();
      // appendFileSync mirrors the events-log atomicity story: one
      // syscall per record so concurrent writers can't interleave
      // mid-line on Linux + macOS.
      io.appendFileSync(path, JSON.stringify(record) + '\n');
    },
    read(filter) {
      ensureOpen();
      if (!io.existsSync(path)) return [];
      const raw = io.readFileSync(path, 'utf8');
      if (!raw) return [];
      const out: RunRecord[] = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let parsed: RunRecord;
        try {
          parsed = JSON.parse(line) as RunRecord;
        } catch {
          continue;
        }
        if (filter) {
          if (filter.agent && parsed.agent !== filter.agent) continue;
          if (filter.tool && parsed.tool !== filter.tool) continue;
          if (filter.mode && parsed.mode !== filter.mode) continue;
          if (filter.outcome && parsed.outcome !== filter.outcome) continue;
        }
        out.push(parsed);
      }
      return out;
    },
    close() {
      if (closed) return;
      closed = true;
      // No file descriptor to release; close is a logical marker so
      // subsequent reads/appends throw a clean error.
    },
  };
}
