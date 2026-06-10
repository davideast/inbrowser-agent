/**
 * MCP client adapter — the inverse of `./serve.ts`. Connects to an
 * external MCP server, lists its tools, and adapts each into a
 * {@link ToolHandler} the agent's registry/dispatch can run. This lets a
 * session drive ANY MCP server's tools (pyric serve's `/__pyric/mcp`,
 * Claude-Desktop-style servers, ...) over the same loop that runs
 * in-process tools.
 *
 * Wire model (mirror of `serve.ts`): each MCP tool becomes one
 * `ToolHandler` whose `parameters` is the tool's `inputSchema` (same
 * `JsonSchema` shape, no translation) and whose `execute` forwards to
 * `client.callTool`. The MCP `CallTool` result is mapped back into a
 * `ToolResult` — and because `serve.ts` emits a tool's `ToolResult` as
 * `JSON.stringify(result)` in a text block, a pyric-style server
 * round-trips losslessly: we parse that text back into the structured
 * result. Other servers' free-text results degrade to `{ ok, summary }`.
 *
 * Transports: streamable HTTP (a `url`) or stdio (a `command`). HTTP is
 * the right one for a running `pyric serve --bridge` — connect straight
 * to its `mcpUrl`; no stdio proxy needed (that shim exists only for
 * Claude Code's static `.mcp.json`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JsonSchema } from '../types/llm.js';
import type { ToolContext, ToolHandler, ToolResult } from '../types/tools.js';

export type McpConnectOptions = (
  | HttpTransportOptions
  | StdioTransportOptions
  | InjectedTransportOptions
) &
  McpCommonOptions;

interface HttpTransportOptions {
  /** Streamable-HTTP MCP endpoint (e.g. a running serve's `mcpUrl`). */
  url: string | URL;
}

interface StdioTransportOptions {
  /** Spawn an MCP server over stdio (e.g. `pyric`, `['mcp-proxy']`). */
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface InjectedTransportOptions {
  /** Bring your own transport (tests, in-memory pairs, custom transports). */
  transport: Transport;
}

interface McpCommonOptions {
  /** Client identity in the MCP handshake. */
  clientName?: string;
  clientVersion?: string;
  /**
   * Prefix every imported tool name (e.g. `'pyric_'`) to avoid clashes
   * with in-process tools or a second MCP server. The prefix is stripped
   * before the call is forwarded to the server.
   */
  namePrefix?: string;
  /** Keep only the named tools (after prefixing). Default: all. */
  include?: (name: string) => boolean;
}

export interface McpConnection {
  /** The imported tools, ready to `registry.register(...)`. */
  tools: ToolHandler[];
  /** The live client (for advanced use — prompts, resources, ...). */
  client: Client;
  /** Disconnect the transport. Call when the session ends. */
  close(): Promise<void>;
}

function makeTransport(opts: McpConnectOptions): Transport {
  if ('transport' in opts) return opts.transport;
  if ('url' in opts) return new StreamableHTTPClientTransport(new URL(opts.url));
  return new StdioClientTransport({ command: opts.command, args: opts.args, env: opts.env });
}

/**
 * Connect to an MCP server and adapt its tools into `ToolHandler`s.
 * Resolves once the handshake + `listTools` complete.
 */
export async function connectMcpTools(opts: McpConnectOptions): Promise<McpConnection> {
  const client = new Client(
    { name: opts.clientName ?? 'inbrowser-agent', version: opts.clientVersion ?? '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(makeTransport(opts));

  const { tools: listed } = await client.listTools();
  const prefix = opts.namePrefix ?? '';
  const tools: ToolHandler[] = [];
  for (const t of listed) {
    const name = prefix + t.name;
    if (opts.include && !opts.include(name)) continue;
    tools.push(adaptTool(client, t.name, name, t.description ?? '', t.inputSchema as JsonSchema));
  }

  return {
    tools,
    client,
    async close() {
      await client.close();
    },
  };
}

function adaptTool(
  client: Client,
  remoteName: string,
  localName: string,
  description: string,
  parameters: JsonSchema,
): ToolHandler {
  return {
    name: localName,
    description,
    parameters,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      try {
        const res = await client.callTool(
          { name: remoteName, arguments: (args ?? {}) as Record<string, unknown> },
          undefined,
          { signal: ctx.signal },
        );
        return mapResult(res, localName);
      } catch (err) {
        return {
          ok: false,
          summary: `${localName}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/** Map an MCP `CallTool` result back into a {@link ToolResult}. */
function mapResult(res: unknown, toolName: string): ToolResult {
  const r = res as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = (r.content ?? [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');

  // A pyric-style server emits the tool's own `ToolResult` as JSON in the
  // text block (see serve.ts) — round-trip it back to the structured shape.
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<ToolResult> & Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.ok === 'boolean' &&
        typeof parsed.summary === 'string'
      ) {
        return parsed as ToolResult;
      }
      // Valid JSON but not a ToolResult — keep it as structured data.
      return { ok: !r.isError, summary: summarize(text), data: parsed };
    } catch {
      /* not JSON — fall through to free-text */
    }
  }
  return {
    ok: !r.isError,
    summary: text ? summarize(text) : r.isError ? `${toolName} failed` : `${toolName} ok`,
    ...(text ? { data: { content: r.content } } : {}),
  };
}

function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}
