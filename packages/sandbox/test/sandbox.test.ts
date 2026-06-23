import { describe, expect, test } from 'bun:test';
import { createBrowserWorkspace } from '@inbrowser/workspace';
import { createWorkspaceSandbox } from '../src/index.js';

describe('workspace sandbox', () => {
  test('runs standard file tools against a browser workspace', async () => {
    const workspace = await createBrowserWorkspace({ id: 'sandbox-test-files', storage: 'memory' });
    const sandbox = await createWorkspaceSandbox({ workspace });

    const write = await sandbox.tools.run('write', {
      path: 'src/App.tsx',
      content: 'export default function App() { return "hello"; }\n',
    });
    expect(write.ok).toBe(true);

    const read = await sandbox.tools.run('read', { path: 'src/App.tsx' });
    expect(read.ok).toBe(true);
    expect((read.data as { content: string }).content).toContain('hello');

    const grep = await sandbox.tools.run('grep', { path: '.', query: 'hello' });
    expect(grep.ok).toBe(true);
    expect((grep.data as { matches: unknown[] }).matches).toHaveLength(1);
  });

  test('creates and restores checkpoints', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-checkpoints',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });

    await sandbox.tools.run('write', { path: 'notes.txt', content: 'one' });
    const checkpoint = await sandbox.checkpoints.create('before edit');
    await sandbox.tools.run('write', { path: 'notes.txt', content: 'two' });
    await sandbox.checkpoints.restore(checkpoint.id);

    const read = await sandbox.tools.run('read', { path: 'notes.txt' });
    expect((read.data as { content: string }).content).toBe('one');
  });

  test('returns a failed result for unknown tools', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-unknown-tool',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });

    const result = await sandbox.tools.run('missing_tool', {});

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Unknown sandbox tool');
  });

  test('captures failed tool results and emits an error event', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-tool-error',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });
    const events: string[] = [];
    sandbox.on((event) => events.push(event.type));

    const result = await sandbox.tools.run('read', { path: 'missing.txt' });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('read failed');
    expect(events).toContain('tool:finish');
    expect(events).toContain('error');
  });

  test('emits chronological tool and file events', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-events',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });
    const events: string[] = [];
    sandbox.on((event) => events.push(event.type));

    await sandbox.tools.run('write', { path: 'events.txt', content: 'eventful' });

    expect(events).toContain('tool:start');
    expect(events).toContain('file');
    expect(events).toContain('tool:finish');
    expect(events.indexOf('tool:start')).toBeLessThan(events.indexOf('tool:finish'));
  });

  test('emits checkpoint create and restore events in order', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-checkpoint-events',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });
    const events: string[] = [];
    sandbox.on((event) => events.push(event.type));

    await sandbox.tools.run('write', { path: 'events.txt', content: 'one' });
    const checkpoint = await sandbox.checkpoints.create('before edit');
    await sandbox.tools.run('write', { path: 'events.txt', content: 'two' });
    await sandbox.checkpoints.restore(checkpoint.id);

    expect(events).toContain('checkpoint:create');
    expect(events).toContain('checkpoint:restore');
    expect(events.indexOf('checkpoint:create')).toBeLessThan(events.indexOf('checkpoint:restore'));
  });

  test('installs standard tools by default', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-default-tools',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });

    expect(sandbox.tools.get('write')).toBeDefined();
    expect(sandbox.tools.list.map((tool) => tool.name)).toContain('bash');
  });
});
