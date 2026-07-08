import type { Server } from 'bun';
import {
  BRIDGE_PATH,
  DEFAULT_BRIDGE_HOSTNAME,
  DEFAULT_BRIDGE_PORT,
  createBridgeHostCore,
} from '../host/core.js';
import type {
  BridgeHostAdapter,
  BridgeHostAdapterFactory,
  BridgeHostServer,
  BridgeHostServerOptions,
  HostCommandRunOptions,
  HostCommandRunner,
} from '../host/types.js';

interface WebSocketData {
  authenticated: true;
}

const DEFAULT_MAX_BUFFERED_OUTPUT_CHARS = 1_048_576;

export function createBunCommandRunner(): HostCommandRunner {
  return {
    async run(args, options = {}) {
      if (args.length === 0) throw new Error('Host command runner requires at least one arg');
      const proc = Bun.spawn(Array.from(args), {
        stdout: 'pipe',
        stderr: 'pipe',
        signal: options.signal,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(proc.stdout, 'stdout', options),
        readStream(proc.stderr, 'stderr', options),
        proc.exited,
      ]);
      if (options.rejectOnFailure && exitCode !== 0) {
        throw new Error(`${args.join(' ')} failed (${exitCode}): ${stderr.text || stdout.text}`);
      }
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    },
  };
}

export async function startBunBridgeHostServer(
  options: BridgeHostServerOptions,
): Promise<BridgeHostServer> {
  const hostname = options.hostname ?? DEFAULT_BRIDGE_HOSTNAME;
  let currentPort = options.port ?? DEFAULT_BRIDGE_PORT;
  const core = createBridgeHostCore({
    ...options,
    hostKind: 'bun',
    bridgeOrigin: () => `http://${hostname}:${currentPort}`,
  });
  let stopped = false;

  const server: Server<WebSocketData> = Bun.serve<WebSocketData>({
    hostname,
    port: options.port ?? DEFAULT_BRIDGE_PORT,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (isWebSocketUpgrade(req) && url.pathname === BRIDGE_PATH) {
        const rejection = core.authenticateBridgeRequest(req);
        if (rejection) return rejection;
        if (server.upgrade(req, { data: { authenticated: true } satisfies WebSocketData })) return;
        return new Response('WebSocket upgrade failed', { status: 426 });
      }
      return core.handleHttpRequest(req);
    },
    websocket: {
      message(ws, message) {
        void core.handleSocketMessage(ws, message);
      },
      close(ws) {
        void core.closeSocket(ws);
      },
    },
  });
  currentPort = server.port ?? currentPort;

  return {
    host: hostname,
    get port() {
      return currentPort;
    },
    bridgeToken: core.bridgeToken,
    get bridgeOrigin() {
      return `http://${hostname}:${currentPort}`;
    },
    bridgeUrl: core.bridgePath,
    statusUrl: core.statusPath,
    closeSessions: core.closeSessions,
    hostStatus: () => core.hostStatus(false),
    async stop() {
      await core.closeSessions();
      if (!stopped) {
        stopped = true;
        server.stop(true);
      }
    },
  };
}

export const startBridgeHostServer = startBunBridgeHostServer;

export const bunBridgeHostAdapterFactory: BridgeHostAdapterFactory = {
  kind: 'bun',
  priority: 100,
  async detect() {
    return typeof Bun === 'undefined'
      ? { available: false, reason: 'Bun runtime is not available' }
      : { available: true };
  },
  create() {
    return {
      kind: 'bun',
      start: startBunBridgeHostServer,
    } satisfies BridgeHostAdapter;
  },
};

async function readStream(
  stream: ReadableStream<Uint8Array>,
  name: 'stdout' | 'stderr',
  options: HostCommandRunOptions,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const maxBufferedOutputChars =
    options.maxBufferedOutputChars ?? DEFAULT_MAX_BUFFERED_OUTPUT_CHARS;
  let text = '';
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    ({ text, truncated } = appendOutput(text, truncated, chunkText, maxBufferedOutputChars));
    if (chunkText) options.onOutput?.({ stream: name, chunk: chunkText });
  }
  const tail = decoder.decode();
  if (tail) {
    ({ text, truncated } = appendOutput(text, truncated, tail, maxBufferedOutputChars));
    options.onOutput?.({ stream: name, chunk: tail });
  }
  return { text, truncated };
}

function appendOutput(
  text: string,
  truncated: boolean,
  chunkText: string,
  maxBufferedOutputChars: number,
): { text: string; truncated: boolean } {
  if (text.length < maxBufferedOutputChars) {
    const nextText = text + chunkText.slice(0, maxBufferedOutputChars - text.length);
    return {
      text: nextText,
      truncated: truncated || nextText.length >= maxBufferedOutputChars,
    };
  }
  return { text, truncated: true };
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket';
}
