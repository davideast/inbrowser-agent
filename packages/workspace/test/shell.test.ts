import { describe, expect, test } from 'bun:test';
import { createMemoryFileSystem } from '../src/fs/index.js';

describe('workspace shell', () => {
  test('executes commands against the workspace fs and persists cwd', async () => {
    let shellModule: typeof import('../src/shell/index.js');
    try {
      shellModule = await import('../src/shell/index.js');
    } catch (err) {
      if (String(err).includes('just-bash')) return;
      throw err;
    }
    const fs = createMemoryFileSystem({ root: '/work' });
    await fs.promises.writeFile('/work/package.json', '{}');
    const shell = shellModule.createWorkspaceShell({ fs, root: '/work' });

    const first = await shell.exec('pwd && ls');
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('/work');
    expect(first.stdout).toContain('package.json');

    const second = await shell.exec('mkdir -p src && cd src && pwd');
    expect(second.cwd).toBe('/work/src');
  });
});
