import { describe, expect, test } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectMcpTools } from '../../src/mcp/connect.js';
import type { ToolContext } from '../../src/types/tools.js';

/** A tiny MCP server that mimics pyric/serve.ts: each tool's result is the
 *  tool's own `ToolResult` JSON-stringified into a text block. */
function fakePyricServer(): Server {
  const server = new Server({ name: 'fake-pyric', version: '0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'echoes',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      },
      { name: 'boom', description: 'fails', inputSchema: { type: 'object', properties: {} } },
      { name: 'plain', description: 'free text', inputSchema: { type: 'object', properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === 'echo') {
      const payload = {
        ok: true,
        summary: 'echoed',
        data: { msg: (args as { msg?: string })?.msg ?? null },
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    }
    if (name === 'boom') {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, summary: 'kaboom' }) },
        ],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: 'just some prose' }] };
  });
  return server;
}

async function wire(opts: { namePrefix?: string; include?: (n: string) => boolean } = {}) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = fakePyricServer();
  await server.connect(serverT);
  const conn = await connectMcpTools({ transport: clientT, ...opts });
  return { conn, server };
}

const ctx: ToolContext = { signal: new AbortController().signal };

describe('connectMcpTools', () => {
  test('imports MCP tools as ToolHandlers (schema preserved, prefix applied)', async () => {
    const { conn, server } = await wire({ namePrefix: 'pyric_' });
    const names = conn.tools.map((t) => t.name).sort();
    expect(names).toEqual(['pyric_boom', 'pyric_echo', 'pyric_plain']);
    const echo = conn.tools.find((t) => t.name === 'pyric_echo')!;
    expect(echo.description).toBe('echoes');
    expect((echo.parameters as { properties: object }).properties).toHaveProperty('msg');
    await conn.close();
    await server.close();
  });

  test('round-trips a pyric-style JSON ToolResult through execute', async () => {
    const { conn, server } = await wire({});
    const echo = conn.tools.find((t) => t.name === 'echo')!;
    const r = await echo.execute({ msg: 'hi' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('echoed'); // structured result recovered, not raw JSON text
    expect((r.data as { msg: string }).msg).toBe('hi'); // args forwarded under the REMOTE name
    await conn.close();
    await server.close();
  });

  test('maps an isError result to ok:false with the server summary', async () => {
    const { conn, server } = await wire({});
    const r = await conn.tools.find((t) => t.name === 'boom')!.execute({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('kaboom');
    await conn.close();
    await server.close();
  });

  test('degrades free-text (non-pyric) results to {ok, summary}', async () => {
    const { conn, server } = await wire({});
    const r = await conn.tools.find((t) => t.name === 'plain')!.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('just some prose');
    await conn.close();
    await server.close();
  });

  test('include filter keeps only selected tools', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = fakePyricServer();
    await server.connect(serverT);
    const conn = await connectMcpTools({ transport: clientT, include: (n) => n === 'echo' });
    expect(conn.tools.map((t) => t.name)).toEqual(['echo']);
    await conn.close();
    await server.close();
  });
});
