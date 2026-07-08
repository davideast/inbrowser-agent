import { describe, expect, test } from 'bun:test';
import { createAppleContainerProvider } from '../src/remote/apple-container/index.js';
import { startBunBridgeHostServer } from '../src/remote/bun/index.js';
import {
  type ContainerProviderFactory,
  type ContainerRunOptions,
  type ContainerSandboxProvider,
  type ContainerSession,
  type ContainerSessionOptions,
  type HostCommandRunner,
  startRemoteContainerBridge,
} from '../src/remote/host/index.js';
import {
  REMOTE_PROTOCOL_TYPES,
  createRemoteSandbox,
  createWebSocketBridgeProvider,
} from '../src/remote/index.js';
import { startNodeBridgeHostServer } from '../src/remote/node/index.js';
import type { SandboxSnapshot, SandboxStats } from '../src/types.js';

const hostStarters = [
  { kind: 'bun', start: startBunBridgeHostServer },
  { kind: 'node', start: startNodeBridgeHostServer },
] as const;

describe('remote bridge host servers', () => {
  for (const host of hostStarters) {
    test(`${host.kind} host authenticates and streams output through createRemoteSandbox`, async () => {
      const state = createTrackingProvider();
      const server = await host.start({
        provider: state.provider,
        port: 0,
        token: `${host.kind}-bridge-token`,
        uiUrl: 'http://127.0.0.1:5184',
      });
      try {
        expect(state.ensureReadyCalls).toBe(0);

        const root = await fetch(server.bridgeOrigin, { redirect: 'manual' });
        expect(root.status).toBe(302);
        expect(root.headers.get('location')).toBe('http://127.0.0.1:5184');

        const configResponse = await fetch(`${server.bridgeOrigin}/bridge-config`);
        const config = (await configResponse.json()) as {
          provider: string;
          host: string;
          token: string;
          bridgeUrl: string;
        };
        expect(config.provider).toBe('package-test');
        expect(config.host).toBe(host.kind);
        expect(config.token).toBe(`${host.kind}-bridge-token`);

        const sandbox = await createRemoteSandbox({
          id: `${host.kind}-host-stream-test`,
          transport: createWebSocketBridgeProvider({
            url: `ws://127.0.0.1:${server.port}${config.bridgeUrl}`,
            token: config.token,
          }),
          requestTimeoutMs: 1_000,
        });
        const chunks: string[] = [];
        sandbox.on((event) => {
          if (event.type === 'artifact' && event.artifact.kind === 'run.output') {
            chunks.push(String(event.artifact.chunk));
          }
        });

        const result = await sandbox.runtime.run('printf "hello"');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('host stdout');
        expect(chunks.join('')).toContain('host stdout');
        expect(state.ensureReadyCalls).toBe(1);
        expect(state.createdSessions).toEqual([`${host.kind}-host-stream-test`]);

        sandbox.destroy();
        await waitFor(() => state.disposedSessions.includes(`${host.kind}-host-stream-test`));
      } finally {
        await server.stop();
      }
    });

    test(`${host.kind} host proxies exposed provider ports through authenticated URLs`, async () => {
      const upstream = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          return new Response(`proxied:${url.pathname}${url.search}`);
        },
      });
      const state = createTrackingProvider({
        targetUrlForPort: () => `http://127.0.0.1:${upstream.port}`,
      });
      const server = await host.start({
        provider: state.provider,
        port: 0,
        token: `${host.kind}-port-token`,
      });
      const sessionId = `${host.kind}-host-port-test`;
      const connection = await createWebSocketBridgeProvider({
        url: `ws://127.0.0.1:${server.port}/bridge`,
        token: server.bridgeToken,
      }).connect({ sessionId, role: 'browser' });

      try {
        await connection.request({
          id: 'session-create',
          sessionId,
          type: REMOTE_PROTOCOL_TYPES.sessionCreate,
          payload: { root: '/work' },
        });
        const exposed = await connection.request<{ url: string }>({
          id: 'port-expose',
          sessionId,
          type: REMOTE_PROTOCOL_TYPES.portExpose,
          payload: { port: upstream.port, host: '127.0.0.1' },
        });

        const missingToken = new URL(exposed.payload.url);
        missingToken.searchParams.delete('token');
        expect((await fetch(missingToken)).status).toBe(401);

        const forwarded = new URL(exposed.payload.url);
        forwarded.pathname = `${forwarded.pathname}hello`;
        forwarded.searchParams.set('q', '1');
        expect(await (await fetch(forwarded)).text()).toBe('proxied:/hello?q=1');

        await connection.close('test complete');
        await waitFor(() => state.disposedSessions.includes(sessionId));
      } finally {
        await connection.close('cleanup');
        await server.stop();
        upstream.stop(true);
      }
    });
  }
});

