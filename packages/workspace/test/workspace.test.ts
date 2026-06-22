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
});
