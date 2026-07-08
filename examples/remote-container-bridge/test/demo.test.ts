import { describe, expect, test } from 'bun:test';
import {
  type BridgeEnvelope,
  REMOTE_PROTOCOL_TYPES,
  createRemoteSandbox,
} from '@inbrowser/sandbox/remote';
import { startBridgeHostServer } from '@inbrowser/sandbox/remote/bun';
import { startRemoteContainerBridge } from '@inbrowser/sandbox/remote/host';
import { createFakeContainerProvider } from '../src/providers/fake.js';

describe('remote container bridge demo', () => {
  test('serves bridge config and streams run output over WebSocket', async () => {
    const server = await startBridgeHostServer({
      provider: createFakeContainerProvider(),
      port: 0,
      uiUrl: 'http://127.0.0.1:5184',
    });
    try {
      const root = await fetch(`http://127.0.0.1:${server.port}`, { redirect: 'manual' });
      expect(root.status).toBe(302);
      expect(root.headers.get('location')).toBe('http://127.0.0.1:5184');

      const configResponse = await fetch(`http://127.0.0.1:${server.port}/bridge-config`);
      const config = (await configResponse.json()) as {
        provider: string;
        token: string;
        bridgeUrl: string;
        statusUrl: string;
      };
      expect(config.provider).toBe('fake');
      expect(config.token).toBe(server.bridgeToken);
      expect(config.bridgeUrl).toBe('/bridge');

      const statusResponse = await fetch(
        `http://127.0.0.1:${server.port}${config.statusUrl}?token=${config.token}`,
      );
      const status = (await statusResponse.json()) as { status: { state: string } };
      expect(status.status.state).toBe('ready');

      const sessionId = `demo-test-${Date.now().toString(36)}`;
      const socket = new WebSocket(
        `ws://127.0.0.1:${server.port}${config.bridgeUrl}?sessionId=${sessionId}&role=browser&token=${config.token}`,
      );
      const pending = new Map<
        string,
        {
          resolve(value: unknown): void;
          reject(err: Error): void;
        }
      >();
      const chunks: string[] = [];
      let counter = 0;

      socket.addEventListener('message', (event) => {
        const envelope = JSON.parse(String(event.data)) as BridgeEnvelope;
        if (
          envelope.kind === 'event' &&
          (envelope.payload as never as { type?: string }).type === 'artifact'
        ) {
          const artifact = (envelope.payload as { artifact?: { kind?: string; chunk?: string } })
            .artifact;
          if (artifact?.kind === 'run.output' && artifact.chunk) chunks.push(artifact.chunk);
          return;
        }
        if ((envelope.kind === 'response' || envelope.kind === 'error') && envelope.replyTo) {
          const waiting = pending.get(envelope.replyTo);
          if (!waiting) return;
          pending.delete(envelope.replyTo);
          if (envelope.kind === 'error') {
            waiting.reject(new Error(String((envelope.payload as { message?: string }).message)));
          } else {
            waiting.resolve(envelope.payload);
          }
        }
      });

      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('websocket failed')), {
          once: true,
        });
      });

      const session = (await request(REMOTE_PROTOCOL_TYPES.sessionCreate, { root: '/work' })) as {
        root: string;
      };
      const result = (await request(REMOTE_PROTOCOL_TYPES.runStart, {
        command: 'for i in 1 2 3; do echo demo-$i; sleep 1; done',
        options: { cwd: session.root },
      })) as { exitCode: number };

      expect(result.exitCode).toBe(0);
      expect(chunks.join('')).toContain('streaming line 1');
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      socket.close();

      function request(type: string, payload: unknown): Promise<unknown> {
        counter += 1;
        const id = `demo-test-${counter}`;
        socket.send(
          JSON.stringify({
            id,
            sessionId,
            kind: 'request',
            type,
            sentAt: Date.now(),
            peer: 'browser',
            payload,
          } satisfies BridgeEnvelope),
        );
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
        });
      }
    } finally {
      await server.stop();
    }
  });

  test('rejects unauthenticated bridge upgrades and unexpected origins', async () => {
    const server = await startBridgeHostServer({
      provider: createFakeContainerProvider(),
      port: 0,
    });
    try {
      const missingToken = await fetch(`http://127.0.0.1:${server.port}/bridge`, {
        headers: { upgrade: 'websocket' },
      });
      expect(missingToken.status).toBe(401);

      const badOrigin = await fetch(
        `http://127.0.0.1:${server.port}/bridge?token=${server.bridgeToken}`,
        {
          headers: { upgrade: 'websocket', origin: 'http://evil.test' },
        },
      );
      expect(badOrigin.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  test('returns an authenticated proxy URL for exposed ports', async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response('proxied container response');
      },
    });
    const server = await startBridgeHostServer({
      provider: createFakeContainerProvider(),
      port: 0,
    });
    const sessionId = `port-test-${Date.now().toString(36)}`;
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/bridge?sessionId=${sessionId}&role=browser&token=${server.bridgeToken}`,
    );
    const pending = new Map<
      string,
      {
        resolve(value: unknown): void;
        reject(err: Error): void;
      }
    >();
    let counter = 0;

    socket.addEventListener('message', (event) => {
      const envelope = JSON.parse(String(event.data)) as BridgeEnvelope;
      if ((envelope.kind === 'response' || envelope.kind === 'error') && envelope.replyTo) {
        const waiting = pending.get(envelope.replyTo);
        if (!waiting) return;
        pending.delete(envelope.replyTo);
        if (envelope.kind === 'error') {
          waiting.reject(new Error(String((envelope.payload as { message?: string }).message)));
        } else {
          waiting.resolve(envelope.payload);
        }
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('websocket failed')), {
          once: true,
        });
      });
      await request(REMOTE_PROTOCOL_TYPES.sessionCreate, { root: '/work' });
      const exposed = (await request(REMOTE_PROTOCOL_TYPES.portExpose, {
        port: upstream.port,
        host: '127.0.0.1',
      })) as { url: string };

      const proxied = await fetch(exposed.url);
      expect(await proxied.text()).toBe('proxied container response');
    } finally {
      socket.close();
      await server.stop();
      upstream.stop(true);
    }

    function request(type: string, payload: unknown): Promise<unknown> {
      counter += 1;
      const id = `port-test-${counter}`;
      socket.send(
        JSON.stringify({
          id,
          sessionId,
          kind: 'request',
          type,
          sentAt: Date.now(),
          peer: 'browser',
          payload,
        } satisfies BridgeEnvelope),
      );
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    }
  });

  const appleIntegrationTest =
    process.env.INBROWSER_TEST_APPLE_CONTAINER === '1' ? test : test.skip;

  appleIntegrationTest(
    'streams output from a real Apple container and cleans up the session',
    async () => {
      const bridge = await startRemoteContainerBridge({
        image: process.env.REMOTE_CONTAINER_IMAGE ?? 'ubuntu:latest',
        provider: 'auto',
        host: 'bun',
        port: 0,
      });
      const chunks: string[] = [];

      try {
        expect(bridge.provider).toBe('apple-container');
        const sandbox = await createRemoteSandbox({
          id: `apple-test-${Date.now().toString(36)}`,
          transport: bridge.createWebSocketProvider(),
          requestTimeoutMs: 120_000,
        });
        sandbox.on((event) => {
          if (event.type === 'artifact' && event.artifact.kind === 'run.output') {
            chunks.push(String(event.artifact.chunk));
          }
        });
        const result = await sandbox.runtime.run('printf "real-bridge-stream\\n"');

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('real-bridge-stream');
        expect(chunks.join('')).toContain('real-bridge-stream');
        sandbox.destroy();
      } finally {
        await bridge.stop();
      }
    },
    120_000,
  );
});
