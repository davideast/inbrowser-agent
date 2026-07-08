import type { SandboxStats } from '../../types.js';
import {
  type BridgeEnvelope,
  REMOTE_PROTOCOL_TYPES,
  type RemoteBridgeEvent,
  type RemoteHostDiagnostic,
  type RemoteHostStatusResponse,
} from '../types.js';
import type {
  BridgeHostServerOptions,
  ContainerExposedPort,
  ContainerSandboxProvider,
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
  const sessions = new Map<string, ContainerSession>();
  const socketSessions = new WeakMap<BridgeHostSocket, Set<string>>();
  const seqBySession = new Map<string, number>();
  const portRoutes = new Map<string, PortRoute>();
  const root = options.root ?? DEFAULT_BRIDGE_ROOT;
  const bridgeToken = options.token ?? createBridgeToken();
  const readiness = createProviderReadiness(options.provider);
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
      status: await readiness.status(),
    };
  }

  async function closeSessions() {
    const ids = Array.from(sessions.keys());
    for (const id of ids) await disposeSession(id, sessions, portRoutes);
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
        const payload = await handleRequest(
          envelope,
          {
            provider: options.provider,
            readiness,
            sessions,
            portRoutes,
            publicOrigin: () => options.uiUrl ?? options.bridgeOrigin(),
            bridgeToken,
            root,
            hostStatus,
          },
          (event) => {
            sendEvent(socket, envelope.sessionId, seqBySession, event);
          },
        );
        if (envelope.type === REMOTE_PROTOCOL_TYPES.sessionCreate) {
          const ids = socketSessions.get(socket) ?? new Set<string>();
          ids.add(envelope.sessionId);
          socketSessions.set(socket, ids);
        }
        socket.send(JSON.stringify(responseEnvelope(envelope, payload)));
      } catch (err) {
        socket.send(JSON.stringify(errorEnvelope(envelope, err)));
      }
    },
    closeSocket(socket) {
      return disposeSocketSessions(socket, socketSessions, sessions, portRoutes);
    },
    closeSessions,
    hostStatus,
  };
}

