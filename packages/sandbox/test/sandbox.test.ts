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

  test('records checkpoint metadata and supports filtered history queries', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-checkpoint-history',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });

    const beforeTurn = await sandbox.checkpoints.create({
      label: 'before turn',
      turnId: 'turn-1',
      reason: 'before-turn',
      summary: 'state before turn 1',
      metadata: { source: 'agent' },
    });
    const beforeTool = await sandbox.checkpoints.create({
      label: 'before write',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      reason: 'before-tool',
    });
    await sandbox.checkpoints.create({
      label: 'after turn',
      turnId: 'turn-2',
      reason: 'after-turn',
    });

    expect(beforeTurn.parentId).toBeUndefined();
    expect(beforeTool.parentId).toBe(beforeTurn.id);
    expect(beforeTurn.summary).toBe('state before turn 1');
    expect(beforeTurn.metadata).toEqual({ source: 'agent' });
    expect(sandbox.checkpoints.history().map((checkpoint) => checkpoint.label)).toEqual([
      'before turn',
      'before write',
      'after turn',
    ]);
    expect(
      sandbox.checkpoints.list({ turnId: 'turn-1' }).map((checkpoint) => checkpoint.id),
    ).toEqual([beforeTurn.id, beforeTool.id]);
    expect(sandbox.checkpoints.latest({ reason: 'before-tool' })?.id).toBe(beforeTool.id);
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

  test('restore event can be suppressed for internal recovery flows', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-checkpoint-restore-options',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });
    const events: string[] = [];
    sandbox.on((event) => events.push(event.type));

    await sandbox.tools.run('write', { path: 'restore.txt', content: 'one' });
    const checkpoint = await sandbox.checkpoints.create('before edit');
    await sandbox.tools.run('write', { path: 'restore.txt', content: 'two' });
    await sandbox.checkpoints.restore(checkpoint.id, { recordEvent: false });

    const read = await sandbox.tools.run('read', { path: 'restore.txt' });
    expect((read.data as { content: string }).content).toBe('one');
    expect(events).not.toContain('checkpoint:restore');
  });

  test('prunes checkpoint history and emits pruned checkpoints', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'sandbox-test-checkpoint-prune',
      storage: 'memory',
    });
    const sandbox = await createWorkspaceSandbox({ workspace });
    const prunedEvents: number[] = [];
    sandbox.on((event) => {
      if (event.type === 'checkpoint:prune') prunedEvents.push(event.checkpoints.length);
    });

    await sandbox.checkpoints.create({ label: 'tool 1', reason: 'before-tool' });
    await sandbox.checkpoints.create({ label: 'tool 2', reason: 'before-tool' });
    await sandbox.checkpoints.create({ label: 'tool 3', reason: 'before-tool' });
    await sandbox.checkpoints.create({ label: 'manual', reason: 'manual' });

    const pruned = sandbox.checkpoints.prune({ reason: 'before-tool', keepLatest: 1 });

    expect(pruned.map((checkpoint) => checkpoint.label)).toEqual(['tool 1', 'tool 2']);
    expect(sandbox.checkpoints.list().map((checkpoint) => checkpoint.label)).toEqual([
      'tool 3',
      'manual',
    ]);
    expect(prunedEvents).toEqual([2]);
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
