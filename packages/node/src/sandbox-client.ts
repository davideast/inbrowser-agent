import { fileStat } from './file-stat';
import { filesystemWatch } from './filesystem-watch';
import {
  type BootOptions,
  ContainerProcess,
  type FileStat,
  type FilesystemChange,
  type FilesystemSnapshot,
  type MountEntry,
  type PreviewOptions,
  type SpawnOptions,
  type TerminalDimensions,
} from './index';
import { parseMountEntries } from './mount-entries';
import { validatePreviewClientScript } from './preview-client';
import { VERSION, fault, record, unwrap } from './protocol';
import { SANDBOX_PROTOCOL_VERSION } from './sandbox-host';
import { parseSnapshot } from './snapshot';

export type SandboxProcess = ContainerProcess;

export interface SandboxConnectOptions {
  /** Container boot options forwarded to `BrowserContainer.boot` inside the sandbox host. */
  bootOptions?: BootOptions;
  /** Handshake deadline in milliseconds (default `15_000`). */
  connectTimeoutMs?: number;
  /** Per-RPC reply deadline in milliseconds (default `60_000`). */
  rpcTimeoutMs?: number;
  /**
   * Permit connecting to a same-origin sandbox URL (default `false`).
   * Keep `false` in production so parent DOM, cookies, `localStorage` and
   * IndexedDB remain origin-isolated from guest execution and previews.
   */
  allowSameOrigin?: boolean;
}

export interface SandboxFilesystem {
  watch(path: string, options?: { recursive?: boolean }): Promise<ReadableStream<FilesystemChange>>;
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_RPC_TIMEOUT_MS = 60000;
const DISPOSE_GRACE_TIMEOUT_MS = 1000;

function closeEventPorts(ports: readonly MessagePort[]): void {
  for (const port of ports) port.close();
}

function parseSandboxUrl(
  rawUrl: string | URL,
  allowSameOrigin: boolean | undefined,
  invalidMessage: string,
): URL {
  let sandboxUrl: URL;
  try {
    sandboxUrl = new URL(String(rawUrl), location.href);
  } catch {
    throw fault('EINVAL', invalidMessage);
  }
  if (
    (sandboxUrl.protocol !== 'http:' && sandboxUrl.protocol !== 'https:') ||
    sandboxUrl.username ||
    sandboxUrl.password
  )
    throw fault('EINVAL', 'Sandbox host URL must use http or https without credentials');
  if (!allowSameOrigin && sandboxUrl.origin === location.origin)
    throw fault('EINVAL', 'SandboxContainer requires a cross-origin sandbox host URL');
  return sandboxUrl;
}

function resolveSandboxFrame(
  iframeOrUrl: string | URL | HTMLIFrameElement,
  allowSameOrigin: boolean | undefined,
): { sandboxUrl: URL; frame: HTMLIFrameElement; ownsFrame: boolean } {
  if (typeof iframeOrUrl === 'string' || iframeOrUrl instanceof URL) {
    const sandboxUrl = parseSandboxUrl(iframeOrUrl, allowSameOrigin, 'Invalid sandbox host URL');
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.allow = 'cross-origin-isolated';
    return { sandboxUrl, frame, ownsFrame: true };
  }
  if (typeof HTMLIFrameElement !== 'undefined' && iframeOrUrl instanceof HTMLIFrameElement) {
    const rawSrc = iframeOrUrl.getAttribute('src') || iframeOrUrl.src;
    if (!rawSrc) throw fault('EINVAL', 'Sandbox iframe must specify a src URL');
    const sandboxUrl = parseSandboxUrl(rawSrc, allowSameOrigin, 'Invalid sandbox iframe src URL');
    if (!iframeOrUrl.allow.includes('cross-origin-isolated')) {
      iframeOrUrl.allow = iframeOrUrl.allow
        ? `${iframeOrUrl.allow}; cross-origin-isolated`
        : 'cross-origin-isolated';
    }
    return { sandboxUrl, frame: iframeOrUrl, ownsFrame: !iframeOrUrl.isConnected };
  }
  throw fault('EINVAL', 'SandboxContainer.boot requires a URL or HTMLIFrameElement');
}

export class SandboxContainer {
  private nextId = 1;
  private closed = false;
  private disposing?: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly activeProcesses = new Set<{
    handle: ContainerProcess;
    port: MessagePort;
    failPending: (error: Error) => void;
  }>();
  private readonly previewClientListeners = new Map<
    number,
    Set<(clientPort: MessagePort) => void>
  >();

