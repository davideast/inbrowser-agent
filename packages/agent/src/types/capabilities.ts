/**
 * `Capabilities` — what the current session can do.
 *
 * Computed once per session at start, refreshed at start of each
 * turn. Drives which tools the agent is told about and which
 * behaviors the system prompt mentions.
 */

export interface Capabilities {
  /** The active LLM provider advertises tool-use support. */
  llmSupportsTools: boolean;
  /** Stitch design tools are available (BYOK present + feature-flag on). */
  stitchAvailable: boolean;
  /** Sandbox is initialized and ready to receive tool calls. */
  sandboxReady: boolean;
}

export const DEFAULT_CAPABILITIES: Capabilities = Object.freeze({
  llmSupportsTools: true,
  stitchAvailable: false,
  sandboxReady: false,
}) as Capabilities;