describe('startRemoteContainerBridge', () => {
  test('starts with an explicit provider instance and returns a ready WebSocket provider', async () => {
    const state = createTrackingProvider();
    const bridge = await startRemoteContainerBridge({
      image: 'ubuntu:latest',
      provider: state.provider,
      host: 'bun',
      port: 0,
      token: 'high-level-token',
    });
    try {
      expect(bridge.provider).toBe('package-test');
      expect(bridge.host).toBe('bun');
      expect(bridge.clientConfig()).toMatchObject({
        provider: 'package-test',
        host: 'bun',
        token: 'high-level-token',
        bridgeUrl: '/bridge',
        statusUrl: '/status',
        root: '/work',
      });

      const sandbox = await createRemoteSandbox({
        id: 'high-level-session',
        transport: bridge.createWebSocketProvider(),
        requestTimeoutMs: 1_000,
      });
      const result = await sandbox.runtime.run('echo high-level');
      expect(result.exitCode).toBe(0);
      sandbox.destroy();
      await waitFor(() => state.disposedSessions.includes('high-level-session'));
    } finally {
      await bridge.stop();
    }
  });

  test('auto host resolution chooses Bun when running under Bun', async () => {
    const state = createTrackingProvider();
    const bridge = await startRemoteContainerBridge({
      image: 'ubuntu:latest',
      provider: state.provider,
      port: 0,
    });
    try {
      expect(bridge.host).toBe('bun');
    } finally {
      await bridge.stop();
    }
  });

  test('auto provider resolution selects Apple when command detection succeeds', async () => {
    const runner = createScriptedAppleRunner();
    const bridge = await startRemoteContainerBridge({
      image: 'ubuntu:latest',
      provider: 'auto',
      host: 'bun',
      port: 0,
      commandRunner: runner,
    });
    try {
      expect(bridge.provider).toBe('apple-container');
    } finally {
      await bridge.stop();
    }
  });

  test('auto provider resolution reports checked providers when none are available', async () => {
    await expect(
      startRemoteContainerBridge({
        image: 'ubuntu:latest',
        provider: 'auto',
        host: 'bun',
        commandRunner: {
          async run() {
            throw new Error('container command not found');
          },
        },
      }),
    ).rejects.toThrow('No remote container provider available');
  });

  test('explicit string providers and hosts must match registered factories', async () => {
    const unavailableProvider: ContainerProviderFactory = {
      kind: 'unavailable-test',
      priority: 200,
      async detect() {
        return { available: false, reason: 'test provider disabled' };
      },
      create() {
        throw new Error('should not create');
      },
    };

    await expect(
      startRemoteContainerBridge({
        image: 'ubuntu:latest',
        provider: 'unavailable-test',
        host: 'bun',
        providers: [unavailableProvider],
      }),
    ).rejects.toThrow('test provider disabled');
  });
});

describe('apple container provider', () => {
  test('uses an injected command runner for lifecycle, streaming, and cleanup', async () => {
    const runner = createScriptedAppleRunner();
    const provider = createAppleContainerProvider({
      image: 'ubuntu:latest',
      commandRunner: runner,
      maxBufferedOutputChars: 4,
    });

    await provider.ensureReady();
    const session = await provider.createSession({ id: 'active', root: '/work' });
    const chunks: string[] = [];
    const result = await session.run('printf "streamed"', {
      onOutput(output) {
        chunks.push(`${output.stream}:${output.chunk}`);
      },
    });
    await provider.cleanupStaleSessions();
    expect(runner.deletedNames.filter((name) => name === 'inbrowser-active')).toHaveLength(1);
    await session.dispose();

    expect(result.stdout).toBe('streamed');
    expect(chunks).toContain('stdout:streamed');
    expect(runner.calls.some((call) => call.maxBufferedOutputChars === 4)).toBe(true);
    expect(runner.deletedNames).toContain('inbrowser-stale');
    expect(runner.deletedNames).toContain('inbrowser-active');
    expect(runner.deletedNames.filter((name) => name === 'inbrowser-active')).toHaveLength(2);
  });
});

