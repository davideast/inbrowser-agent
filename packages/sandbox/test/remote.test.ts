import { describe, expect, test } from 'bun:test';
import { createMemoryFileSystem, normalizePath } from '@inbrowser/workspace/fs';
import type {
  SandboxDirent,
  SandboxFileEvent,
  SandboxSnapshot,
  SandboxStats,
} from '../src/index.js';
import {
  createBridgeConnection,
  createRemoteSandbox,
  createWebSocketBridgeProvider,
} from '../src/remote/index.js';
import type {
  BridgeConnection,
  BridgeEnvelope,
  BridgeTransportProvider,
  RemoteBridgeEvent,
} from '../src/remote/index.js';
import { REMOTE_PROTOCOL_TYPES } from '../src/remote/types.js';

describe('remote bridge transport', () => {
  test('matches request and response envelopes', async () => {
    const pair = createLinkedConnections('req-match');
    pair.host.subscribe((envelope) => {
      if (envelope.kind !== 'request') return;
      void pair.host.send({
        id: 'response-1',
        sessionId: envelope.sessionId,
        kind: 'response',
        type: envelope.type,
        replyTo: envelope.id,
        sentAt: Date.now(),
        payload: { ok: true },
      });
    });

    const response = await pair.browser.request<{ ok: boolean }>({
      id: 'request-1',
      sessionId: pair.browser.sessionId,
      type: 'ping',
      payload: {},
    });

    expect(response.payload.ok).toBe(true);
  });

  test('rejects duplicate pending request ids', async () => {
    const pair = createLinkedConnections('duplicate');
    const first = pair.browser.request({
      id: 'same-id',
      sessionId: pair.browser.sessionId,
      type: 'slow',
      payload: {},
    });

    await expect(
      pair.browser.request({
        id: 'same-id',
        sessionId: pair.browser.sessionId,
        type: 'slow',
        payload: {},
      }),
    ).rejects.toThrow('already pending');

    void pair.host.send({
      id: 'response-duplicate',
      sessionId: pair.host.sessionId,
      kind: 'response',
      type: 'slow',
      replyTo: 'same-id',
      sentAt: Date.now(),
      payload: {},
    });
    await first;
  });

  test('times out unanswered requests', async () => {
    const pair = createLinkedConnections('timeout');

    await expect(
      pair.browser.request(
        {
          id: 'timeout-request',
          sessionId: pair.browser.sessionId,
          type: 'never',
          payload: {},
        },
        { timeoutMs: 1 },
      ),
    ).rejects.toThrow('timed out');
  });

  test('sends requests over WebSocket transport', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response('upgrade required', { status: 426 });
      },
      websocket: {
        message(ws, message) {
          const envelope = JSON.parse(String(message)) as BridgeEnvelope;
          if (envelope.kind !== 'request') return;
          ws.send(
            JSON.stringify({
              id: `response-${envelope.id}`,
              sessionId: envelope.sessionId,
              kind: 'response',
              type: envelope.type,
              replyTo: envelope.id,
              sentAt: Date.now(),
              payload: { pong: true },
            } satisfies BridgeEnvelope),
          );
        },
      },
    });
    try {
      const provider = createWebSocketBridgeProvider({
        url: `ws://127.0.0.1:${server.port}`,
      });
      const connection = await provider.connect({ sessionId: 'ws-test', role: 'browser' });

      const response = await connection.request<{ pong: boolean }>({
        id: 'ws-request',
        sessionId: 'ws-test',
        type: 'ping',
        payload: {},
      });

      expect(response.payload.pong).toBe(true);
      await connection.close();
    } finally {
      server.stop(true);
    }
  });

  test('passes WebSocket bridge token and auth token in connection params', async () => {
    let seenUrl: URL | undefined;
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        seenUrl = new URL(req.url);
        if (server.upgrade(req)) return;
        return new Response('upgrade required', { status: 426 });
      },
      websocket: {
        message(ws, message) {
          const envelope = JSON.parse(String(message)) as BridgeEnvelope;
          ws.send(
            JSON.stringify({
              id: `response-${envelope.id}`,
              sessionId: envelope.sessionId,
              kind: 'response',
              type: envelope.type,
              replyTo: envelope.id,
              sentAt: Date.now(),
              payload: { ok: true },
            } satisfies BridgeEnvelope),
          );
        },
      },
    });
    try {
      const provider = createWebSocketBridgeProvider({
        url: `ws://127.0.0.1:${server.port}`,
        token: 'bridge-token',
      });
      const connection = await provider.connect({
        sessionId: 'ws-auth-test',
        role: 'browser',
        auth: { type: 'bearer', token: 'auth-token' },
      });
      await connection.request({
        id: 'ws-auth-request',
        sessionId: 'ws-auth-test',
        type: 'ping',
        payload: {},
      });

      expect(seenUrl?.searchParams.get('token')).toBe('bridge-token');
      expect(seenUrl?.searchParams.get('authToken')).toBe('auth-token');
      await connection.close();
    } finally {
      server.stop(true);
    }
  });
});

