/**
 * Node-only entry point.
 *
 * The event log writer imports `node:fs` / `node:os` at module init
 * for append-only NDJSON logging to disk. It lives here so the
 * browser-facing root entry (`@inbrowser/agent`) stays free of Node
 * builtins.
 *
 * Consumers running in Node (the CLI, the MCP server, sdk's agent
 * definitions, integration tests) import from `@inbrowser/agent/node`.
 * Browser consumers (playground) use the root entry, which exposes
 * the browser-safe events helpers (`wrapMutating`, `replayEvents`,
 * codec utilities) directly without going through `events/index.js`.
 *
 * Other Node-only files in this package (`metrics/runs`, `agents/
 * firestore`, the CLI commands) have no external consumers via the
 * public barrel today, so they stay reachable via relative paths
 * within the package.
 */

export { openEventLog, defaultProjectLogDir } from './events/log.js';
export {
  generateEventId,
  buildRollbackEvent,
  HOST_AGENT_ID,
  EventTooLargeError,
  DEFAULT_MAX_EVENT_BYTES,
} from './events/log-core.js';

export { FixtureLoadError, loadFixture, loadFixtures } from './eval/load-node.js';
