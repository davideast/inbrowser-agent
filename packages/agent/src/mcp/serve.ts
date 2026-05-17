/**
 * Inverse-mode MCP serve adapter — exposes a set of `AgentDefinition`s
 * as stdio MCP tools an external host (Claude Code, Claude Desktop,
 * Cursor, ...) can call.
 *
 * Wire model: each `AgentDefinition.tools[i]` becomes one MCP tool
 * registered under its own behavior-name verbatim. The host LLM matches
 * user intent against `description`; nothing about the `AgentDefinition`
 * itself surfaces. (Developers see definitions; LLMs see tools.)
 *
 * The transport is stdio. This module deliberately writes nothing to
 * stdout — the MCP transport owns that file descriptor. Startup logs
 * and per-call traces go to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { EventLog } from '../events/log-core.js';
import { openEventLog } from '../events/log.js';
import { type RunLog, type RunRecord, generateRunId, openRunLog } from '../metrics/runs.js';
import type { AgentContext, AgentDefinition, AgentTool } from '../types/agent.js';
import type { ProjectContext } from '../types/project-context.js';

export interface ServeAgentsOptions {
  agents: AgentDefinition[];
  /** Firebase project id — routes event log + runs log paths. */
  projectId: string;
  /** Override `~/.pyric/projects` for tests. */
  eventsDir?: string;
  /** Override the runs log directory. Defaults to `eventsDir`. */
  runsDir?: string;
  /** Server identity advertised in the MCP handshake. */
  serverName?: string;
  serverVersion?: string;
  /** Injectable clock. */
  now?: () => number;
  /** Stream for diagnostic messages. Defaults to process.stderr. */
  stderr?: NodeJS.WriteStream;
  /**
   * Initialized `ProjectContext`. Pass through to every
   * `AgentContext` so tools that need live project access (e.g.
   * `audit_firestore_backend` in `projectId` mode) can use it.
   * The caller is responsible for initialization — usually via
   * `toProjectContext(await initializeAgentApp())` after reading
   * FIREBASE_SA_BASE64.
   */
  agentApp?: ProjectContext;
}

export interface ServeAgentsHandle {
  /** Close the event/run logs and the MCP server. */
  close(): Promise<void>;
}

/**
 * Build a stdio MCP server exposing the given agents' tools. Connects
 * immediately and resolves once the transport is wired. The returned
 * handle lets tests shut down cleanly; in production the process
 * terminates with the parent (Claude Code, etc.).
 */
export async function serveAgentsOverStdio(opts: ServeAgentsOptions): Promise<ServeAgentsHandle> {
  const { server, eventLog, runLog } = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  writeStderr(
    opts.stderr,
    `[pyric/agents] mcp server up · project=${opts.projectId} · agents=${opts.agents
      .map((a) => a.name)
      .join(',')}\n`,
  );
  return {
    async close() {
      await server.close();
      runLog.close();
      eventLog.close();
    },
  };
}

/**
 * Lower-level entrypoint — builds the MCP server + logs without
 * connecting to a transport. Used by tests to drive request handlers
 * directly without spawning a stdio transport.
 */
export function buildServer(opts: ServeAgentsOptions): {
  server: Server;
  eventLog: EventLog;
  runLog: RunLog;
  toolsByName: Map<string, { agent: AgentDefinition; tool: AgentTool }>;
} {
  if (opts.agents.length === 0) {
    throw new Error('serveAgentsOverStdio: at least one AgentDefinition is required');
  }
  const eventLog = openEventLog({
    projectId: opts.projectId,
    logDir: opts.eventsDir,
    now: opts.now,
  });
  const runLog = openRunLog({
    projectId: opts.projectId,
    logDir: opts.runsDir ?? opts.eventsDir,
    now: opts.now,
  });

  const toolsByName = new Map<string, { agent: AgentDefinition; tool: AgentTool }>();
  for (const agent of opts.agents) {
    for (const tool of agent.tools) {
      if (toolsByName.has(tool.name)) {
        throw new Error(
          `serveAgentsOverStdio: duplicate tool name "${tool.name}" across agents (registered by ${
            toolsByName.get(tool.name)!.agent.name
          } and ${agent.name})`,
        );
      }
      toolsByName.set(tool.name, { agent, tool });
    }
  }

  const server = new Server(
    {
      name: opts.serverName ?? 'pyric-agents',
      version: opts.serverVersion ?? '0.0.0',
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Array.from(toolsByName.values()).map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const entry = toolsByName.get(name);
    if (!entry) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, summary: `unknown tool: ${name}` }),
          },
        ],
        isError: true,
      };
    }

    const runId = generateRunId(opts.now);
    const ts = new Date((opts.now ?? Date.now)()).toISOString();
    const startedAt = (opts.now ?? Date.now)();

    const ctx: AgentContext = {
      runId,
      projectId: opts.projectId,
      events: eventLog,
      signal: new AbortController().signal,
      now: opts.now,
      ...(opts.agentApp ? { agentApp: opts.agentApp } : {}),
    };

    let outcome: RunRecord['outcome'] = 'ok';
    let errorSummary: string | undefined;
    let planHash: string | undefined;
    let eventIds: string[] = [];
    let payload: unknown;

    try {
      const result = await entry.tool.execute(args ?? {}, ctx);
      outcome = result.ok ? 'ok' : 'failed';
      planHash = result.planHash;
      eventIds = result.eventIds ?? [];
      payload = result;
      if (!result.ok) errorSummary = result.summary;
    } catch (err) {
      outcome = 'failed';
      errorSummary = err instanceof Error ? err.message : String(err);
      payload = { ok: false, summary: errorSummary, eventIds: [] };
    }

    const record: RunRecord = {
      runId,
      ts,
      agent: entry.agent.name,
      tool: entry.tool.name,
      mode: 'inverse',
      outcome,
      durationMs: Math.max(0, (opts.now ?? Date.now)() - startedAt),
      ...(planHash ? { planHash } : {}),
      eventIds,
      ...(errorSummary ? { errorSummary } : {}),
    };
    runLog.append(record);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(payload),
        },
      ],
      ...(outcome === 'failed' ? { isError: true } : {}),
    };
  });

  return { server, eventLog, runLog, toolsByName };
}

function writeStderr(stream: NodeJS.WriteStream | undefined, msg: string): void {
  (stream ?? process.stderr).write(msg);
}
