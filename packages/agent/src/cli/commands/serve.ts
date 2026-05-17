/**
 * `agent serve` — inverse-mode MCP server entrypoint.
 *
 * Boots a stdio MCP server exposing every injected agent's tools as
 * one flat catalog to an external host (Claude Code, Claude Desktop,
 * Cursor, ...). Tool-surface minimization is the host's concern
 * (allowlists in Claude Code settings, etc.); this command doesn't
 * filter.
 *
 * The process holds stdin/stdout for the MCP transport, so:
 *   - no events go to stdout outside of --dry-run
 *   - the function never returns under normal operation; it resolves
 *     when the parent closes the transport.
 *
 * Agents come from `io.agents`. The CLI itself ships zero built-in
 * agents — host packages (e.g. `firebase-agent-sdk`) wire their own
 * agent definitions and call this command as a library.
 */

import { serveAgentsOverStdio } from '../../mcp/serve.js';
import type { AgentDefinition } from '../../types/agent.js';
import type { ProjectContext } from '../../types/project-context.js';
import type { Emitter } from '../output.js';
import type { ParsedArgs } from '../parse.js';
import { UsageError } from '../parse.js';

export interface ServeCommandIO {
  emit: Emitter;
  now?: () => string;
  /** Override the MCP serve function for tests. */
  serve?: typeof serveAgentsOverStdio;
  /** Agents to expose. Required — no built-ins. */
  agents?: AgentDefinition[];
  /**
   * Pre-built `ProjectContext` for live-mode tools (e.g. Firestore
   * audit's projectId mode). Hosts that own Firebase credentials wire
   * this; agents that don't need live data ignore it.
   */
  agentApp?: ProjectContext;
}

export async function serveCommand(args: ParsedArgs, io: ServeCommandIO): Promise<number> {
  const emit = io.emit;
  const now = io.now ?? (() => new Date().toISOString());

  const projectId = args.options['project'] as string | undefined;
  if (!projectId) {
    throw new UsageError(
      'missing --project: pass the Firebase project id for log routing',
      'Example: --project my-app',
    );
  }

  const eventsDir = args.options['events-dir'] as string | undefined;
  const agents = io.agents ?? [];
  if (agents.length === 0) {
    throw new UsageError(
      'no agents wired into this serve command',
      'Host packages compose `@inbrowser/agent` and call serveCommand with their own AgentDefinitions. The bare `agent serve` CLI ships zero built-ins.',
    );
  }

  const agentApp = io.agentApp;

  if (args.options['dry-run']) {
    emit.event(
      {
        type: 'dry_run_plan',
        ts: now(),
        command: 'serve',
        projectId,
        liveMode: agentApp ? { projectId: agentApp.projectId } : null,
        agents: agents.map((a) => ({
          name: a.name,
          tools: a.tools.map((t) => t.name),
        })),
        ...(eventsDir ? { eventsDir } : {}),
      },
      () =>
        `[plan] serve · project=${projectId} · live=${
          agentApp ? agentApp.projectId : 'off'
        } · agents=${agents.map((a) => `${a.name}(${a.tools.length})`).join(',')}`,
    );
    emit.finish();
    return 0;
  }

  const serve = io.serve ?? serveAgentsOverStdio;
  const handle = await serve({
    agents,
    projectId,
    ...(eventsDir ? { eventsDir } : {}),
    ...(agentApp ? { agentApp } : {}),
  });

  // Wait until stdin closes (parent host disconnects).
  await new Promise<void>((resolve) => {
    process.stdin.on('end', () => resolve());
    process.stdin.on('close', () => resolve());
  });

  await handle.close();
  return 0;
}
