import { describe, expect, test } from 'bun:test';
import { createBrowserWorkspace } from '@inbrowser/workspace';
import {
  createCheckpointManager,
  createStandardToolset,
  createWorkspaceSandbox,
} from '../src/index.js';

describe('workspace sandbox', () => {
  test('runs standard file tools against a browser workspace', async () => {
    const workspace = await createBrowserWorkspace({ id: 'sandbox-test-files', storage: 'memory' });
    const sandbox = await createWorkspaceSandbox({ workspace });
    const tools = createStandardToolset();

    const write = await tools.run(
      'write',
      { path: 'src/App.tsx', content: 'export default function App() { return "hello"; }\n' },
      sandbox,
    );
    expect(write.ok).toBe(true);

    const read = await tools.run('read', { path: 'src/App.tsx' }, sandbox);
    expect(read.ok).toBe(true);
    expect((read.data as { content: string }).content).toContain('hello');

    const grep = await tools.run('grep', { path: '.', query: 'hello' }, sandbox);
    expect(grep.ok).toBe(true);
    expect((grep.data as { matches: unknown[] }).matches).toHaveLength(1);
  });

  test('creates and restores checkpoints', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-checkpoints',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });
    const tools = createStandardToolset();
    const checkpoints = createCheckpointManager(sandbox);

    await tools.run('write', { path: 'notes.txt', content: 'one' }, sandbox);
    const checkpoint = await checkpoints.create('before edit');
    await tools.run('write', { path: 'notes.txt', content: 'two' }, sandbox);
    await checkpoints.restore(checkpoint.id);

    const read = await tools.run('read', { path: 'notes.txt' }, sandbox);
    expect((read.data as { content: string }).content).toBe('one');
  });

  test('emits chronological tool and file events', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-events',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });
    const tools = createStandardToolset();
    const events: string[] = [];
    sandbox.on((event) => events.push(event.type));

    await tools.run('write', { path: 'events.txt', content: 'eventful' }, sandbox);

    expect(events).toContain('tool:start');
    expect(events).toContain('file');
    expect(events).toContain('tool:finish');
    expect(events.indexOf('tool:start')).toBeLessThan(events.indexOf('tool:finish'));
  });
});
