import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import {
  BRIDGE_PATH,
  type BridgeHostSocket,
  DEFAULT_BRIDGE_HOSTNAME,
  DEFAULT_BRIDGE_PORT,
  createBridgeHostCore,
} from '../host/core.js';
import type {
  BridgeHostAdapter,
  BridgeHostAdapterFactory,
  BridgeHostServer,
  BridgeHostServerOptions,
} from '../host/types.js';
export { createNodeCommandRunner } from './command.js';

export async function startNodeBridgeHostServer(
  options: BridgeHostServerOptions,
): Promise<BridgeHostServer> {
  const hostname = options.hostname ?? DEFAULT_BRIDGE_HOSTNAME;
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const core = createBridgeHostCore({
    ...options,
    hostKind: 'node',
    bridgeOrigin: () => `http://${hostname}:${currentPort()}`,
  });
  let stopped = false;

  httpServer.on('request', (req, res) => {
    void handleRequest(req, res);
  });
  httpServer.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head);
  });
  wss.on('connection', (ws) => {
    const hostSocket = ws as unknown as BridgeHostSocket;
    ws.on('message', (message) => {
      void core.handleSocketMessage(hostSocket, message);
    });
    ws.on('close', () => {
      void core.closeSocket(hostSocket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen({ host: hostname, port: options.port ?? DEFAULT_BRIDGE_PORT });
  });

  return {
    host: hostname,
    get port() {
      return currentPort();
    },
    bridgeToken: core.bridgeToken,
    get bridgeOrigin() {
      return `http://${hostname}:${currentPort()}`;
    },
    bridgeUrl: core.bridgePath,
    statusUrl: core.statusPath,
    closeSessions: core.closeSessions,
    hostStatus: () => core.hostStatus(false),
    async stop() {
      await core.closeSessions();
      if (stopped) return;
      stopped = true;
      for (const client of wss.clients) client.close(1001, 'bridge host stopped');
      await Promise.all([closeWebSocketServer(wss), closeHttpServer(httpServer)]);
    },
  };

  function currentPort(): number {
    const address = httpServer.address();
    if (address && typeof address === 'object') return address.port;
    return options.port ?? DEFAULT_BRIDGE_PORT;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      const response = await core.handleHttpRequest(toFetchRequest(req, hostname, currentPort()));
      await writeResponse(res, response);
    } catch (err) {
      await writeResponse(
        res,
        new Response(err instanceof Error ? err.message : String(err), { status: 500 }),
      );
    }
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const request = toFetchRequest(req, hostname, currentPort(), false);
    const url = new URL(request.url);
    if (url.pathname !== BRIDGE_PATH) {
      await writeSocketResponse(socket, new Response('Not found', { status: 404 }));
      return;
    }
    const rejection = core.authenticateBridgeRequest(request);
    if (rejection) {
      await writeSocketResponse(socket, rejection);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, req);
    });
  }
}

export const nodeBridgeHostAdapterFactory: BridgeHostAdapterFactory = {
  kind: 'node',
  priority: 90,
  async detect() {
    return typeof process === 'undefined'
      ? { available: false, reason: 'Node-compatible process runtime is not available' }
      : { available: true };
  },
  create() {
    return {
      kind: 'node',
      start: startNodeBridgeHostServer,
    } satisfies BridgeHostAdapter;
  },
};

function toFetchRequest(
  req: IncomingMessage,
  hostname: string,
  port: number,
  includeBody = true,
): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const host = req.headers.host ?? `${hostname}:${port}`;
  const url = new URL(req.url ?? '/', `http://${host}`);
  const init: RequestInit = {
    method: req.method,
    headers,
  };
  if (includeBody && req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    (init as RequestInit & { duplex: 'half' }).duplex = 'half';
  }
  return new Request(url, init);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, response.statusText, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

async function writeSocketResponse(socket: Duplex, response: Response): Promise<void> {
  const body = await response.text();
  const statusText = response.statusText || 'Rejected';
  const headers = new Headers(response.headers);
  headers.set('content-length', String(Buffer.byteLength(body)));
  headers.set('connection', 'close');
  const lines = [`HTTP/1.1 ${response.status} ${statusText}`];
  headers.forEach((value, key) => {
    lines.push(`${key}: ${value}`);
  });
  socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
  socket.destroy();
}

function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    wss.close((err) => (err ? reject(err) : resolve()));
  });
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
