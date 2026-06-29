import { describe, expect, test } from 'bun:test';
import { createBrowserWorkspace } from '../src/index.js';

describe('createBrowserWorkspace', () => {
  test('creates an explicit memory-backed workspace in headless tests', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'local',
      root: '/work',
      storage: 'memory',
    });

    await workspace.fs.promises.writeFile('/work/src/App.tsx', 'export default function App() {}');

    expect(workspace.storageStatus).toBe('memory');
    expect(await workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8')).toContain('App');
    expect(workspace.createGit).toBeDefined();
    expect(workspace.createShell).toBeDefined();
    expect(workspace.createReactPreview).toBeDefined();
  });

  test('reports empty git state before a repository is initialized', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'git-empty',
      root: '/work',
      storage: 'memory',
    });

    await workspace.fs.promises.writeFile('/work/src/App.tsx', 'export default function App() {}');

    const git = await workspace.createGit();

    expect(await git.currentBranch()).toBeNull();
    expect(await git.status()).toEqual([]);
    expect(await git.log({ depth: 4 })).toEqual([]);
    expect(await git.listFiles()).toEqual([]);
    await expect(git.stageAll()).resolves.toBeUndefined();
  });

  test('initializes git and commits workspace files', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'git-commit',
      root: '/work',
      storage: 'memory',
    });

    await workspace.fs.promises.writeFile('/work/src/App.tsx', 'export default function App() {}');

    const git = await workspace.createGit();
    await git.init();
    expect(await git.currentBranch()).toBe('main');

    await git.stageAll();
    const oid = await git.commit({
      message: 'Initial workspace commit',
      authorName: 'Inbrowser Examples',
      authorEmail: 'examples@inbrowser.local',
    });

    expect(oid).toHaveLength(40);
    expect(await git.status()).toEqual([]);
    expect(await git.listFiles()).toEqual(['src/App.tsx']);
    expect((await git.log({ depth: 1 }))[0]?.message.trim()).toBe('Initial workspace commit');
  });

  test('creates and restores durable workspace snapshots without erasing git history', async () => {
    const workspace = await createBrowserWorkspace({
      id: 'snapshots-git',
      root: '/work',
      storage: 'memory',
    });

    await workspace.fs.promises.writeFile('/work/src/App.tsx', 'export const title = "one";');
    const git = await workspace.createGit();
    await git.init();
    await git.stageAll();
    await git.commit({
      message: 'Initial workspace commit',
      authorName: 'Inbrowser Examples',
      authorEmail: 'examples@inbrowser.local',
    });

    const snapshot = await workspace.snapshots.create({ label: 'before edit' });
    expect(snapshot.label).toBe('before edit');
    expect(snapshot.entryCount).toBeGreaterThan(0);
    expect(await workspace.snapshots.get(snapshot.id)).toEqual(snapshot);
    expect(await workspace.snapshots.list()).toEqual([snapshot]);

    await workspace.fs.promises.writeFile('/work/src/App.tsx', 'export const title = "two";');
    await workspace.fs.promises.writeFile('/work/src/extra.ts', 'export const extra = true;');

    await workspace.snapshots.restore(snapshot.id);

    expect(await workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8')).toContain('one');
    await expect(workspace.fs.promises.readFile('/work/src/extra.ts', 'utf8')).rejects.toThrow(
      /No such file|ENOENT/,
    );
    expect((await git.log({ depth: 1 }))[0]?.message.trim()).toBe('Initial workspace commit');
    expect(await git.status()).toEqual([]);
  });
});
