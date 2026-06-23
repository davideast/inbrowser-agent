import { describe, expect, test } from 'bun:test';
import type { Sandbox, SandboxToolResult } from '@inbrowser/sandbox';
import { createSandboxAgentTools } from '../src/sandbox/index.js';

describe('@inbrowser/agent/sandbox', () => {
  test('creates agent tools from a sandbox', () => {
    const tools = createSandboxAgentTools(createTestSandbox('agent-sandbox-runtime'), {
      names: ['read', 'write'],
    });

    expect(tools.toolList.map((handler) => handler.name)).toEqual(['read', 'write']);
    expect(typeof tools.dispatch.execute).toBe('function');
  });

  test('dispatch executes through sandbox.tools.run', async () => {
    const tools = createSandboxAgentTools(createTestSandbox('agent-sandbox-dispatch'), {
      names: ['write'],
    });

    const result = await tools.dispatch.execute(
      { id: 'call-1', name: 'write', args: { path: 'notes.txt', content: 'hello' } },
      { signal: new AbortController().signal },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('ran write');
  });

  test('honors the tool name allowlist', async () => {
    const tools = createSandboxAgentTools(createTestSandbox('agent-sandbox-allowlist'), {
      names: ['read'],
    });

    expect(tools.toolList.map((handler) => handler.name)).toEqual(['read']);

    const result = await tools.dispatch.execute(
      { id: 'call-1', name: 'write', args: {} },
      { signal: new AbortController().signal },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Unknown tool');
  });
});

function createTestSandbox(id: string): Sandbox {
  const read = {
    name: 'read',
    description: 'Read a test file.',
    parameters: {},
    pure: true,
    async execute(): Promise<SandboxToolResult> {
      return { ok: true, summary: 'read' };
    },
  };
  const write = {
    name: 'write',
    description: 'Write a test file.',
    parameters: {},
    async execute(): Promise<SandboxToolResult> {
      return { ok: true, summary: 'write' };
    },
  };
  const tools = [read, write];
  return {
    id,
    cwd: '/work',
    fs: undefined as never,
    runtime: undefined as never,
    capabilities: undefined as never,
    services: {},
    tools: {
      list: tools,
      get(name) {
        return tools.find((tool) => tool.name === name);
      },
      async run(name) {
        return { ok: true, summary: `ran ${name}` };
      },
    },
    checkpoints: undefined as never,
    on() {
      return () => {};
    },
    emit() {},
    destroy() {},
  };
}
