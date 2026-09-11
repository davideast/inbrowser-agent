import {
  type BridgeEnvelope,
  REMOTE_PROTOCOL_TYPES,
  type RemoteBridgeEvent,
  type RemoteHostDiagnostic,
  type RemoteHostStatusResponse,
} from '../types.js';
import { errorEnvelope, responseEnvelope } from './envelopes.js';
import { createBridgeExecutor } from './executor.js';
import type {
  BridgeHostServerOptions,
  ContainerExposedPort,
  ContainerSession,
  RemoteContainerBridgeClientConfig,
} from './types.js';

export const DEFAULT_BRIDGE_PORT = 8790;
export const DEFAULT_BRIDGE_HOSTNAME = '127.0.0.1';
export const DEFAULT_BRIDGE_ROOT = '/work';
export const BRIDGE_PATH = '/bridge';
export const STATUS_PATH = '/status';
export const BRIDGE_CONFIG_PATH = '/bridge-config';
export const PORT_PROXY_PREFIX = '/__inbrowser/ports/';

export interface BridgeHostSocket {
  send(message: string): unknown;
}

export interface BridgeHostCore {
  readonly bridgeToken: string;
  readonly root: string;
  readonly bridgePath: string;
  readonly statusPath: string;
  readonly bridgeConfigPath: string;
  readonly portProxyPrefix: string;
  clientConfig(): RemoteContainerBridgeClientConfig;
  authenticateBridgeRequest(req: Request): Response | undefined;
  handleHttpRequest(req: Request): Promise<Response>;
  handleSocketMessage(socket: BridgeHostSocket, message: unknown): Promise<void>;
  closeSocket(socket: BridgeHostSocket): Promise<void>;
  closeSessions(): Promise<void>;
  hostStatus(authenticated?: boolean): Promise<RemoteHostStatusResponse>;
}

interface PortRoute {
  sessionId: string;
  port: number;
  targetUrl: string;
}

export function createBridgeHostCore(
  options: BridgeHostServerOptions & {
    hostKind: string;
    bridgeOrigin(): string;
  },
): BridgeHostCore {
  const socketSessions = new WeakMap<BridgeHostSocket, Set<string>>();
  const seqBySession = new Map<string, number>();
  const portRoutes = new Map<string, PortRoute>();
  const root = options.root ?? DEFAULT_BRIDGE_ROOT;
  const bridgeToken = options.token ?? createBridgeToken();
  const executor = createBridgeExecutor({
    provider: options.provider,
    root,
    policy: { run: true, fs: 'rw' },
    exposePort: (session, envelope, emit) =>
      exposePort({
        session,
        envelope,
        emit,
        portRoutes,
        bridgeToken,
        publicOrigin: () => options.uiUrl ?? options.bridgeOrigin(),
        port: Number((envelope.payload as { port: number }).port),
        host: (envelope.payload as { host?: string }).host,
      }),
  });
  const allowedOrigins = options.allowedOrigins ?? uiOrigin(options.uiUrl);

  if (options.cleanupStaleSessions !== false) {
    void options.provider.cleanupStaleSessions?.().catch((err) => {
      console.warn(`remote container stale cleanup failed: ${errorMessage(err)}`);
    });
  }

  async function hostStatus(authenticated = false): Promise<RemoteHostStatusResponse> {
    return {
      provider: options.provider.kind,
      authenticated,
      status: await executor.status(),
    };
  }

  async function closeSessions() {
    await Promise.all(executor.sessionIds().map((id) => executor.dispose(id)));
    portRoutes.clear();
  }

  function clientConfig(): RemoteContainerBridgeClientConfig {
    return {
      provider: options.provider.kind,
      host: options.hostKind,
      token: bridgeToken,
      bridgeUrl: BRIDGE_PATH,
      statusUrl: STATUS_PATH,
      root,
    };
  }

  return {
    bridgeToken,
    root,
    bridgePath: BRIDGE_PATH,
    statusPath: STATUS_PATH,
    bridgeConfigPath: BRIDGE_CONFIG_PATH,
    portProxyPrefix: PORT_PROXY_PREFIX,
    clientConfig,
    authenticateBridgeRequest(req) {
      return authenticateBridgeRequest(req, { token: bridgeToken, allowedOrigins });
    },
    async handleHttpRequest(req) {
      const url = new URL(req.url);
      if (url.pathname === STATUS_PATH) {
        return jsonResponse(await hostStatus(hasValidToken(req, bridgeToken)));
      }
      if (url.pathname === BRIDGE_CONFIG_PATH) return jsonResponse(clientConfig());
      if (url.pathname.startsWith(PORT_PROXY_PREFIX)) {
        return proxyPortRequest(req, {
          token: bridgeToken,
          routes: portRoutes,
        });
      }
      if (options.uiUrl) return Response.redirect(options.uiUrl, 302);
      return new Response(
        'Remote container bridge host is running. Start a UI and connect to /bridge.',
        {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        },
      );
    },
    async handleSocketMessage(socket, message) {
      const envelope = JSON.parse(messageText(message)) as BridgeEnvelope;
      if (envelope.kind !== 'request') return;
      try {
        if (envelope.type === REMOTE_PROTOCOL_TYPES.sessionCreate) {
          const ids = socketSessions.get(socket) ?? new Set<string>();
          ids.add(envelope.sessionId);
          socketSessions.set(socket, ids);
        }
        const payload = await executor.dispatch(
          envelope,
          { sessionId: envelope.sessionId, principal: { uid: 'local-token', role: 'owner' } },
          (event) => sendEvent(socket, envelope.sessionId, seqBySession, event),
        );
        socket.send(JSON.stringify(responseEnvelope(envelope, payload)));
      } catch (err) {
        socket.send(JSON.stringify(errorEnvelope(envelope, err)));
      }
    },
    closeSocket(socket) {
      const ids = socketSessions.get(socket) ?? new Set<string>();
      socketSessions.delete(socket);
      for (const id of ids)
        for (const [key, route] of portRoutes) if (route.sessionId === id) portRoutes.delete(key);
      return Promise.all(Array.from(ids, (id) => executor.dispose(id))).then(() => undefined);
    },
    closeSessions,
    hostStatus,
  };
}

