import { createMemoryFileSystem } from '@inbrowser/workspace/fs';
import type { ContainerRunOptions, ContainerSandboxProvider } from '../../src/remote/host/types.js';

export function trackingProvider(
  run?: (
    command: string,
    options?: ContainerRunOptions,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
) {
  const calls: string[] = [];
  const created: string[] = [];
  const disposed: string[] = [];
  const provider: ContainerSandboxProvider = {
    kind: 'test',
    async ensureReady() {},
    async cleanupStaleSessions() {},
    async createSession({ id, root }) {
      created.push(id);
      const fs = createMemoryFileSystem({ root });
      return {
        id,
        root,
        fileSystemIsolation: 'rooted',
        async run(command, options) {
          calls.push(command);
          if (run) return run(command, options);
          options?.onOutput?.({ stream: 'stdout', chunk: 'hello\n' });
          return { stdout: 'hello\n', stderr: '', exitCode: 0 };
        },
        readFile: (path) => fs.promises.readFile(path),
        writeFile: (path, bytes) => fs.promises.writeFile(path, bytes),
        mkdir: (path, opts) => fs.promises.mkdir(path, opts),
        readdir: (path, opts) =>
          opts?.withFileTypes
            ? fs.promises.readdir(path, { withFileTypes: true })
            : fs.promises.readdir(path),
        stat: (path) => fs.promises.stat(path),
        lstat: (path) => fs.promises.lstat(path),
        unlink: (path) => fs.promises.unlink(path),
        rmdir: (path, opts) => fs.promises.rmdir(path, opts),
        rename: (from, to) => fs.promises.rename(from, to),
        snapshot: (path) => fs.snapshot(path),
        restore: (snapshot, opts) => fs.restore(snapshot, opts),
        watch: (callback) => fs.watch(callback),
        async exposePort() {
          throw new Error('unsupported');
        },
        async dispose() {
          disposed.push(id);
        },
      };
    },
  };
  return { provider, calls, created, disposed };
}
