import { describe, expect, test } from 'bun:test';
import {
  createMemoryFileSystem,
  createScopedFileSystem,
  joinPath,
  normalizePath,
} from '../src/fs/index.js';

describe('memory file system', () => {
  test('reads, writes, lists, renames, snapshots, and restores files', async () => {
    const fs = createMemoryFileSystem({ root: '/work' });
    await fs.promises.writeFile('/work/src/App.tsx', 'export default function App() {}');

    expect(await fs.promises.readFile('/work/src/App.tsx', 'utf8')).toContain('App');
    expect(await fs.promises.readdir('/work/src')).toEqual(['App.tsx']);

    await fs.promises.rename('/work/src/App.tsx', '/work/src/main.tsx');
    expect(await fs.promises.readdir('/work/src')).toEqual(['main.tsx']);

    const snapshot = await fs.snapshot('/work');
    await fs.promises.unlink('/work/src/main.tsx');
    await fs.restore(snapshot, { clearRoot: true });

    expect(await fs.promises.readFile('/work/src/main.tsx', 'utf8')).toContain('App');
  });

  test('emits write events', async () => {
    const fs = createMemoryFileSystem({ root: '/work' });
    const events: string[] = [];
    const unwatch = fs.watch((event) => events.push(`${event.type}:${event.path}`));

    await fs.promises.writeFile('/work/package.json', '{}');
    unwatch();
    await fs.promises.writeFile('/work/ignored.txt', '');

    expect(events).toEqual(['write:/work/package.json']);
  });
});

describe('scoped file system', () => {
  test('maps virtual workspace paths onto isolated real storage', async () => {
    const base = createMemoryFileSystem({ root: '/' });
    const scoped = createScopedFileSystem(base, {
      virtualRoot: '/work',
      realRoot: '/sessions/a/work',
    });

    await scoped.promises.writeFile('/work/src/main.tsx', 'main');

    expect(await scoped.promises.readFile('/work/src/main.tsx', 'utf8')).toBe('main');
    expect(await base.promises.readFile('/sessions/a/work/src/main.tsx', 'utf8')).toBe('main');
    expect(await scoped.promises.readdir('/work/src')).toEqual(['main.tsx']);
  });
});

describe('path helpers', () => {
  test('normalizes posix paths', () => {
    expect(normalizePath('work/../work/src/./App.tsx')).toBe('/work/src/App.tsx');
    expect(joinPath('/work/', './src', '../package.json')).toBe('/work/package.json');
  });
});
