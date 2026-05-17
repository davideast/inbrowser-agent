/**
 * Tool registry + dispatch + handler types.
 *
 * The `ToolRegistry` is a configuration concern (what tools exist);
 * `ToolDispatch` is a runtime concern (run the named one against this
 * context). Splitting them lets a host wire the catalog at startup
 * with `registry.register(handler)` and lets concurrent sessions
 * share a stateless dispatcher.
 */

import type { Capabilities } from './capabilities.js';
import type { JsonSchema } from './llm.js';
import type { RuntimeState } from './runtime.js';
import type { StitchContext, Workspace } from './workspace.js';

export interface ToolHandler<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Capability gate — handler is excluded from `list()` when this returns false. */
  available?(capabilities: Capabilities): boolean;
  /**
   * Opt-in: the dispatcher is allowed to run this tool concurrently with
   * other `parallelSafe` tools issued in the same turn. Absent or `false`
   * means the conservative default — the dispatcher treats it as not safe
   * to parallelize. Read this field via {@link isParallelSafe} so the
   * default is applied uniformly. Pure-tool dispatchers (parallel
   * scheduling) consume this; tag-only branches do not change runtime
   * behavior.
   */
  parallelSafe?: boolean;
  /**
   * Opt-in: calling this tool with the same arguments against the same
   * workspace state always produces the same result, so a content-addressed
   * cache may serve repeat calls. Absent or `false` means the conservative
   * default — the dispatch layer must execute the handler every call. Read
   * this field via {@link isPure} so the default is applied uniformly.
   */
  pure?: boolean;
  execute(args: A, ctx: ToolContext): Promise<ToolResult<D>>;
}

/**
 * Session-scoped context handed to every tool's `execute`. Kept
 * narrow per F8 — only `signal` is required; everything else is
 * optional so headless hosts (Deployment Agent, MCP server) don't
 * have to mock playground-shaped state.
 *
 * Per F2 + F5, factories capture their own deps at construction
 * time (closure) and tool handlers only read from {deps, args, ctx}.
 * Don't grow this interface to satisfy specific factories.
 */
export interface ToolContext {
  /** Cancellation signal — tools should respect it for long-running ops. */
  signal: AbortSignal;
  /** Playground / session workspace (rules source, agent JS, etc.). */
  workspace?: Workspace;
  /** Playground / session runtime state (last sandbox run, etc.). */
  runtime?: RuntimeState;
  /** Per-session sandbox handle, when the host has one. */
  sandbox?: SandboxHandle;
  /** Pure-function lint, injected for testability. */
  lint?: LintFn;
  /** Optional Stitch client — absent when capability disables it. */
  stitch?: StitchClient;
}

/**
 * Minimal sandbox surface tools need. The host injects a concrete
 * adapter (today: `@pyric/sandbox` runner). Kept narrow so tool tests
 * can stub it without pulling in the whole sandbox package.
 */
export interface SandboxHandle {
  run(
    code: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    durationMs: number;
    docsTouched: number;
    errors: number;
    entries: unknown[];
  }>;
  deployRules(source: string): Promise<{
    ok: boolean;
    messages: {
      severity: 'info' | 'warn' | 'error';
      text: string;
      line?: number;
      column?: number;
    }[];
  }>;
  readState(opts?: { path?: string; maxDepth?: number }): Promise<unknown>;
  reseed(opts: { presetId: string }): void;
  dispose(): void;
}

export type LintFn = (source: string) => { warnings: LintWarning[] };
export interface LintWarning {
  severity: 'info' | 'warn' | 'error';
  message: string;
  line?: number;
  column?: number;
}

/** Optional Stitch design client. Absent in headless / capability-off runs. */
export interface StitchClient {
  hasKey(): boolean;
  context(): StitchContext;
}

export interface ToolResult<D = unknown> {
  ok: boolean;
  /** One-line human-readable summary the model can quote back. */
  summary: string;
  data?: D;
  /** Patches applied by the session to its own state. */
  workspacePatch?: Partial<Workspace>;
  runtimePatch?: Partial<RuntimeState>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolRegistry {
  /**
   * Register a new handler. **Throws** if `handler.name` is already
   * present — catches the "accidentally registered two factories
   * with overlapping tools" footgun (F6). Use `replace` for explicit
   * overlays.
   */
  register(handler: ToolHandler): void;
  /**
   * Idempotent registration. Replaces an existing handler with the
   * same name, or registers fresh. The standard shape for
   * decoration via `.map` before register (F7):
   *
   * ```ts
   * for (const t of createXxxTools(deps).map(wrapMutating)) {
   *   registry.register(t);  // or replace(t) if re-wrapping
   * }
   * ```
   */
  replace(handler: ToolHandler): void;
  unregister(name: string): boolean;
  list(opts?: { capabilities?: Capabilities }): ToolHandler[];
  has(name: string): boolean;
  /** Copy-on-write fork for per-session catalog overrides. */
  fork(): ToolRegistry;
}

export interface ToolDispatch {
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}
