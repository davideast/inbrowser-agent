import { createSandbox } from '../core.js';
import { normalizeSandboxPath } from '../path.js';
import { standardSandboxTools } from '../tools.js';
import type {
  RuntimeCapabilities,
  Sandbox,
  SandboxDirent,
  SandboxFileEvent,
  SandboxFileSystem,
  SandboxRuntime,
  SandboxStats,
  SandboxTool,
} from '../types.js';
import { decodeBytes, encodeBytes } from './codec.js';
import { createBridgeEnvelopeId } from './connection.js';
import type {
  BridgeConnection,
  BridgeEnvelope,
  RemoteBridgeEvent,
  RemoteFsListResponse,
  RemoteFsReadResponse,
  RemoteFsSnapshotResponse,
  RemoteFsStatResponse,
  RemoteRunResponse,
  RemoteSandboxOptions,
  RemoteSessionCreateResponse,
} from './types.js';
import { REMOTE_PROTOCOL_TYPES } from './types.js';

const DEFAULT_CAPABILITIES: RuntimeCapabilities = {
  fs: true,
  shell: true,
  git: false,
  preview: false,
  packages: false,
  persistentStorage: false,
  syncFs: false,
};

export async function createRemoteSandbox(options: RemoteSandboxOptions): Promise<Sandbox> {
  const root = normalizeSandboxPath(options.root ?? '/work');
  const connection = await options.transport.connect({
    sessionId: options.id,
    role: 'browser',
    auth: options.auth,
    resumeFromSeq: options.resumeFromSeq,
  });
  const session = await request<RemoteSessionCreateResponse>(
    connection,
    REMOTE_PROTOCOL_TYPES.sessionCreate,
    { root, capabilities: options.capabilities },
    options.requestTimeoutMs,
  );
  const cwd = normalizeSandboxPath(session.payload.root || root);
  const fileListeners = new Set<(event: SandboxFileEvent) => void>();
  const attached: { sandbox?: Sandbox } = {};

  const unsubscribe = connection.subscribe((envelope) => {
    if (envelope.kind !== 'event') return;
    const bridgeEvent = envelope.payload as RemoteBridgeEvent;
    if (bridgeEvent.type === 'file') {
      for (const listener of Array.from(fileListeners)) listener(bridgeEvent.event);
      return;
    }
    if (bridgeEvent.type === 'sandbox') attached.sandbox?.emit(bridgeEvent.event);
    if (bridgeEvent.type === 'artifact') {
      attached.sandbox?.emit({ type: 'artifact', artifact: bridgeEvent.artifact });
    }
    if (bridgeEvent.type === 'port')
      attached.sandbox?.emit({ type: 'port', port: bridgeEvent.port });
  });

  const fs = createRemoteFileSystem(connection, cwd, fileListeners, options.requestTimeoutMs);
  const runtime = createRemoteRuntime(connection, options.requestTimeoutMs);
  const sandbox = createSandbox({
    id: options.id,
    cwd,
    fs,
    runtime,
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...session.payload.capabilities,
      ...options.capabilities,
    },
    tools: options.tools ?? standardSandboxTools(),
  });
  attached.sandbox = sandbox;
  sandbox.on((event) => {
    if (event.type === 'destroyed') {
      unsubscribe();
      void connection.close('sandbox destroyed');
    }
  });
  return sandbox;
}

