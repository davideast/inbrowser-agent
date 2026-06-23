import { describe, expect, test } from 'bun:test';
import type { Sandbox } from '@inbrowser/sandbox';
import { createSandboxToolHandlers, registerSandboxTools } from '../src/sandbox/index.js';
import { createToolRegistry } from '../src/tools.js';

describe('@inbrowser/agent/sandbox', () => {
  test('creates handlers from installed sandbox tools', async () => {
    const sandbox = await createTestSandbox('agent-sandbox-handlers');

    const handlers = createSandboxToolHandlers({ sandbox, names: ['read', 'write'] });

    expect(handlers.map((handler) => handler.name)).toEqual(['read', 'write']);
  });

  test('registered handlers execute through sandbox.tools.run', async () => {
    const sandbox = createTestSandbox('agent-sandbox-execute');
    const registry = createToolRegistry();
    registerSandboxTools({ registry, sandbox, names: ['write'] });

    const [handler] = registry.list();
    const result = await handler.execute(
      { path: 'notes.txt', content: 'hello' },
      { signal: new AbortController().signal },
    );

    expect(result.ok).toBe(true);
    expect(sandbox.tools.get('write')).toBeDefined();
  });

  test('supports allowlisted registration', async () => {
    const sandbox = await createTestSandbox('agent-sandbox-allowlist');
    const registry = createToolRegistry();
    registerSandboxTools({ registry, sandbox, names: ['read'] });

    expect(registry.has('read')).toBe(true);
    expect(registry.has('write')).toBe(false);
  });

  test('supports replacement registration', async () => {
    const sandbox = await createTestSandbox('agent-sandbox-replace');
    const registry = createToolRegistry();
    const replacement = {
      name: 'read',
      description: 'replacement',
      parameters: {},
      async execute() {
        return { ok: true, summary: 'replacement' };
      },
    };
    registry.register(replacement);

    registerSandboxTools({ registry, sandbox, names: ['read'], replace: true });

    expect(registry.list()[0]?.description).not.toBe('replacement');
  });
});

function createTestSandbox(id: string): Sandbox {
  const read = {
    name: 'read',
    description: 'Read a test file.',
    parameters: {},
    pure: true,
    async execute() {
      return { ok: true, summary: 'read' };
    },
  };
  const write = {
    name: 'write',
    description: 'Write a test file.',
    parameters: {},
    async execute() {
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
