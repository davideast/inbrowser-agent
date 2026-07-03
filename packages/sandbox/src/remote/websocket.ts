import { createBridgeConnection } from './connection.js';
import type { BridgeConnectOptions, BridgeEnvelope, BridgeTransportProvider } from './types.js';

export interface WebSocketBridgeProviderOptions {
  url: string | URL;
  token?: string | (() => Promise<string>);
  protocols?: string | string[];
  heartbeatMs?: number;
  WebSocketCtor?: typeof WebSocket;
}

export function createWebSocketBridgeProvider(
  options: WebSocketBridgeProviderOptions,
): BridgeTransportProvider {
  return {
    kind: 'websocket',
    async connect(connectOptions) {
      const url = await withConnectionParams(options.url, options, connectOptions);
      const WebSocketImpl = options.WebSocketCtor ?? WebSocket;
      const socket = new WebSocketImpl(url, options.protocols);
      await waitForOpen(socket, connectOptions.signal);
      const listeners = new Set<(envelope: BridgeEnvelope) => void>();
      const onMessage = (event: MessageEvent) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        const envelope = JSON.parse(data) as BridgeEnvelope;
        for (const listener of Array.from(listeners)) listener(envelope);
      };
      socket.addEventListener('message', onMessage);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (options.heartbeatMs && options.heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocketImpl.OPEN) {
            socket.send(
              JSON.stringify({
                id: `heartbeat-${Date.now().toString(36)}`,
                sessionId: connectOptions.sessionId,
                kind: 'ack',
                type: 'heartbeat',
                sentAt: Date.now(),
                peer: connectOptions.role,
                payload: {},
              } satisfies BridgeEnvelope),
            );
          }
        }, options.heartbeatMs);
      }
      return createBridgeConnection({
        sessionId: connectOptions.sessionId,
        role: connectOptions.role,
        transport: {
          async send(envelope) {
            if (socket.readyState !== WebSocketImpl.OPEN) {
              throw new Error('WebSocket bridge is not open');
            }
            socket.send(JSON.stringify(envelope));
          },
          subscribe(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
          },
          async close(reason) {
            if (heartbeat) clearInterval(heartbeat);
            socket.removeEventListener('message', onMessage);
            if (
              socket.readyState === WebSocketImpl.OPEN ||
              socket.readyState === WebSocketImpl.CONNECTING
            ) {
              socket.close(1000, reason);
            }
          },
        },
      });
    },
  };
}

async function withConnectionParams(
  input: string | URL,
  options: WebSocketBridgeProviderOptions,
  connectOptions: BridgeConnectOptions,
): Promise<string> {
  const url = new URL(String(input));
  url.searchParams.set('sessionId', connectOptions.sessionId);
  url.searchParams.set('role', connectOptions.role);
  if (connectOptions.resumeFromSeq !== undefined) {
    url.searchParams.set('resumeFromSeq', String(connectOptions.resumeFromSeq));
  }
  const token = typeof options.token === 'function' ? await options.token() : options.token;
  if (token) url.searchParams.set('token', token);
  if (connectOptions.auth?.type === 'bearer' || connectOptions.auth?.type === 'session') {
    url.searchParams.set('authToken', connectOptions.auth.token);
  }
  return url.toString();
}

function waitForOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('WebSocket bridge failed to connect'));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('WebSocket bridge connection aborted'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
