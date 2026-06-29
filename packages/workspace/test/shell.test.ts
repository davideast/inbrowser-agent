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

  test('runs the workspace git command through shell builtins', async () => {
    let shellModule: typeof import('../src/shell/index.js');
    let gitModule: typeof import('../src/git/index.js');
    try {
      shellModule = await import('../src/shell/index.js');
      gitModule = await import('../src/git/index.js');
    } catch (err) {
      if (String(err).includes('just-bash')) return;
      throw err;
    }
    const fs = createMemoryFileSystem({ root: '/work' });
    await fs.promises.writeFile('/work/package.json', '{}');
    const git = gitModule.createWorkspaceGit({ fs, dir: '/work' });
    const shell = shellModule.createWorkspaceShell({
      fs,
      root: '/work',
      builtins: [shellModule.createWorkspaceGitCommand({ git, root: '/work' })],
    });

    const beforeInit = await shell.exec('git status');
    expect(beforeInit.exitCode).toBe(128);
    expect(beforeInit.stderr).toContain('run git init');

    const init = await shell.exec('git init');
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain('Initialized empty Git repository');

    const status = await shell.exec('git status --short');
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('A  package.json');

    const add = await shell.exec('git add .');
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain('staged 1 file');

    const commit = await shell.exec('git commit -m "Initial commit"');
    expect(commit.exitCode).toBe(0);
    expect(commit.stdout).toContain('Initial commit');

    const log = await shell.exec('git log --oneline');
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('Initial commit');

    const unsupported = await shell.exec('git push');
    expect(unsupported.exitCode).toBe(1);
    expect(unsupported.stderr).toContain('supported commands');
  });
});