describe('remote sandbox', () => {
  test('runs standard tools over a bridge transport', async () => {
    const provider = createFakeRemoteHostProvider();
    const sandbox = await createRemoteSandbox({
      id: 'remote-tools',
      transport: provider,
      requestTimeoutMs: 1_000,
    });

    const write = await sandbox.tools.run('write', {
      path: 'src/App.tsx',
      content: 'export default function App() { return "remote"; }\n',
    });
    expect(write.ok).toBe(true);

    const read = await sandbox.tools.run('read', { path: 'src/App.tsx' });
    expect(read.ok).toBe(true);
    expect((read.data as { content: string }).content).toContain('remote');

    const grep = await sandbox.tools.run('grep', { path: '.', query: 'remote' });
    expect(grep.ok).toBe(true);
    expect((grep.data as { matches: unknown[] }).matches).toHaveLength(1);

    const bash = await sandbox.tools.run('bash', { command: 'echo hello' });
    expect(bash.ok).toBe(true);
    expect((bash.data as { stdout: string }).stdout).toContain('echo hello');
  });

  test('propagates remote file events into sandbox events', async () => {
    const provider = createFakeRemoteHostProvider();
    const sandbox = await createRemoteSandbox({ id: 'remote-events', transport: provider });
    const events: string[] = [];
    sandbox.on((event) => events.push(event.type));

    await sandbox.tools.run('write', { path: 'events.txt', content: 'hello' });

    expect(events).toContain('tool:start');
    expect(events).toContain('file');
    expect(events).toContain('tool:finish');
  });

  test('propagates remote artifacts and ports into sandbox events', async () => {
    const provider = createFakeRemoteHostProvider();
    const sandbox = await createRemoteSandbox({ id: 'remote-streams', transport: provider });
    const artifacts: string[] = [];
    const ports: string[] = [];
    sandbox.on((event) => {
      if (event.type === 'artifact' && event.artifact.kind === 'run.output') {
        artifacts.push(String(event.artifact.chunk));
      }
      if (event.type === 'port') ports.push(event.port.url ?? '');
    });

    await sandbox.runtime.run('echo streamed');
    await sandbox.tools.run('bash', { command: 'echo tool-streamed' });

    expect(artifacts.join('')).toContain('streamed output');
    expect(ports).toContain('http://127.0.0.1:3000');
  });

  test('creates and restores checkpoints through the remote file system', async () => {
    const provider = createFakeRemoteHostProvider();
    const sandbox = await createRemoteSandbox({ id: 'remote-checkpoints', transport: provider });

    await sandbox.tools.run('write', { path: 'notes.txt', content: 'one' });
    const checkpoint = await sandbox.checkpoints.create('before edit');
    await sandbox.tools.run('write', { path: 'notes.txt', content: 'two' });
    await sandbox.checkpoints.restore(checkpoint.id);

    const read = await sandbox.tools.run('read', { path: 'notes.txt' });
    expect((read.data as { content: string }).content).toBe('one');
  });
});