  readonly fs: SandboxFilesystem;

  private constructor(
    readonly id: string,
    readonly origin: string,
    private readonly port: MessagePort,
    private readonly frame: HTMLIFrameElement,
    private readonly ownsFrame: boolean,
    private readonly rpcTimeoutMs: number,
    private readonly stdinChunkBytes: number,
    private readonly captureBytes: number,
    private readonly snapshotEntries: number,
    private readonly snapshotBytes: number,
  ) {
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const reply = event.data;
      if (
        record(reply) &&
        reply.sandbox === SANDBOX_PROTOCOL_VERSION &&
        reply.version === VERSION &&
        reply.type === 'preview-client' &&
        typeof reply.port === 'number' &&
        Number.isInteger(reply.port) &&
        event.ports[0] instanceof MessagePort
      ) {
        for (let i = 1; i < event.ports.length; i++) event.ports[i]?.close();
        const clientPort = event.ports[0];
        const listeners = this.previewClientListeners.get(reply.port);
        if (this.closed || !listeners || listeners.size === 0) {
          clientPort.close();
          return;
        }
        for (const listener of [...listeners]) {
          try {
            listener(clientPort);
          } catch {
            // An embedder listener error must not disrupt sandbox control RPCs.
          }
        }
        return;
      }
      closeEventPorts(event.ports);
      if (
        !record(reply) ||
        reply.sandbox !== SANDBOX_PROTOCOL_VERSION ||
        reply.version !== VERSION ||
        typeof reply.id !== 'number' ||
        !Number.isSafeInteger(reply.id) ||
        reply.id < 1
      )
        return;
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      this.pending.delete(reply.id);
      clearTimeout(entry.timer);
      try {
        entry.resolve(unwrap(reply));
      } catch (error) {
        entry.reject(error);
      }
    };

    const readFileImpl = async (path: string, encoding?: 'utf8'): Promise<string | Uint8Array> => {
      const value = await this.rpc({ op: 'fs.readFile', path, encoding });
      if (encoding === 'utf8') {
        if (typeof value !== 'string') throw fault('EPROTO', 'Invalid UTF-8 readFile reply');
        return value;
      }
      if (value instanceof Uint8Array) return value;
      throw fault('EPROTO', 'Invalid binary readFile reply');
    };

    function readFile(path: string): Promise<Uint8Array>;
    function readFile(path: string, encoding: 'utf8'): Promise<string>;
    function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array>;
    function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array> {
      return readFileImpl(path, encoding);
    }

