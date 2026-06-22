import { Bash, InMemoryFs, MountableFs } from 'just-bash';
import type { WorkspaceFileSystem } from '../fs/index.js';
import { isPathInside, normalizePath } from '../fs/index.js';
import { WorkspaceBashFileSystem } from './bash-fs.js';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
}

export interface ShellExecOptions {
  signal?: AbortSignal;
}

export interface WorkspaceShell {
  exec(command: string, options?: ShellExecOptions): Promise<ShellResult>;
  cwd(): string;
  setCwd(path: string): void;
}

export interface CreateWorkspaceShellOptions {
  fs: WorkspaceFileSystem;
  root: string;
  cwd?: string;
  builtins?: readonly unknown[];
}

export function createWorkspaceShell(options: CreateWorkspaceShellOptions): WorkspaceShell {
  const root = normalizePath(options.root);
  const mountPoint = root;
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [{ mountPoint, filesystem: new WorkspaceBashFileSystem(options.fs, root) }],
  });
  const bash = new Bash({ fs, cwd: options.cwd ?? root });
  for (const builtin of options.builtins ?? []) {
    (bash as { registerCommand(command: unknown): void }).registerCommand(builtin);
  }
  let cwd = normalizePath(options.cwd ?? root);

  return {
    cwd: () => cwd,
    setCwd(path) {
      const next = normalizePath(path);
      cwd = isPathInside(next, root) ? next : root;
    },
    async exec(command, execOptions) {
      const result = await bash.exec(command, {
        cwd,
        ...(execOptions?.signal ? { signal: execOptions.signal } : {}),
      });
      const next = result.env?.PWD ? normalizePath(result.env.PWD) : cwd;
      cwd = isPathInside(next, root) ? next : root;
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        cwd,
      };
    },
  };
}

export { WorkspaceBashFileSystem } from './bash-fs.js';
