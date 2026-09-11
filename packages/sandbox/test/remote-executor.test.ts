import { describe, expect, test } from 'bun:test';
import { type BridgePrincipal, createBridgeExecutor } from '../src/remote/host/executor.js';
import { trackingProvider } from './helpers/container.js';

function setup(run?: Parameters<typeof trackingProvider>[0]) {
  const tracked = trackingProvider(run);
  const executor = createBridgeExecutor({
    provider: tracked.provider,
    root: '/work',
    policy: { run: true, fs: 'rw' },
    requireRootedFileSystem: true,
  });
  const request = (
    type: string,
    payload: unknown = {},
    role: BridgePrincipal['role'] = 'developer',
    id = crypto.randomUUID(),
    admit?: () => Promise<void>,
  ) =>
    executor.dispatch(
      { id, kind: 'request', sessionId: 's', type, payload, sentAt: Date.now() },
      { sessionId: 's', principal: { uid: role, role }, admit },
      () => {},
    );
  return { ...tracked, executor, request };
}

describe('shared bridge execution', () => {
  test('reviewers attach to active sessions and read files without mutating or running', async () => {
    const t = setup();
    await expect(t.request('session.create', {}, 'reviewer')).rejects.toThrow('active session');
    await Promise.all([t.request('session.create'), t.request('session.create')]);
    expect(t.created).toHaveLength(1);
    await t.request('fs.write', { path: '/work/a.txt', content: 'hello' });
    expect(
      await t.request('fs.read', { path: '/work/a.txt', encoding: 'utf8' }, 'reviewer'),
    ).toMatchObject({ content: 'hello' });
    for (const op of [
      'run.start',
      'run.cancel',
      'fs.write',
      'fs.delete',
      'fs.restore',
      'session.destroy',
      'port.expose',
    ])
      await expect(t.request(op, {}, 'reviewer')).rejects.toThrow();
    expect(t.calls).toHaveLength(0);
    await t.executor.stop();
  });
  test('rejects root escapes and client capability escalation', async () => {
    const t = setup();
    expect(
      await t.request(
        'session.create',
        { root: '/etc', capabilities: { shell: true } },
        'developer',
      ),
    ).toMatchObject({ root: '/work' });
    await expect(t.request('fs.read', { path: '/work/../../etc/passwd' })).rejects.toThrow(
      'escapes',
    );
    await expect(
      t.request('fs.restore', { snapshot: { root: '/', entries: [] } }),
    ).rejects.toThrow();
    await t.executor.stop();
  });
  test('reauthorizes queued work and permits cancellation while a command runs', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const t = setup(async (_, options) => {
      started();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { stdout: '', stderr: 'cancelled', exitCode: 130 };
    });
    await t.request('session.create');
    const run = t.request('run.start', { command: 'wait' }, 'developer', 'run-one');
    await running;
    const queued = t.request(
      'fs.write',
      { path: '/work/blocked', content: 'bad' },
      'developer',
      'write-one',
      async () => {
        throw new Error('revoked');
      },
    );
    expect(await t.request('run.cancel', { requestId: 'run-one' })).toEqual({
      cancellationRequested: true,
    });
    await run;
    await expect(queued).rejects.toThrow('revoked');
    await expect(t.request('fs.read', { path: '/work/blocked' })).rejects.toThrow();
    await t.executor.stop();
  });
});

test('provider readiness precedes final admission so revocation cannot activate a container', async () => {
  const tracked = trackingProvider();
  let ready!: () => void;
  tracked.provider.ensureReady = () =>
    new Promise<void>((resolve) => {
      ready = resolve;
    });
  const executor = createBridgeExecutor({
    provider: tracked.provider,
    root: '/work',
    policy: { run: true, fs: 'rw' },
  });
  let revoked = false;
  const request = executor.dispatch(
    {
      id: 'slow-create',
      sessionId: 's',
      kind: 'request',
      type: 'session.create',
      payload: {},
      sentAt: Date.now(),
    },
    {
      sessionId: 's',
      principal: { uid: 'dev', role: 'developer' },
      async admit() {
        if (revoked) throw new Error('revoked');
      },
    },
    () => {},
  );
  await Bun.sleep(5);
  revoked = true;
  ready();
  await expect(request).rejects.toThrow('revoked');
  expect(tracked.created).toHaveLength(0);
  await executor.stop();
});