function createTrackingProvider(
  options: {
    targetUrlForPort?: (port: number, host: string) => string;
  } = {},
): {
  provider: ContainerSandboxProvider;
  readonly ensureReadyCalls: number;
  readonly createdSessions: readonly string[];
  readonly disposedSessions: readonly string[];
} {
  let ensureReadyCalls = 0;
  const createdSessions: string[] = [];
  const disposedSessions: string[] = [];

  return {
    get ensureReadyCalls() {
      return ensureReadyCalls;
    },
    get createdSessions() {
      return createdSessions;
    },
    get disposedSessions() {
      return disposedSessions;
    },
    provider: {
      kind: 'package-test',
      async ensureReady() {
        ensureReadyCalls += 1;
      },
      async diagnose() {
        return {
          providerKind: 'package-test',
          state: ensureReadyCalls > 0 ? 'ready' : 'idle',
          runtimeAvailable: true,
          systemReady: ensureReadyCalls > 0,
          checkedAt: Date.now(),
        };
      },
      async cleanupStaleSessions() {},
      async createSession(sessionOptions) {
        createdSessions.push(sessionOptions.id);
        return createTestSession(sessionOptions, {
          targetUrlForPort: options.targetUrlForPort,
          onDispose() {
            disposedSessions.push(sessionOptions.id);
          },
        });
      },
    },
  };
}

function createTestSession(
  options: ContainerSessionOptions,
  hooks: {
    targetUrlForPort?: (port: number, host: string) => string;
    onDispose(): void;
  },
): ContainerSession {
  return {
    id: options.id,
    root: options.root,
    async run(command: string, runOptions?: ContainerRunOptions) {
      const cwd = runOptions?.cwd ?? options.root;
      const chunks = [`host stdout: ${command}\n`, 'host stdout: done\n'];
      for (const chunk of chunks) {
        runOptions?.onOutput?.({ stream: 'stdout', chunk });
        await Bun.sleep(1);
      }
      return {
        stdout: chunks.join(''),
        stderr: '',
        exitCode: 0,
        cwd,
        durationMs: 2,
      };
    },
    async readFile() {
      return new Uint8Array();
    },
    async writeFile() {},
    async mkdir() {},
    async readdir() {
      return [];
    },
    async stat() {
      return testStats();
    },
    async lstat() {
      return testStats();
    },
    async unlink() {},
    async rmdir() {},
    async rename() {},
    async snapshot(root = options.root): Promise<SandboxSnapshot> {
      return { root, entries: [], createdAt: Date.now() };
    },
    async restore() {},
    watch() {
      return () => {};
    },
    async exposePort(port, exposeOptions) {
      const host = exposeOptions?.host ?? '127.0.0.1';
      return {
        id: `test-port-${port}`,
        port,
        host,
        targetUrl: hooks.targetUrlForPort?.(port, host) ?? `http://${host}:${port}`,
      };
    },
    async dispose() {
      hooks.onDispose();
    },
  };
}

function createScriptedAppleRunner(): HostCommandRunner & {
  calls: Array<{ args: readonly string[]; maxBufferedOutputChars?: number }>;
  deletedNames: string[];
} {
  const calls: Array<{ args: readonly string[]; maxBufferedOutputChars?: number }> = [];
  const deletedNames: string[] = [];
  const runner: HostCommandRunner & {
    calls: Array<{ args: readonly string[]; maxBufferedOutputChars?: number }>;
    deletedNames: string[];
  } = {
    calls,
    deletedNames,
    async run(args, options = {}) {
      calls.push({ args, maxBufferedOutputChars: options.maxBufferedOutputChars });
      const [bin, command, ...rest] = args;
      if (bin !== 'container') return result('', `unknown command: ${args.join(' ')}`, 1);
      if (command === '--version') return result('container 1.0.0\n');
      if (command === 'system' && rest[0] === 'start') return result('');
      if (command === 'list') return result('inbrowser-active inbrowser-stale unrelated\n');
      if (command === 'stop' || command === 'delete') {
        if (command === 'delete' && rest[0]) deletedNames.push(String(rest[0]));
        return result('');
      }
      if (command === 'run') return result('');
      if (command === 'exec') {
        const shellCommand = String(rest.at(-1) ?? '');
        if (shellCommand.includes('printf "streamed"')) {
          options.onOutput?.({ stream: 'stdout', chunk: 'streamed' });
          return result('streamed');
        }
        if (shellCommand.includes('mkdir -p')) return result('');
        return result('');
      }
      return result('');
    },
  };
  return runner;
}

function result(stdout: string, stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode, stdoutTruncated: false, stderrTruncated: false };
}

function testStats(): SandboxStats {
  return {
    type: 'file',
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isFile: () => true,
    isDirectory: () => false,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error('Timed out waiting for condition');
    await Bun.sleep(10);
  }
}
