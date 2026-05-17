/**
 * `RuntimeState` — what the agent's tools have produced this session.
 *
 * Per-session. Owned by `AgentSession`, mutated by tool handlers via
 * the patch returned from `ToolResult.runtimePatch`. The host reads
 * this through `runtime_changed` session events; it does not write
 * directly.
 *
 * Ephemeral by design — not persisted across reloads. The user's
 * authored content lives in `Workspace`; this is the volatile
 * runtime view.
 */

export interface RuntimeState {
  terminal: TerminalSection[];
  runSummary: RunSummary | null;
  deploy: DeployState | null;
  parseError: ParseError | null;
  uiErrors: UiError[];
  /** Bumped on reseed / preset switch / sandbox reset; consumers watch to remount. */
  sandboxVersion: number;
}

export interface TerminalSection {
  id: string;
  kind: 'run' | 'deploy' | 'system';
  title: string;
  timestamp: number;
  entries: TerminalEntry[];
}

export interface TerminalEntry {
  level: 'info' | 'warn' | 'error' | 'denial';
  message: string;
  path?: string;
  detail?: unknown;
}

export interface RunSummary {
  ok: boolean;
  durationMs: number;
  docsTouched: number;
  errors: number;
  message?: string;
}

export interface DeployState {
  ok: boolean;
  messages: DeployMessage[];
  timestamp: number;
}

export interface DeployMessage {
  severity: 'info' | 'warn' | 'error';
  text: string;
  line?: number;
  column?: number;
}

export interface ParseError {
  message: string;
  line: number;
  column: number;
  expected?: string;
}

export interface UiError {
  source: 'compile' | 'runtime' | 'render';
  message: string;
  /** Filled when the error came from rule denial — request/resource context. */
  denialContext?: Record<string, unknown>;
  /** Compile errors carry source location. */
  line?: number;
  column?: number;
  /** Runtime errors carry an error code (e.g. `permission-denied`). */
  code?: string;
}

export const EMPTY_RUNTIME: RuntimeState = Object.freeze({
  terminal: Object.freeze([] as TerminalSection[]) as unknown as TerminalSection[],
  runSummary: null,
  deploy: null,
  parseError: null,
  uiErrors: Object.freeze([] as UiError[]) as unknown as UiError[],
  sandboxVersion: 0,
}) as RuntimeState;