async function exposePort(options: {
  envelope: BridgeEnvelope;
  session: ContainerSession;
  portRoutes: Map<string, PortRoute>;
  publicOrigin(): string;
  bridgeToken: string;
  host?: string;
  port: number;
  emit: (event: RemoteBridgeEvent) => void;
}) {
  const exposed = await options.session.exposePort(options.port, {
    host: options.host,
  });
  const publicUrl = createPublicPortUrl({
    origin: options.publicOrigin(),
    sessionId: options.envelope.sessionId,
    port: options.port,
    token: options.bridgeToken,
  });
  const response: ContainerExposedPort = { ...exposed, url: publicUrl };
  if (exposed.targetUrl) {
    options.portRoutes.set(portRouteKey(options.envelope.sessionId, options.port), {
      sessionId: options.envelope.sessionId,
      port: options.port,
      targetUrl: exposed.targetUrl,
    });
  }
  options.emit({ type: 'port', port: response });
  return response;
}

function sendEvent(
  socket: BridgeHostSocket,
  sessionId: string,
  seqBySession: Map<string, number>,
  payload: RemoteBridgeEvent,
) {
  const seq = (seqBySession.get(sessionId) ?? 0) + 1;
  seqBySession.set(sessionId, seq);
  socket.send(
    JSON.stringify({
      id: `event-${sessionId}-${seq}`,
      sessionId,
      kind: 'event',
      type: REMOTE_PROTOCOL_TYPES.event,
      seq,
      sentAt: Date.now(),
      peer: 'host',
      payload,
    } satisfies BridgeEnvelope),
  );
}

function authenticateBridgeRequest(
  req: Request,
  options: { token: string; allowedOrigins?: readonly string[] },
): Response | undefined {
  if (!hasValidToken(req, options.token)) {
    return new Response('Bridge token required', { status: 401 });
  }
  if (!hasAllowedOrigin(req, options.allowedOrigins)) {
    return new Response('Bridge origin rejected', { status: 403 });
  }
  return undefined;
}

function hasValidToken(req: Request, token: string): boolean {
  const url = new URL(req.url);
  const queryToken = url.searchParams.get('token') ?? url.searchParams.get('authToken');
  const auth = req.headers.get('authorization');
  const headerToken = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7) : undefined;
  return queryToken === token || headerToken === token;
}

function hasAllowedOrigin(req: Request, allowedOrigins: readonly string[] = []): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const expectedOrigin = new URL(req.url).origin;
  return origin === expectedOrigin || allowedOrigins.includes(origin);
}

async function proxyPortRequest(
  req: Request,
  options: { token: string; routes: Map<string, PortRoute> },
): Promise<Response> {
  if (!hasValidToken(req, options.token)) {
    return new Response('Port proxy token required', { status: 401 });
  }

  const url = new URL(req.url);
  const path = url.pathname.slice(PORT_PROXY_PREFIX.length);
  const [encodedSessionId, portText, ...rest] = path.split('/');
  if (!encodedSessionId || !portText)
    return new Response('Invalid port proxy route', { status: 400 });

  const sessionId = decodeURIComponent(encodedSessionId);
  const port = Number(portText);
  const route = options.routes.get(portRouteKey(sessionId, port));
  if (!route) return new Response('Unknown exposed port', { status: 404 });

  const target = new URL(route.targetUrl);
  target.pathname = `/${rest.join('/')}`;
  target.search = forwardedSearch(url.searchParams);

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('authorization');
  return fetch(target, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
    redirect: 'manual',
  });
}

function forwardedSearch(params: URLSearchParams): string {
  const forwarded = new URLSearchParams(params);
  forwarded.delete('token');
  forwarded.delete('authToken');
  const value = forwarded.toString();
  return value ? `?${value}` : '';
}

function portRouteKey(sessionId: string, port: number): string {
  return `${sessionId}:${port}`;
}

function createPublicPortUrl(options: {
  origin: string;
  sessionId: string;
  port: number;
  token: string;
}): string {
  const url = new URL(
    `${PORT_PROXY_PREFIX}${encodeURIComponent(options.sessionId)}/${options.port}/`,
    options.origin,
  );
  url.searchParams.set('token', options.token);
  return url.toString();
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function createBridgeToken(): string {
  return crypto.randomUUID();
}

function uiOrigin(uiUrl?: string): string[] {
  if (!uiUrl) return [];
  return [new URL(uiUrl).origin];
}

function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Uint8Array) return new TextDecoder().decode(message);
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return String(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