function createLinkedConnections(sessionId: string): {
  browser: BridgeConnection;
  host: BridgeConnection;
} {
  const browserListeners = new Set<(envelope: BridgeEnvelope) => void>();
  const hostListeners = new Set<(envelope: BridgeEnvelope) => void>();
  const browser = createBridgeConnection({
    sessionId,
    role: 'browser',
    transport: {
      async send(envelope) {
        queueMicrotask(() => {
          for (const listener of Array.from(hostListeners)) listener(envelope);
        });
      },
      subscribe(callback) {
        browserListeners.add(callback);
        return () => browserListeners.delete(callback);
      },
      async close() {
        browserListeners.clear();
      },
    },
  });
  const host = createBridgeConnection({
    sessionId,
    role: 'host',
    transport: {
      async send(envelope) {
        queueMicrotask(() => {
          for (const listener of Array.from(browserListeners)) listener(envelope);
        });
      },
      subscribe(callback) {
        hostListeners.add(callback);
        return () => hostListeners.delete(callback);
      },
      async close() {
        hostListeners.clear();
      },
    },
  });
  return { browser, host };
}

function createFakeRemoteHostProvider(): BridgeTransportProvider {
  return {
    kind: 'fake',
    async connect(options) {
      const pair = createLinkedConnections(options.sessionId);
      const host = await createFakeHost(pair.host);
      pair.host.subscribe((envelope) => {
        if (envelope.kind === 'request') void host.handle(envelope);
      });
      return pair.browser;
    },
  };
}