async function handleRequest(
  envelope: BridgeEnvelope,
  context: {
    provider: ContainerSandboxProvider;
    readiness: ProviderReadiness;
    sessions: Map<string, ContainerSession>;
    portRoutes: Map<string, PortRoute>;
    publicOrigin(): string;
    bridgeToken: string;
    root: string;
    hostStatus(authenticated: boolean): Promise<RemoteHostStatusResponse>;
  },
  emit: (event: RemoteBridgeEvent) => void,
): Promise<unknown> {
  if (envelope.type === REMOTE_PROTOCOL_TYPES.hostStatus) {
    return context.hostStatus(true);
  }

  if (envelope.type === REMOTE_PROTOCOL_TYPES.sessionCreate) {
    await context.readiness.ensureReady();
    const payload = envelope.payload as { root?: string };
    const session = await context.provider.createSession({
      id: envelope.sessionId,
      root: payload.root ?? context.root,
    });
    context.sessions.set(envelope.sessionId, session);
    return {
      root: session.root,
      capabilities: { fs: true, shell: true, persistentStorage: context.provider.kind !== 'fake' },
    };
  }

  const session = context.sessions.get(envelope.sessionId);
  if (!session) throw new Error(`Unknown bridge session: ${envelope.sessionId}`);
  const payload = envelope.payload as Record<string, unknown>;

  switch (envelope.type) {
    case REMOTE_PROTOCOL_TYPES.fsRead: {
      const bytes = await session.readFile(String(payload.path));
      if (payload.encoding === 'utf8') {
        return {
          path: payload.path,
          content: new TextDecoder().decode(bytes),
          encoding: 'utf8',
        };
      }
      return {
        path: payload.path,
        content: bytesToBase64(bytes),
        encoding: 'base64',
      };
    }
    case REMOTE_PROTOCOL_TYPES.fsWrite:
      await session.writeFile(
        String(payload.path),
        payload.encoding === 'base64'
          ? base64ToBytes(String(payload.content))
          : new TextEncoder().encode(String(payload.content)),
      );
      emit({
        type: 'file',
        event: { type: 'write', path: String(payload.path), timestamp: Date.now() },
      });
      return {};
    case REMOTE_PROTOCOL_TYPES.fsMkdir:
      await session.mkdir(String(payload.path), { recursive: payload.recursive === true });
      emit({
        type: 'file',
        event: { type: 'mkdir', path: String(payload.path), timestamp: Date.now() },
      });
      return {};
    case REMOTE_PROTOCOL_TYPES.fsList:
      return {
        entries: await session.readdir(String(payload.path), {
          withFileTypes: payload.withFileTypes === true,
        }),
      };
    case REMOTE_PROTOCOL_TYPES.fsStat:
      return plainStats(await session.stat(String(payload.path)));
    case REMOTE_PROTOCOL_TYPES.fsLstat:
      return plainStats(await session.lstat(String(payload.path)));
    case REMOTE_PROTOCOL_TYPES.fsDelete:
      if (payload.recursive === true) {
        await session.rmdir(String(payload.path), { recursive: true });
      } else {
        await session.unlink(String(payload.path));
      }
      emit({
        type: 'file',
        event: { type: 'delete', path: String(payload.path), timestamp: Date.now() },
      });
      return {};
    case REMOTE_PROTOCOL_TYPES.fsRename:
      await session.rename(String(payload.from), String(payload.to));
      emit({
        type: 'file',
        event: {
          type: 'rename',
          path: String(payload.from),
          targetPath: String(payload.to),
          timestamp: Date.now(),
        },
      });
      return {};
    case REMOTE_PROTOCOL_TYPES.fsSnapshot:
      return { snapshot: await session.snapshot(payload.root ? String(payload.root) : undefined) };
    case REMOTE_PROTOCOL_TYPES.fsRestore:
      await session.restore(payload.snapshot as never, { clearRoot: payload.clearRoot === true });
      emit({
        type: 'file',
        event: { type: 'write', path: session.root, timestamp: Date.now() },
      });
      return {};
    case REMOTE_PROTOCOL_TYPES.runStart:
      return session.run(String(payload.command), {
        cwd:
          typeof (payload.options as { cwd?: unknown } | undefined)?.cwd === 'string'
            ? String((payload.options as { cwd: string }).cwd)
            : undefined,
        onOutput(output) {
          emit({
            type: 'artifact',
            artifact: {
              kind: 'run.output',
              requestId: envelope.id,
              stream: output.stream,
              chunk: output.chunk,
            },
          });
        },
      });
    case REMOTE_PROTOCOL_TYPES.portExpose:
      return exposePort({
        envelope,
        session,
        portRoutes: context.portRoutes,
        publicOrigin: context.publicOrigin,
        bridgeToken: context.bridgeToken,
        host: typeof payload.host === 'string' ? payload.host : undefined,
        port: Number(payload.port),
        emit,
      });
    case REMOTE_PROTOCOL_TYPES.runCancel:
      return {};
    default:
      throw new Error(`Unhandled bridge request: ${envelope.type}`);
  }
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

function responseEnvelope(request: BridgeEnvelope, payload: unknown): BridgeEnvelope {
  return {
    id: `response-${request.id}`,
    sessionId: request.sessionId,
    kind: 'response',
    type: request.type,
    replyTo: request.id,
    sentAt: Date.now(),
    peer: 'host',
    payload,
  };
}

function errorEnvelope(request: BridgeEnvelope, err: unknown): BridgeEnvelope {
  return {
    id: `error-${request.id}`,
    sessionId: request.sessionId,
    kind: 'error',
    type: request.type,
    replyTo: request.id,
    sentAt: Date.now(),
    peer: 'host',
    payload: { message: errorMessage(err) },
  };
}

function plainStats(stats: SandboxStats): Omit<SandboxStats, 'isFile' | 'isDirectory'> {
  return {
    type: stats.type,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

interface ProviderReadiness {
  ensureReady(): Promise<void>;
  status(): Promise<RemoteHostDiagnostic>;
}

function createProviderReadiness(provider: ContainerSandboxProvider): ProviderReadiness {
  let state: RemoteHostDiagnostic['state'] = 'idle';
  let readyPromise: Promise<void> | undefined;
  let lastError: unknown;

  async function ensureReady() {
    if (state === 'ready') return;
    if (!readyPromise) {
      state = 'starting';
      lastError = undefined;
      readyPromise = provider
        .ensureReady()
        .then(() => {
          state = 'ready';
        })
        .catch((err) => {
          state = 'error';
          lastError = err;
          readyPromise = undefined;
          throw err;
        });
    }
    await readyPromise;
  }

  async function status(): Promise<RemoteHostDiagnostic> {
    try {
      const diagnostic = provider.diagnose
        ? await provider.diagnose()
        : {
            providerKind: provider.kind,
            state,
            runtimeAvailable: true,
            systemReady: state === 'ready',
            checkedAt: Date.now(),
          };
      return {
        ...diagnostic,
        providerKind: diagnostic.providerKind || provider.kind,
        state: state === 'idle' ? diagnostic.state : state,
        message:
          state === 'error'
            ? errorMessage(lastError)
            : state === 'ready'
              ? statusMessage(state)
              : (diagnostic.message ?? statusMessage(state)),
        checkedAt: diagnostic.checkedAt || Date.now(),
      };
    } catch (err) {
      return {
        providerKind: provider.kind,
        state: 'error',
        runtimeAvailable: false,
        systemReady: false,
        message: errorMessage(err),
        checkedAt: Date.now(),
      };
    }
  }

  return { ensureReady, status };
}

function statusMessage(state: RemoteHostDiagnostic['state']): string {
  if (state === 'starting') return 'Container provider is starting';
  if (state === 'ready') return 'Container provider is ready';
  if (state === 'error') return 'Container provider failed';
  return 'Container provider is idle';
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

async function disposeSocketSessions(
  socket: BridgeHostSocket,
  socketSessions: WeakMap<BridgeHostSocket, Set<string>>,
  sessions: Map<string, ContainerSession>,
  portRoutes: Map<string, PortRoute>,
) {
  const ids = socketSessions.get(socket);
  if (!ids) return;
  for (const id of ids) await disposeSession(id, sessions, portRoutes);
}

async function disposeSession(
  id: string,
  sessions: Map<string, ContainerSession>,
  portRoutes: Map<string, PortRoute>,
) {
  const session = sessions.get(id);
  sessions.delete(id);
  for (const key of Array.from(portRoutes.keys())) {
    if (key.startsWith(`${id}:`)) portRoutes.delete(key);
  }
  try {
    await session?.dispose();
  } catch (err) {
    console.warn(`remote container session cleanup failed for ${id}: ${errorMessage(err)}`);
  }
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
