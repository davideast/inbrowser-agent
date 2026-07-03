import type { SandboxFileEvent, SandboxSnapshot } from '@inbrowser/sandbox';
import { createMemoryFileSystem } from '@inbrowser/workspace/fs';
import type {
  ContainerSandboxProvider,
  ContainerSession,
  ContainerSessionOptions,
} from './types.js';

export function createFakeContainerProvider(): ContainerSandboxProvider {
  return {
    kind: 'fake',
    async ensureReady() {},
    async diagnose() {
      return {
        providerKind: 'fake',
        state: 'ready',
        runtimeAvailable: true,
        systemReady: true,
        message: 'Fake provider is ready',
        checkedAt: Date.now(),
      };
    },
    async cleanupStaleSessions() {},
    async createSession(options) {
      return createFakeContainerSession(options);
    },
  };
}

async function createFakeContainerSession(
  options: ContainerSessionOptions,
): Promise<ContainerSession> {
  const fs = createMemoryFileSystem({ root: '/' });
  const listeners = new Set<(event: SandboxFileEvent) => void>();
  await fs.promises.mkdir(options.root, { recursive: true });

  function emit(event: Omit<SandboxFileEvent, 'timestamp'>) {
    const full = { ...event, timestamp: Date.now() };
    for (const listener of Array.from(listeners)) listener(full);
  }

  return {
    id: options.id,
    root: options.root,
    async run(command, runOptions) {
      const cwd = runOptions?.cwd ?? options.root;
      const chunks = [
        `fake:${cwd}$ ${command}\n`,
        'pulling basic image metadata\n',
        'starting demo container\n',
        'streaming line 1 from container stdout\n',
        'streaming line 2 from container stdout\n',
        'container exited 0\n',
      ];
      for (const chunk of chunks) {
        runOptions?.onOutput?.({ stream: 'stdout', chunk });
        await Bun.sleep(120);
      }
      return {
        stdout: chunks.join(''),
        stderr: '',
        exitCode: 0,
        cwd,
        durationMs: chunks.length * 120,
      };
    },
    readFile(path) {
      return fs.promises.readFile(path);
    },
    async writeFile(path, data) {
      await fs.promises.writeFile(path, data);
      emit({ type: 'write', path });
    },
    async mkdir(path, mkdirOptions) {
      await fs.promises.mkdir(path, mkdirOptions);
      emit({ type: 'mkdir', path });
    },
    readdir(path, readdirOptions) {
      return readdirOptions?.withFileTypes
        ? fs.promises.readdir(path, { withFileTypes: true })
        : fs.promises.readdir(path);
    },
    stat(path) {
      return fs.promises.stat(path);
    },
    lstat(path) {
      return fs.promises.lstat(path);
    },
    async unlink(path) {
      await fs.promises.unlink(path);
      emit({ type: 'delete', path });
    },
    async rmdir(path, rmdirOptions) {
      await fs.promises.rmdir(path, rmdirOptions);
      emit({ type: 'delete', path });
    },
    async rename(from, to) {
      await fs.promises.rename(from, to);
      emit({ type: 'rename', path: from, targetPath: to });
    },
    snapshot(root) {
      return fs.snapshot(root ?? options.root);
    },
    restore(snapshot: SandboxSnapshot, restoreOptions) {
      return fs.restore(snapshot, restoreOptions);
    },
    watch(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    async exposePort(port, exposeOptions) {
      const host = exposeOptions?.host ?? '127.0.0.1';
      const targetUrl = host.startsWith('http') ? host : `http://${host}:${port}`;
      return { id: `fake-port-${port}`, port, host, targetUrl };
    },
    async dispose() {
      listeners.clear();
    },
  };
}