async function createFakeHost(connection: BridgeConnection): Promise<{
  handle(envelope: BridgeEnvelope): Promise<void>;
}> {
  const fs = createMemoryFileSystem({ root: '/' });
  const root = '/work';
  let seq = 0;
  await fs.promises.mkdir(root, { recursive: true });

  async function sendResponse(envelope: BridgeEnvelope, payload: unknown) {
    await connection.send({
      id: `response-${envelope.id}`,
      sessionId: envelope.sessionId,
      kind: 'response',
      type: envelope.type,
      replyTo: envelope.id,
      sentAt: Date.now(),
      payload,
    });
  }

  async function sendFileEvent(event: Omit<SandboxFileEvent, 'timestamp'>) {
    const payload: RemoteBridgeEvent = {
      type: 'file',
      event: { ...event, timestamp: Date.now() },
    };
    seq += 1;
    await connection.send({
      id: `event-${seq}`,
      sessionId: connection.sessionId,
      kind: 'event',
      type: REMOTE_PROTOCOL_TYPES.event,
      seq,
      sentAt: Date.now(),
      payload,
    });
  }

  async function sendBridgeEvent(payload: RemoteBridgeEvent) {
    seq += 1;
    await connection.send({
      id: `event-${seq}`,
      sessionId: connection.sessionId,
      kind: 'event',
      type: REMOTE_PROTOCOL_TYPES.event,
      seq,
      sentAt: Date.now(),
      payload,
    });
  }

  return {
    async handle(envelope) {
      const payload = envelope.payload as Record<string, unknown>;
      switch (envelope.type) {
        case REMOTE_PROTOCOL_TYPES.sessionCreate:
          await sendResponse(envelope, {
            root,
            capabilities: { shell: true, persistentStorage: true },
          });
          break;
        case REMOTE_PROTOCOL_TYPES.fsRead: {
          const content = await fs.promises.readFile(remotePath(payload.path), 'utf8');
          await sendResponse(envelope, { path: payload.path, content, encoding: 'utf8' });
          break;
        }
        case REMOTE_PROTOCOL_TYPES.fsWrite:
          await fs.promises.writeFile(
            remotePath(payload.path),
            payload.encoding === 'base64' ? atob(String(payload.content)) : String(payload.content),
          );
          await sendFileEvent({ type: 'write', path: remotePath(payload.path) });
          await sendResponse(envelope, {});
          break;
        case REMOTE_PROTOCOL_TYPES.fsMkdir:
          await fs.promises.mkdir(remotePath(payload.path), {
            recursive: payload.recursive === true,
          });
          await sendFileEvent({ type: 'mkdir', path: remotePath(payload.path) });
          await sendResponse(envelope, {});
          break;
        case REMOTE_PROTOCOL_TYPES.fsList: {
          if (payload.withFileTypes === true) {
            const entries = await fs.promises.readdir(remotePath(payload.path), {
              withFileTypes: true,
            });
            await sendResponse(envelope, {
              entries: entries.map((entry) => ({
                name: entry.name,
                path: entry.path,
                type: entry.type,
              })),
            });
          } else {
            await sendResponse(envelope, {
              entries: await fs.promises.readdir(remotePath(payload.path)),
            });
          }
          break;
        }
        case REMOTE_PROTOCOL_TYPES.fsStat:
        case REMOTE_PROTOCOL_TYPES.fsLstat: {
          const stat = await fs.promises.stat(remotePath(payload.path));
          await sendResponse(envelope, toPlainStats(stat));
          break;
        }
        case REMOTE_PROTOCOL_TYPES.fsDelete:
          if (payload.recursive === true) {
            await fs.promises.rmdir(remotePath(payload.path), { recursive: true });
          } else {
            await fs.promises.unlink(remotePath(payload.path));
          }
          await sendFileEvent({ type: 'delete', path: remotePath(payload.path) });
          await sendResponse(envelope, {});
          break;
        case REMOTE_PROTOCOL_TYPES.fsRename:
          await fs.promises.rename(remotePath(payload.from), remotePath(payload.to));
          await sendFileEvent({
            type: 'rename',
            path: remotePath(payload.from),
            targetPath: remotePath(payload.to),
          });
          await sendResponse(envelope, {});
          break;
        case REMOTE_PROTOCOL_TYPES.fsSnapshot:
          await sendResponse(envelope, { snapshot: await fs.snapshot(root) });
          break;
        case REMOTE_PROTOCOL_TYPES.fsRestore:
          await fs.restore(payload.snapshot as SandboxSnapshot, { clearRoot: true });
          await sendResponse(envelope, {});
          break;
        case REMOTE_PROTOCOL_TYPES.runStart:
          await sendBridgeEvent({
            type: 'artifact',
            artifact: {
              kind: 'run.output',
              requestId: envelope.id,
              stream: 'stdout',
              chunk: 'streamed output\n',
            },
          });
          await sendBridgeEvent({
            type: 'port',
            port: { id: 'fake-port-3000', port: 3000, url: 'http://127.0.0.1:3000' },
          });
          await sendResponse(envelope, {
            stdout: `ran ${(payload as { command: string }).command}\n`,
            stderr: '',
            exitCode: 0,
            cwd: root,
            durationMs: 1,
          });
          break;
        case REMOTE_PROTOCOL_TYPES.portExpose:
          await sendBridgeEvent({
            type: 'port',
            port: { id: 'fake-port-3000', port: 3000, url: 'http://127.0.0.1:3000' },
          });
          await sendResponse(envelope, {
            id: 'fake-port-3000',
            port: 3000,
            url: 'http://127.0.0.1:3000',
          });
          break;
        case REMOTE_PROTOCOL_TYPES.runCancel:
          await sendResponse(envelope, {});
          break;
        default:
          await connection.send({
            id: `error-${envelope.id}`,
            sessionId: envelope.sessionId,
            kind: 'error',
            type: envelope.type,
            replyTo: envelope.id,
            sentAt: Date.now(),
            payload: { message: `Unhandled request: ${envelope.type}` },
          });
      }
    },
  };

  function remotePath(input: unknown): string {
    const path = normalizePath(String(input ?? root));
    return path.startsWith(root) ? path : normalizePath(`${root}/${path}`);
  }
}

function toPlainStats(stats: SandboxStats): Omit<SandboxStats, 'isFile' | 'isDirectory'> {
  return {
    type: stats.type,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}
