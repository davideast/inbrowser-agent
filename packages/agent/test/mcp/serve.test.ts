import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildServer } from '../../src/mcp/serve.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { RunRecord } from '../../src/metrics/runs.js';
import type {
  AgentContext,
  AgentDefinition,
  AgentTool,
  AgentToolResult,
} from '../../src/types/agent.js';

function freshDir(): string {
  return mkdtempSync(`${tmpdir()}/mcp-serve-`);
}

/** Two-tool stub agent. `ok_tool` always succeeds; `fail_tool` always fails. */
function stubAgent(): AgentDefinition {
  const okTool: AgentTool<{ input?: string }, { echoed: string }> = {
    name: 'ok_tool',
    description: 'Always returns ok=true. Echoes the input.',
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string' } },
    },
    async execute(input, _ctx: AgentContext): Promise<AgentToolResult<{ echoed: string }>> {
      return {
        ok: true,
        summary: 'ok',
        data: { echoed: input.input ?? '' },
        eventIds: [],
      };
    },
  };

  const failTool: AgentTool<Record<string, never>, undefined> = {
    name: 'fail_tool',
    description: 'Always returns ok=false.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, _ctx): Promise<AgentToolResult<undefined>> {
      return { ok: false, summary: 'intentional failure', eventIds: [] };
    },
  };

  return {
    name: 'stub',
    description: 'Synthetic agent for serve tests — no I/O.',
    tools: [okTool, failTool],
  };
}

/**
 * Drives the registered request handlers directly by reaching into the
 * Server's internal handler map. Avoids spawning a stdio transport in
 * tests.
 */
function callHandler<T>(server: any, schema: any, params: unknown): Promise<T> {
  const method: string = schema.shape.method.value;
  const handler = server._requestHandlers.get(method);
  if (!handler) throw new Error(`no handler for ${method}`);
  const extra: any = {
    signal: new AbortController().signal,
    sessionId: 'test',
    requestId: '1',
  };
  return handler({ method, params }, extra) as Promise<T>;
}

describe('buildServer (MCP serve)', () => {
  test('rejects empty agent list', () => {
    expect(() => buildServer({ agents: [], projectId: 'p' })).toThrow(
      /at least one AgentDefinition/,
    );
  });

  test('rejects duplicate tool names across agents', () => {
    const a = stubAgent();
    const dup: AgentDefinition = {
      name: 'dup-agent',
      description: 'dup',
      tools: [a.tools[0]!],
    };
    const dir = freshDir();
    try {
      expect(() =>
        buildServer({
          agents: [a, dup],
          projectId: 'p-test',
          eventsDir: dir,
        }),
      ).toThrow(/duplicate tool name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lists tools by behavior name (not by agent name)', async () => {
    const dir = freshDir();
    try {
      const { server, eventLog, runLog } = buildServer({
        agents: [stubAgent()],
        projectId: 'p-test',
        eventsDir: dir,
      });
      const list = await callHandler<{
        tools: Array<{ name: string; description: string }>;
      }>(server, ListToolsRequestSchema, {});
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual(['fail_tool', 'ok_tool']);
      runLog.close();
      eventLog.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('call_tool writes a RunRecord on ok and on failure', async () => {
    const dir = freshDir();
    try {
      const { server, eventLog, runLog } = buildServer({
        agents: [stubAgent()],
        projectId: 'p-test',
        eventsDir: dir,
      });

      const okResp = await callHandler<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>(server, CallToolRequestSchema, {
        name: 'ok_tool',
        arguments: { input: 'hello' },
      });
      expect(okResp.isError).toBeUndefined();
      const okPayload = JSON.parse(okResp.content[0]!.text);
      expect(okPayload.ok).toBe(true);

      const failResp = await callHandler<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>(server, CallToolRequestSchema, {
        name: 'fail_tool',
        arguments: {},
      });
      expect(failResp.isError).toBe(true);
      const failPayload = JSON.parse(failResp.content[0]!.text);
      expect(failPayload.ok).toBe(false);

      const unknownResp = await callHandler<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>(server, CallToolRequestSchema, {
        name: 'nope_not_real',
        arguments: {},
      });
      expect(unknownResp.isError).toBe(true);

      runLog.close();
      eventLog.close();

      const runsPath = `${dir}/p-test/runs.ndjson`;
      expect(existsSync(runsPath)).toBe(true);
      const lines = readFileSync(runsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RunRecord);
      // Unknown tool short-circuits before writing a record; only 2 records.
      expect(lines).toHaveLength(2);
      expect(lines[0]!.tool).toBe('ok_tool');
      expect(lines[0]!.outcome).toBe('ok');
      expect(lines[0]!.mode).toBe('inverse');
      expect(lines[1]!.tool).toBe('fail_tool');
      expect(lines[1]!.outcome).toBe('failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