    this.fs = {
      watch: async (
        path: string,
        options: { recursive?: boolean } = {},
      ): Promise<ReadableStream<FilesystemChange>> => {
        if (
          !record(options) ||
          Object.keys(options).some((key) => key !== 'recursive') ||
          (options.recursive !== undefined && typeof options.recursive !== 'boolean')
        )
          throw fault('EINVAL', 'Invalid watch options');
        const channel = new MessageChannel();
        const token = crypto.randomUUID();
        try {
          await this.rpc({ op: 'fs.watch', path, options, token }, [channel.port2]);
          return filesystemWatch(
            channel.port1,
            async () => {
              if (!this.closed) await this.rpc({ op: 'fs.unwatch', token });
            },
            this.lifetime.signal,
          );
        } catch (error) {
          channel.port1.close();
          channel.port2.close();
          throw error;
        }
      },
      readFile,
      writeFile: async (path: string, data: string | Uint8Array): Promise<void> => {
        await this.rpc({ op: 'fs.writeFile', path, data });
      },
      readdir: async (path: string): Promise<string[]> => {
        const value = await this.rpc({ op: 'fs.readdir', path });
        if (
          !Array.isArray(value) ||
          !value.every((entry): entry is string => typeof entry === 'string')
        )
          throw fault('EPROTO', 'Invalid readdir reply');
        return value;
      },
      stat: async (path: string): Promise<FileStat> =>
        fileStat(await this.rpc({ op: 'fs.stat', path })),
      lstat: async (path: string): Promise<FileStat> =>
        fileStat(await this.rpc({ op: 'fs.lstat', path })),
      mkdir: async (
        path: string,
        options?: { recursive?: boolean; mode?: number },
      ): Promise<void> => {
        await this.rpc({ op: 'fs.mkdir', path, options });
      },
      rename: async (oldPath: string, newPath: string): Promise<void> => {
        await this.rpc({ op: 'fs.rename', oldPath, newPath });
      },
      rm: async (
        path: string,
        options?: { recursive?: boolean; force?: boolean },
      ): Promise<void> => {
        await this.rpc({ op: 'fs.rm', path, options });
      },
    };
  }