function createRemoteFileSystem(
  connection: BridgeConnection,
  root: string,
  fileListeners: Set<(event: SandboxFileEvent) => void>,
  timeoutMs?: number,
): SandboxFileSystem {
  async function readFile(path: string): Promise<Uint8Array>;
  async function readFile(path: string, encoding: 'utf8'): Promise<string>;
  async function readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
    const response = await request<RemoteFsReadResponse>(
      connection,
      REMOTE_PROTOCOL_TYPES.fsRead,
      { path, encoding },
      timeoutMs,
    );
    if (encoding === 'utf8') {
      return response.payload.encoding === 'base64'
        ? new TextDecoder().decode(decodeBytes(response.payload.content))
        : response.payload.content;
    }
    return response.payload.encoding === 'base64'
      ? decodeBytes(response.payload.content)
      : new TextEncoder().encode(response.payload.content);
  }

  async function readdir(path: string): Promise<string[]>;
  async function readdir(
    path: string,
    readdirOptions: { withFileTypes: true },
  ): Promise<SandboxDirent[]>;
  async function readdir(
    path: string,
    readdirOptions?: { withFileTypes?: boolean },
  ): Promise<string[] | SandboxDirent[]> {
    const response = await request<RemoteFsListResponse>(
      connection,
      REMOTE_PROTOCOL_TYPES.fsList,
      { path, withFileTypes: readdirOptions?.withFileTypes === true },
      timeoutMs,
    );
    if (readdirOptions?.withFileTypes) {
      return (response.payload.entries as SandboxDirent[]).map(toDirent);
    }
    return response.payload.entries as string[];
  }

  return {
    root,
    promises: {
      readFile,
      async writeFile(path, data) {
        await request(
          connection,
          REMOTE_PROTOCOL_TYPES.fsWrite,
          typeof data === 'string'
            ? { path, content: data, encoding: 'utf8' }
            : { path, content: encodeBytes(data), encoding: 'base64' },
          timeoutMs,
        );
      },
      async mkdir(path, mkdirOptions) {
        await request(
          connection,
          REMOTE_PROTOCOL_TYPES.fsMkdir,
          { path, ...mkdirOptions },
          timeoutMs,
        );
      },
      readdir,
      async stat(path) {
        const response = await request<RemoteFsStatResponse>(
          connection,
          REMOTE_PROTOCOL_TYPES.fsStat,
          { path },
          timeoutMs,
        );
        return toStats(response.payload);
      },
      async lstat(path) {
        const response = await request<RemoteFsStatResponse>(
          connection,
          REMOTE_PROTOCOL_TYPES.fsLstat,
          { path },
          timeoutMs,
        );
        return toStats(response.payload);
      },
      async unlink(path) {
        await request(connection, REMOTE_PROTOCOL_TYPES.fsDelete, { path }, timeoutMs);
      },
      async rmdir(path, rmdirOptions) {
        await request(
          connection,
          REMOTE_PROTOCOL_TYPES.fsDelete,
          { path, recursive: rmdirOptions?.recursive === true },
          timeoutMs,
        );
      },
      async rename(from, to) {
        await request(connection, REMOTE_PROTOCOL_TYPES.fsRename, { from, to }, timeoutMs);
      },
    },
    watch(callback) {
      fileListeners.add(callback);
      return () => fileListeners.delete(callback);
    },
    async snapshot(snapshotRoot) {
      const response = await request<RemoteFsSnapshotResponse>(
        connection,
        REMOTE_PROTOCOL_TYPES.fsSnapshot,
        { root: snapshotRoot },
        timeoutMs,
      );
      return response.payload.snapshot;
    },
    async restore(snapshot, restoreOptions) {
      await request(
        connection,
        REMOTE_PROTOCOL_TYPES.fsRestore,
        { snapshot, clearRoot: restoreOptions?.clearRoot === true },
        timeoutMs,
      );
    },
  };
}

function createRemoteRuntime(connection: BridgeConnection, timeoutMs?: number): SandboxRuntime {
  return {
    async run(command, options) {
      const requestId = createBridgeEnvelopeId('run');
      const abort = () => {
        void connection.send({
          id: createBridgeEnvelopeId('cancel'),
          sessionId: connection.sessionId,
          kind: 'request',
          type: REMOTE_PROTOCOL_TYPES.runCancel,
          sentAt: Date.now(),
          payload: { requestId },
        });
      };
      if (options?.signal?.aborted) abort();
      options?.signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await request<RemoteRunResponse>(
          connection,
          REMOTE_PROTOCOL_TYPES.runStart,
          { command, options: options?.cwd ? { cwd: options.cwd } : undefined },
          timeoutMs,
          requestId,
          options?.signal,
        );
        return response.payload;
      } finally {
        options?.signal?.removeEventListener('abort', abort);
      }
    },
  };
}

function request<T>(
  connection: BridgeConnection,
  type: string,
  payload: unknown,
  timeoutMs?: number,
  id = createBridgeEnvelopeId('remote'),
  signal?: AbortSignal,
): Promise<BridgeEnvelope<T>> {
  return connection.request<T>(
    {
      id,
      sessionId: connection.sessionId,
      type,
      payload,
    },
    { timeoutMs, signal },
  );
}

function toStats(stats: RemoteFsStatResponse): SandboxStats {
  return {
    ...stats,
    isFile: () => stats.type === 'file',
    isDirectory: () => stats.type === 'directory',
  };
}

function toDirent(dirent: SandboxDirent): SandboxDirent {
  return {
    ...dirent,
    isFile: () => dirent.type === 'file',
    isDirectory: () => dirent.type === 'directory',
  };
}
