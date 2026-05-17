/**
 * Inverse-mode types — see `plans/inverse-mode-architecture.md`.
 *
 * In inference mode, an agent owns its LlmClient + conversation and the
 * strategy drives a turn-by-turn loop calling `ToolHandler`s. In inverse
 * mode, an external LLM host (Claude Code, Claude Desktop) drives the
 * conversation and calls *behavior-named* `AgentTool`s one-shot.
 *
 * AgentTool is intentionally distinct from ToolHandler:
 *   - `ToolHandler` carries session-coupled context (workspace, runtime,
 *     sandbox, lint) that the inference loop maintains across turns.
 *   - `AgentTool` is a pure(-ish) function over input + minimal context.
 *     No conversation state. Plan/commit chaining is per-tool, enforced
 *     via planHash, not framework-level.
 */

import type { EventLog } from '../events/log-core.js';
import type { JsonSchema } from './llm.js';
import type { ProjectContext } from './project-context.js';
import type { SandboxHandle } from './tools.js';

/**
 * A bundle of behavior-named tools that share a domain + (where
 * applicable) a planHash chain.
 *
 * `name` is the developer-facing id (`'hello-firestore'`,
 * `'firestore-data-modeling'`). It surfaces in `agent describe` and
 * `--agent` flags. It is NOT what the host LLM sees — each tool's own
 * `name` is.
 */
export interface AgentDefinition {
  name: string;
  description: string;
  tools: AgentTool[];
}

/**
 * One MCP-exposable behavior. The `name` and `description` are what the
 * host LLM matches against user intent — phrase them as verbs the user
 * would utter ("design_firestore_schema", not "data_modeling__plan").
 */
export interface AgentTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: I, ctx: AgentContext): Promise<AgentToolResult<O>>;
}

/**
 * Per-call context. Distinct from `ToolContext` (the inference-mode
 * shape): no workspace, no runtime, no lint — those concepts live in
 * the conversation owner. AgentTools are one-shot from the host's POV.
 */
export interface AgentContext {
  /** Unique per call; correlates the run record + any events emitted. */
  runId: string;
  /** Firebase project id — routes the event log + runs log. */
  projectId: string;
  /** Append-only mutation log; same one `wrapMutating` writes to. */
  events: EventLog;
  /** Cancellation signal. Host typically supplies one per RPC. */
  signal: AbortSignal;
  /** Optional sandbox handle for tools that need it. Absent for pure
   *  computation (e.g. schema design). */
  sandbox?: SandboxHandle;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /**
   * Initialized `ProjectContext` for tools that need live project
   * access (admin Firestore reads, REST API rules fetch). Present
   * when `agent serve` was launched with FIREBASE_SA_BASE64 in env;
   * absent otherwise. Tools should fail with a clear "needs SA"
   * message when this is required and missing, not silently no-op.
   *
   * Field name preserved (vs. `projectContext`) so the public
   * AgentContext shape doesn't break external tools that destructure
   * `ctx.agentApp`; the *type* migrated from `AgentApp` to
   * `ProjectContext` in Phase C step 13 of the legacy-SDK migration.
   */
  agentApp?: ProjectContext;
}

export interface AgentToolResult<O = unknown> {
  ok: boolean;
  /** One-line summary the host LLM can quote back to the user. */
  summary: string;
  /** Structured payload. Host LLM may reference it in follow-up tool calls. */
  data?: O;
  /**
   * Set by preview/plan tools; consumed by the corresponding commit
   * tool to enforce that the user-approved plan is what gets executed.
   * Hash content is at the tool author's discretion (typically a SHA
   * of the canonical JSON of `data`).
   */
  planHash?: string;
  /** Event log ids produced this call. Surfaces to the run record. */
  eventIds?: string[];
}