  static async boot(
    iframeOrUrl: string | URL | HTMLIFrameElement,
    options: SandboxConnectOptions = {},
  ): Promise<SandboxContainer> {
    if (
      !record(options) ||
      Object.keys(options).some(
        (key) =>
          !['bootOptions', 'connectTimeoutMs', 'rpcTimeoutMs', 'allowSameOrigin'].includes(key),
      ) ||
      (options.connectTimeoutMs !== undefined &&
        (typeof options.connectTimeoutMs !== 'number' ||
          !Number.isFinite(options.connectTimeoutMs) ||
          options.connectTimeoutMs <= 0)) ||
      (options.rpcTimeoutMs !== undefined &&
        (typeof options.rpcTimeoutMs !== 'number' ||
          !Number.isFinite(options.rpcTimeoutMs) ||
          options.rpcTimeoutMs <= 0)) ||
      (options.allowSameOrigin !== undefined && typeof options.allowSameOrigin !== 'boolean')
    )
      throw fault('EINVAL', 'Invalid SandboxContainer connect options');

    if (typeof window === 'undefined' || typeof document === 'undefined')
      throw fault('ENOTSUP', 'SandboxContainer.boot requires a browser Window environment');

    const { sandboxUrl, frame, ownsFrame } = resolveSandboxFrame(
      iframeOrUrl,
      options.allowSameOrigin,
    );
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const expectedOrigin = sandboxUrl.origin;

    return new Promise<SandboxContainer>((resolve, reject) => {
      let settled = false;
      let connectSent = false;
      let controlPort: MessagePort | undefined;

      const sendPing = () => {
        if (settled || connectSent || !frame.contentWindow) return;
        try {
          frame.contentWindow.postMessage(
            {
              sandbox: SANDBOX_PROTOCOL_VERSION,
              version: VERSION,
              type: 'sandbox-ping',
            },
            expectedOrigin,
          );
        } catch {
          /* Iframe is still on initial about:blank before cross-origin commit. */
        }
      };

      const cleanupHandshake = (keepPort: boolean) => {
        clearTimeout(timer);
        window.removeEventListener('message', onWindowMessage);
        frame.removeEventListener('load', sendPing);
        if (!keepPort) {
          if (controlPort) {
            controlPort.onmessage = null;
            controlPort.close();
          }
          if (ownsFrame) frame.remove();
        }
      };

      const failHandshake = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanupHandshake(false);
        reject(error);
      };

      const timer = setTimeout(() => {
        failHandshake(
          fault(
            'ETIMEDOUT',
            `Sandbox host ${expectedOrigin} did not complete handshake within ${connectTimeoutMs}ms`,
            { kind: 'channel' },
          ),
        );
      }, connectTimeoutMs);

      const onWindowMessage = (event: MessageEvent<unknown>) => {
        if (event.source !== frame.contentWindow || event.origin !== expectedOrigin) return;
        closeEventPorts(event.ports);
        if (settled || connectSent) return;
        const data = event.data;
        if (
          !record(data) ||
          data.sandbox !== SANDBOX_PROTOCOL_VERSION ||
          data.type !== 'sandbox-host-ready'
        )
          return;
        if (data.version !== VERSION) {
          failHandshake(
            fault('EPROTO', 'Incompatible sandbox host protocol version; serve matching assets'),
          );
          return;
        }
        if (!frame.contentWindow) return;
        connectSent = true;
        const channel = new MessageChannel();
        controlPort = channel.port1;
        channel.port1.onmessage = (portEvent: MessageEvent<unknown>) => {
          closeEventPorts(portEvent.ports);
          if (settled) return;
          const reply = portEvent.data;
          if (!record(reply) || reply.sandbox !== SANDBOX_PROTOCOL_VERSION || reply.id !== 0)
            return;
          try {
            if (reply.ok === false) unwrap(reply);
            if (reply.version !== VERSION) {
              throw fault(
                'EPROTO',
                'Incompatible sandbox runtime protocol version; serve matching assets',
              );
            }
            const init = unwrap(reply);
            if (
              !record(init) ||
              typeof init.containerId !== 'string' ||
              typeof init.origin !== 'string' ||
              typeof init.stdinChunkBytes !== 'number' ||
              typeof init.captureBytes !== 'number' ||
              typeof init.snapshotEntries !== 'number' ||
              typeof init.snapshotBytes !== 'number'
            )
              throw fault('EPROTO', 'Invalid sandbox initialization payload');
            settled = true;
            cleanupHandshake(true);
            resolve(
              new SandboxContainer(
                init.containerId,
                init.origin,
                channel.port1,
                frame,
                ownsFrame,
                rpcTimeoutMs,
                init.stdinChunkBytes,
                init.captureBytes,
                init.snapshotEntries,
                init.snapshotBytes,
              ),
            );
          } catch (error) {
            failHandshake(error);
          }
        };
        try {
          frame.contentWindow.postMessage(
            {
              sandbox: SANDBOX_PROTOCOL_VERSION,
              version: VERSION,
              type: 'sandbox-connect',
              bootOptions: options.bootOptions,
            },
            expectedOrigin,
            [channel.port2],
          );
        } catch (error) {
          channel.port2.close();
          failHandshake(error);
        }
      };

      window.addEventListener('message', onWindowMessage);
      frame.addEventListener('load', sendPing);
      if (ownsFrame) {
        frame.src = sandboxUrl.href;
        (document.body ?? document.documentElement).append(frame);
      } else {
        sendPing();
      }
    });
  }

  private sendRawRpc(
    request: Record<string, unknown>,
    timeoutMs: number,
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fault('ETIMEDOUT', 'Sandbox RPC request timed out', { kind: 'channel' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.port.postMessage(
          {
            ...request,
            sandbox: SANDBOX_PROTOCOL_VERSION,
            version: VERSION,
            id,
          },
          transfer,
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private rpc(request: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(fault('EPIPE', 'Sandbox container closed'));
    return this.sendRawRpc(request, this.rpcTimeoutMs, transfer);
  }

  async mount(files: Record<string, MountEntry>): Promise<void> {
    parseMountEntries(files);
    await this.rpc({ op: 'mount', files });
  }

  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array>;
  readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array> {
    return this.fs.readFile(path, encoding);
  }

  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.fs.writeFile(path, data);
  }

  readdir(path: string): Promise<string[]> {
    return this.fs.readdir(path);
  }

  stat(path: string): Promise<FileStat> {
    return this.fs.stat(path);
  }

  lstat(path: string): Promise<FileStat> {
    return this.fs.lstat(path);
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    return this.fs.mkdir(path, options);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return this.fs.rename(oldPath, newPath);
  }

  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return this.fs.rm(path, options);
  }

  async spawn(
    command: string,
    argv: string[],
    options: SpawnOptions = {},
  ): Promise<SandboxProcess> {
    const channel = new MessageChannel();
    let created: unknown;
    try {
      created = await this.rpc({ op: 'spawn', command, argv, options }, [channel.port2]);
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      throw error;
    }
    if (
      !record(created) ||
      typeof created.pid !== 'number' ||
      typeof created.hasStdin !== 'boolean' ||
      typeof created.hasTerminal !== 'boolean'
    ) {
      channel.port1.close();
      throw fault('EPROTO', 'Invalid sandbox spawn reply');
    }

    let nextProcRpcId = 1;
    let procClosed = false;
    const procPending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();

    const sendProcRpc = (payload: Record<string, unknown>): Promise<unknown> => {
      if (procClosed || this.closed)
        return Promise.reject(fault('EPIPE', 'Process channel closed'));
      const id = nextProcRpcId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          procPending.delete(id);
          reject(fault('ETIMEDOUT', 'Sandbox process RPC request timed out', { kind: 'channel' }));
        }, this.rpcTimeoutMs);
        procPending.set(id, { resolve, reject, timer });
        try {
          channel.port1.postMessage({
            ...payload,
            sandbox: SANDBOX_PROTOCOL_VERSION,
            version: VERSION,
            id,
          });
        } catch (error) {
          clearTimeout(timer);
          procPending.delete(id);
          reject(error);
        }
      });
    };

    const failProcPending = (error: Error) => {
      for (const task of procPending.values()) {
        clearTimeout(task.timer);
        task.reject(error);
      }
      procPending.clear();
    };

    const handle = new ContainerProcess(
      created.pid,
      async () => {
        if (!procClosed && !this.closed) await sendProcRpc({ op: 'kill' });
      },
      created.hasStdin
        ? async (bytes: Uint8Array | null) => {
            await sendProcRpc({ op: 'stdin', bytes });
          }
        : undefined,
      created.hasTerminal
        ? (dimensions: TerminalDimensions) => {
            void sendProcRpc({ op: 'resize', dimensions }).catch(() => undefined);
          }
        : undefined,
      this.stdinChunkBytes,
      this.captureBytes,
    );

    const recordEntry = { handle, port: channel.port1, failPending: failProcPending };
    this.activeProcesses.add(recordEntry);

    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      closeEventPorts(event.ports);
      const msg = event.data;
      if (!record(msg) || msg.sandbox !== SANDBOX_PROTOCOL_VERSION || msg.version !== VERSION)
        return;
      if (typeof msg.id === 'number') {
        if (!Number.isSafeInteger(msg.id) || msg.id < 1) return;
        const waiter = procPending.get(msg.id);
        if (!waiter) return;
        procPending.delete(msg.id);
        clearTimeout(waiter.timer);
        try {
          waiter.resolve(unwrap(msg));
        } catch (error) {
          waiter.reject(error);
        }
        return;
      }
      if (
        msg.type === 'output' &&
        (msg.stream === 'stdout' || msg.stream === 'stderr') &&
        msg.bytes instanceof Uint8Array
      ) {
        handle.output(msg.stream, msg.bytes);
        return;
      }
      if (msg.type === 'exit' && typeof msg.code === 'number') {
        procClosed = true;
        this.activeProcesses.delete(recordEntry);
        channel.port1.onmessage = null;
        channel.port1.close();
        failProcPending(fault('EPIPE', 'Process exited'));
        handle.complete(msg.code);
      }
    };

    return handle;
  }

  async preview(port: number, options?: PreviewOptions): Promise<string> {
    if (options !== undefined) {
      if (
        !record(options) ||
        Object.keys(options).some(
          (key) => key !== 'requestPath' && key !== 'webSocket' && key !== 'clientScript',
        ) ||
        (options.webSocket !== undefined && typeof options.webSocket !== 'boolean') ||
        (options.requestPath !== undefined &&
          options.requestPath !== 'strip' &&
          options.requestPath !== 'preserve')
      )
        throw fault('EINVAL', 'Invalid preview path policy');
      validatePreviewClientScript(options.clientScript);
    }
    const url = await this.rpc({ op: 'preview', port, options });
    if (typeof url !== 'string') throw fault('EPROTO', 'Invalid sandbox preview URL');
    return url;
  }

  onPreviewClient(port: number, listener: (clientPort: MessagePort) => void): () => void {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw fault('EINVAL', 'Invalid preview port');
    if (typeof listener !== 'function')
      throw fault('EINVAL', 'Preview client listener must be a function');
    if (this.closed) throw fault('EPIPE', 'Sandbox container closed');
    let listeners = this.previewClientListeners.get(port);
    const isFirst = !listeners || listeners.size === 0;
    if (!listeners) {
      listeners = new Set();
      this.previewClientListeners.set(port, listeners);
    }
    listeners.add(listener);
    if (isFirst) {
      void this.rpc({ op: 'preview.listen', port }).catch(() => undefined);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.previewClientListeners.get(port);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.previewClientListeners.delete(port);
        if (!this.closed) {
          void this.rpc({ op: 'preview.unlisten', port }).catch(() => undefined);
        }
      }
    };
  }

  async install(options: { cwd: string; omitOptional?: boolean }): Promise<void> {
    await this.rpc({ op: 'install', options });
  }

  async snapshot(): Promise<FilesystemSnapshot> {
    return parseSnapshot(
      await this.rpc({ op: 'snapshot' }),
      this.snapshotEntries,
      this.snapshotBytes,
    );
  }

  async restore(snapshot: FilesystemSnapshot): Promise<void> {
    const parsed = parseSnapshot(snapshot, this.snapshotEntries, this.snapshotBytes);
    const normalized: FilesystemSnapshot = {
      version: 1,
      entries: parsed.entries.map((entry) =>
        entry.type === 'file' ? { ...entry, data: new Uint8Array(entry.data) } : entry,
      ),
    };
    await this.rpc({ op: 'restore', snapshot: normalized });
  }

  async resources(): Promise<{ processes: number; descriptors: number; listeners: number }> {
    const counts = await this.rpc({ op: 'resources' });
    if (
      !record(counts) ||
      typeof counts.processes !== 'number' ||
      typeof counts.descriptors !== 'number' ||
      typeof counts.listeners !== 'number'
    )
      throw fault('EPROTO', 'Invalid sandbox resource accounting');
    return {
      processes: counts.processes,
      descriptors: counts.descriptors,
      listeners: counts.listeners,
    };
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.disposing = this.finishDispose();
    return this.disposing;
  }

  private async finishDispose(): Promise<void> {
    this.lifetime.abort();
    this.previewClientListeners.clear();
    const closedError = fault('EPIPE', 'Sandbox container closed');
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(closedError);
    }
    this.pending.clear();

    try {
      await this.sendRawRpc(
        { op: 'dispose' },
        Math.min(this.rpcTimeoutMs, DISPOSE_GRACE_TIMEOUT_MS),
      );
    } catch {
      /* Host frame already navigated, unresponsive, or closed. */
    }

    for (const entry of this.activeProcesses) {
      entry.port.onmessage = null;
      entry.port.close();
      entry.failPending(closedError);
      entry.handle.complete(137);
    }
    this.activeProcesses.clear();
    this.port.onmessage = null;
    this.port.close();
    if (this.ownsFrame) this.frame.remove();
  }

  teardown(): Promise<void> {
    return this.dispose();
  }
}

export function connectSandboxContainer(
  iframeOrUrl: string | URL | HTMLIFrameElement,
  options?: SandboxConnectOptions,
): Promise<SandboxContainer> {
  return SandboxContainer.boot(iframeOrUrl, options);
}
