import { validateDescriptorReadLimit } from './descriptor-read-limit';
import {
  DEFAULT_RESOURCE_POLICY,
  type HttpEgressPolicy,
  type ResolvedHttpEgressPolicy,
  type ResourcePolicy,
  type ResourcePolicyOverrides,
  aliasResourceOverrides,
  attachHttpEgressPolicy,
  installResourcePolicy,
  resolveResourcePolicy,
  validateHttpEgressPolicy,
} from './resource-policy';
import { validateUnzipLimit } from './unzip-limit';
export type {
  HttpEgressPolicy,
  ResourcePolicy,
  ResourcePolicyOverrides,
  SyscallPolicy,
  FilesystemPolicy,
  ModulesPolicy,
  HttpPolicy,
  PreviewPolicy,
  ChildPolicy,
  SnapshotPolicy,
  InstallPolicy,
  TimersPolicy,
} from './resource-policy';
export { DEFAULT_RESOURCE_POLICY, UNBOUNDED, resolveResourcePolicy } from './resource-policy';
import { PreviewBridges } from './preview-bridge';
import { validatePreviewClientScript } from './preview-client';
import { type PreviewOriginOptions, parsePreviewOptions } from './preview-origin';
import { type PreviewHeadHook, PreviewRelays, type PreviewStreams } from './preview-relay';
export type { PreviewStreams } from './preview-relay';
import {
  type CheckpointReceipt,
  type StartupConfiguration,
  checkpointKey,
  parseStartup,
  prepareCheckpoint,
} from './workspace-checkpoint';
import { commitWorkspace, loadWorkspace } from './workspace-store';
export type { StartupConfiguration, CheckpointReceipt } from './workspace-checkpoint';
import { SEEK_CUR, SEEK_END, SEEK_SET, type StdioBindings, isStdioBindings } from './protocol';
export { SEEK_CUR, SEEK_END, SEEK_SET };
export { loadFixture } from './fixture';
import { assetLocation } from './asset-location';
import { validateHttpResponseLimit } from './http-response-limit';
import { TailCapture } from './output-capture';
import { OutputChannel } from './output-channel';
import { type TerminalDimensions, terminalDimensions } from './terminal';
export type { TerminalDimensions } from './terminal';
import { type FilesystemSnapshot, parseSnapshot } from './snapshot';
import { readSnapshot, snapshotKey, writeSnapshot } from './snapshot-store';
export type { FilesystemSnapshot, SnapshotEntry } from './snapshot';
import { type MountEntry, parseMountEntries } from './mount-entries';
export type { MountEntry } from './mount-entries';
import { CAPACITY, HEADER_BYTES, VERSION, errorRecord, fault, record, unwrap } from './protocol';
// Public error taxonomy: an embedder discriminates on `kind` or `instanceof`
// instead of parsing messages. Codes, errno, syscall and messages are unchanged.
export { RuntimeError, UnsupportedError, LimitError, ChannelError, LifecycleError } from './errors';
export type { RuntimeErrorKind } from './errors';
import { parseExecArgv } from './exec-argv';
import { type FileStat, fileStat } from './file-stat';
import { type HttpHeaderPolicy, validateHttpHeaderPolicy } from './http-header-policy';
import { installLocked } from './install';
import { answerPageHeap } from './page-memory';
import { SocketRelay } from './socket-relay';
export type { FileStat } from './file-stat';
import { type FilesystemChange, filesystemWatch } from './filesystem-watch';
export type { FilesystemChange } from './filesystem-watch';
import { capturePackageCache, packageCachePath, validatePackageCache } from './package-cache';
import {
  packageCacheKey,
  readPackageCache,
  removePackageCache,
  writePackageCache,
} from './package-cache-store';

export interface BootOptions {
  /** Experimental browser compilation and async context propagation. */
  asyncContext?: 'experimental';
  assetBaseURL?: string;
  serviceWorker?: 'register' | 'existing';
  httpAgentMode?: 'socket' | 'fetch';
  httpOmitHeaders?: HttpHeaderPolicy;
  /** Allowed outbound guest HTTP/HTTPS host patterns (`example.com`, `*.example.com`, `host:port`). */
  httpAllowedHosts?: readonly string[];
  /** Blocked outbound guest HTTP/HTTPS host patterns (`example.com`, `*.example.com`, `host:port`); overrides `httpAllowedHosts`. */
  httpBlockedHosts?: readonly string[];
  /** Grouped outbound guest HTTP/HTTPS egress policy (`allowedHosts` / `blockedHosts`). */
  httpEgress?: HttpEgressPolicy | ResolvedHttpEgressPolicy;
  /**
   * Overrides for the resource policy - every byte cap, count and deadline the
   * runtime enforces, grouped by area. Unset groups and keys keep their
   * documented defaults. See docs/reference/resource-policy.md.
   */
  resources?: ResourcePolicyOverrides;
  /**
   * @deprecated Use `resources.http.responseBytes`. Kept as an alias.
   * Maximum decoded bytes per outbound Fetch response; defaults to 8 MiB, at most 64 MiB.
   */
  httpResponseLimit?: number;
  /**
   * @deprecated Use `resources.install.unzipBytes`. Kept as an alias.
   * Per-decoder input and output byte bounds; defaults to 32 MiB, at most 256 MiB.
   */
  unzipLimit?: number;
  /**
   * @deprecated Use `resources.filesystem.descriptorReadBytes`. Kept as an alias.
   * Maximum bytes requested per descriptor read; defaults to 32 MiB, at most 64 MiB.
   */
  descriptorReadLimit?: number;
  /**
   * Per-origin preview (opt-in). With it, `preview(port)` returns the origin
   * `origin` names for this container and port instead of a
   * `/__preview__/<id>/<port>/` URL, so root-relative URLs work unmodified.
   * The embedder serves the runtime's `preview-origin/` files on every such
   * origin; see docs/guide/README.md.
   */
  preview?: {
    /**
     * Origin template with `{container}` and `{port}`, for example
     * 'https://{container}-{port}.preview.example.com'. Each container and port
     * must map to a distinct https or localhost origin other than the host's.
     */
    origin: string;
    /** Embedder policy on preview responses. Only 'require-corp' is supported. */
    embedderPolicy?: 'require-corp';
  };
}
export interface PreviewOptions {
  requestPath?: 'strip' | 'preserve';
  /**
   * Bridge page WebSockets to the guest's `upgrade` handler. Off by default in
   * prefix mode; on by default with `BootOptions.preview` (pass false to disable).
   */
  webSocket?: boolean;
  /**
   * Optional self-contained client JavaScript source injected into HTML
   * preview documents (`status === 200`, `text/html`). Inside the preview
   * document, `globalThis.__inbrowserPreviewPort` exposes a `MessagePort`
   * relayed to `onPreviewClient`.
   */
  clientScript?: string;
}
export interface SpawnOptions {
  stdin?: 'pipe' | 'ignore';
  terminal?: TerminalDimensions;
  cwd?: string;
  env?: Record<string, string>;
}
export class ContainerProcess {
  // Convenience captures keep the most recent `resources.child.captureBytes`
  // per stream; the live streams below are unbounded by it. The retained chunks
  // back both the byte arrays and the text, so no other copy of output exists.
  private readonly captures: { stdout: TailCapture; stderr: TailCapture };
  /** Retained stdout bytes (the tail, at most `resources.child.captureBytes`). */
  get stdout(): Uint8Array[] {
    return this.captures.stdout.chunks;
  }
  /** Retained stderr bytes (the tail, at most `resources.child.captureBytes`). */
  get stderr(): Uint8Array[] {
    return this.captures.stderr.chunks;
  }
  /** Retained stdout as text; starts on a character boundary once truncated. */
  get stdoutText(): string {
    return this.captures.stdout.text(this.done);
  }
  /** Retained stderr as text; starts on a character boundary once truncated. */
  get stderrText(): string {
    return this.captures.stderr.text(this.done);
  }
  /** Bytes of stdout dropped from the front of the capture; 0 when complete. */
  get stdoutTruncatedBytes(): number {
    return this.captures.stdout.truncatedBytes;
  }
  /** Bytes of stderr dropped from the front of the capture; 0 when complete. */
  get stderrTruncatedBytes(): number {
    return this.captures.stderr.truncatedBytes;
  }
  readonly exit: Promise<number>;
  private resolveExit!: (code: number) => void;
  private done = false;
  private readonly out = new OutputChannel();
  private readonly err = new OutputChannel();
  readonly stdoutStream = this.out.stream;
  readonly stderrStream = this.err.stream;
  readonly stdin: WritableStream<Uint8Array> | null;
  private inputController?: WritableStreamDefaultController;
  constructor(
    readonly pid: number,
    private stop: () => Promise<void>,
    input?: (bytes: Uint8Array | null) => Promise<void>,
    private resizeTerminal?: (dimensions: TerminalDimensions) => void,
    private readonly stdinChunkBytes = DEFAULT_RESOURCE_POLICY.child.stdinChunkBytes,
    captureBytes = DEFAULT_RESOURCE_POLICY.child.captureBytes,
  ) {
    this.captures = {
      stdout: new TailCapture(captureBytes),
      stderr: new TailCapture(captureBytes),
    };
    this.stdin = input
      ? new WritableStream<Uint8Array>(
          {
            start: (controller) => {
              this.inputController = controller;
            },
            write: async (bytes) => {
              try {
                if (!(bytes instanceof Uint8Array))
                  throw fault('EINVAL', 'stdin expects Uint8Array chunks');
                if (bytes.byteLength > this.stdinChunkBytes)
                  throw fault('E2BIG', 'stdin chunk exceeds 32 MiB');
                if (!bytes.length) await input(bytes);
                for (let offset = 0; offset < bytes.length; offset += 65536)
                  await input(bytes.subarray(offset, offset + 65536));
              } catch (error) {
                try {
                  await input(null);
                } catch {
                  /* An exited reader already owns cleanup. */
                }
                throw error;
              }
            },
            close: () => input(null),
            abort: () => input(null),
          },
          {
            highWaterMark: 65536,
            size: (bytes) => (bytes instanceof Uint8Array ? bytes.byteLength : 1),
          },
        )
      : null;
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }
  async kill(): Promise<void> {
    if (!this.done) await this.stop();
  }
  resize(dimensions: TerminalDimensions): void {
    const size = terminalDimensions(dimensions);
    if (this.done) throw fault('EPIPE', 'Process has exited');
    if (!this.resizeTerminal) throw fault('ENOTTY', 'Process has no terminal');
    this.resizeTerminal(size);
  }
  /** @internal */ complete(code: number) {
    if (!this.done) {
      this.done = true;
      this.out.close();
      this.err.close();
      this.inputController?.error(fault('EPIPE', 'Process stdin is closed'));
      this.resolveExit(code);
    }
  }
  /** @internal */ output(stream: 'stdout' | 'stderr', bytes: Uint8Array) {
    if (this.done) return;
    this.captures[stream].push(bytes);
    (stream === 'stdout' ? this.out : this.err).push(bytes);
  }
}
export class BrowserContainer {
  // Advisory page measurement only: browsers do not expose the guest Worker's limit.
  private readonly advisoryHeapLimit = (() => {
    const memory: unknown = Reflect.get(performance, 'memory');
    const limit = record(memory) ? memory.jsHeapSizeLimit : undefined;
    return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
  })();
  private readonly kernel: Worker;
  private serviceWorker?: ServiceWorker;
  private servicePending = new Set<(error: unknown) => void>();
  private readonly serviceChange = () => {
    if (this.serviceWorker && navigator.serviceWorker.controller !== this.serviceWorker)
      void this.teardown();
  };
  readonly id = crypto.randomUUID();
  private readonly serviceMessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (
      !record(message) ||
      message.containerId !== this.id ||
      message.version !== VERSION ||
      event.source !== this.serviceWorker ||
      this.closed
    )
      return;
    const port = event.ports[0];
    if (!port) return;
    if (message.type === 'discover') {
      if (message.version === VERSION)
        port.postMessage({
          containerId: this.id,
          version: VERSION,
          assetBaseURL: this.assetBaseURL.href,
          resources: this.policy,
        });
      port.close();
    }
    if (message.type === 'http') void this.forwardHttp(message, port);
    if (message.type === 'socket') void this.forwardSocket(message, port);
    if (message.type === 'preview-client') this.forwardPreviewClient(message, port);
    if (message.type === 'client-script') {
      port.postMessage({ source: this.previewClientScript(message.port) });
      port.close();
    }
    if (
      message.type === 'module' &&
      typeof message.pid === 'number' &&
      typeof message.url === 'string'
    ) {
      port.postMessage({ source: this.processes.get(message.pid)?.modules.get(message.url) });
      port.close();
    }
  };
  private previewPaths = new Map<
    number,
    { pid: number; preserve: boolean; webSocket: boolean; clientScript?: string }
  >();
  private previewClientListeners = new Map<number, Set<(clientPort: MessagePort) => void>>();
  private sockets = new Set<SocketRelay>();
  // Streamed preview HTTP exchanges, relayed between the service worker and guests.
  private readonly streams: PreviewRelays;
  // Per-origin preview bridges; absent in prefix mode.
  private readonly bridges?: PreviewBridges;
  private nextId = 1;
  private nextPid = 1;
  private startingProcesses = 0;
  private closed = false;
  private installing = false;
  private caching = false;
  private checkpointing = false;

  /** The container's own snapshot bounds, for the shared parser. */
  private snapshotBounds(): [number, number] {
    return [this.policy.snapshot.entries, this.policy.snapshot.bytes];
  }
  private requireCacheIdle(): void {
    if (this.caching || this.checkpointing)
      throw fault('EBUSY', 'Wait for the persistence operation');
  }
  private readonly installation = new AbortController();
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private processes = new Map<
    number,
    {
      worker: Worker;
      handle: ContainerProcess;
      modules: Map<string, string>;
      moduleBytes: number;
      parent?: number;
      bridge?: MessagePort;
      interactiveShell: boolean;
      commandInterrupted: boolean;
      interrupt?: { id: number; timer: ReturnType<typeof setTimeout> };
      terminal?: {
        device: {
          dimensions: TerminalDimensions;
          owner: number;
          foreground: Set<number>;
          interruptEpoch: number;
        };
        fds: boolean[];
      };
    }
  >();
  private nextInterrupt = 1;
  private constructor(
    private readonly asyncContext: 'experimental' | undefined,
    private readonly httpAgentMode: 'socket' | 'fetch',
    private readonly httpOmitHeaders: HttpHeaderPolicy,
    private readonly policy: ResourcePolicy,
    private readonly assetBaseURL: URL,
    private readonly serviceWorkerMode: 'register' | 'existing',
    previewOrigin?: PreviewOriginOptions,
  ) {
    this.kernel = new Worker(new URL('kernel.js', assetBaseURL), { type: 'module' });
    this.streams = new PreviewRelays(policy);
    if (previewOrigin)
      this.bridges = new PreviewBridges(previewOrigin.origin, {
        containerId: this.id,
        policy,
        forward: (message, port, onHead) => void this.forwardHttp(message, port, onHead),
        socket: (message, port, origin) => void this.forwardSocket(message, port, origin),
        previewClient: (message, port, origin) => this.forwardPreviewClient(message, port, origin),
        clientScript: (port) => this.previewClientScript(port),
      });
    navigator.serviceWorker.addEventListener('message', this.serviceMessage);
    navigator.serviceWorker.addEventListener('controllerchange', this.serviceChange);
    this.kernel.onmessage = (event: MessageEvent<unknown>) => {
      if (
        record(event.data) &&
        event.data.type === 'terminal-interrupt' &&
        event.data.version === VERSION &&
        typeof event.data.pid === 'number' &&
        Number.isSafeInteger(event.data.pid) &&
        event.data.pid > 0
      ) {
        this.interruptTerminal(event.data.pid);
        return;
      }
      if (!record(event.data) || typeof event.data.id !== 'number') return;
      const task = this.pending.get(event.data.id);
      if (!task) return;
      this.pending.delete(event.data.id);
      clearTimeout(task.timer);
      try {
        task.resolve(unwrap(event.data));
      } catch (error) {
        task.reject(error);
      }
    };
    this.kernel.onerror = () => {
      const error = fault(
        'EASSET',
        `Kernel worker failed (${new URL('kernel.js', this.assetBaseURL).href}); check assetBaseURL and hosting headers`,
      );
      for (const task of this.pending.values()) {
        clearTimeout(task.timer);
        task.reject(error);
      }
      this.pending.clear();
      void this.teardown();
    };
  }
  static async boot(options: BootOptions = {}): Promise<BrowserContainer> {
    if (
      !record(options) ||
      Object.keys(options).some(
        (key) =>
          ![
            'asyncContext',
            'httpAgentMode',
            'httpOmitHeaders',
            'httpAllowedHosts',
            'httpBlockedHosts',
            'httpEgress',
            'resources',
            'httpResponseLimit',
            'unzipLimit',
            'descriptorReadLimit',
            'assetBaseURL',
            'serviceWorker',
            'preview',
          ].includes(key),
      ) ||
      (options.asyncContext !== undefined && options.asyncContext !== 'experimental') ||
      (options.serviceWorker !== undefined &&
        options.serviceWorker !== 'register' &&
        options.serviceWorker !== 'existing') ||
      (options.httpAgentMode !== undefined &&
        options.httpAgentMode !== 'socket' &&
        options.httpAgentMode !== 'fetch')
    )
      throw fault('EINVAL', 'Invalid container boot options');
    // Like the policy below, the preview origin template and HTTP egress policy
    // are validated before any Worker or service-worker registration exists.
    const previewOrigin = parsePreviewOptions(options.preview, location.origin);
    const egressPolicy = validateHttpEgressPolicy(
      options.httpEgress,
      options.httpAllowedHosts,
      options.httpBlockedHosts,
    );
    // The policy is resolved, and an invalid override rejected, before any
    // Worker or service-worker registration exists. The three deprecated
    // per-limit options keep their own EINVAL validation and map into it.
    const policy = attachHttpEgressPolicy(
      resolveResourcePolicy(
        // The key check above accepted only known BootOptions names, so a present
        // `resources` is the declared overrides type; resolveResourcePolicy still
        // validates its groups, names and ranges.
        aliasResourceOverrides(options.resources as ResourcePolicyOverrides | undefined, {
          ...(options.httpResponseLimit !== undefined
            ? { httpResponseLimit: validateHttpResponseLimit(options.httpResponseLimit) }
            : {}),
          ...(options.unzipLimit !== undefined
            ? { unzipLimit: validateUnzipLimit(options.unzipLimit) }
            : {}),
          ...(options.descriptorReadLimit !== undefined
            ? { descriptorReadLimit: validateDescriptorReadLimit(options.descriptorReadLimit) }
            : {}),
        }),
      ),
      egressPolicy,
    );
    // Host-realm helper modules (persistence stores, install, output observers)
    // read their bounds from the realm accessor. A page hosting several
    // containers shares that realm, so those host bounds follow the most
    // recently booted container; kernel, process and preview bounds are exact.
    installResourcePolicy(policy);
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')
      throw fault('ENOTSUP', 'COOP/COEP cross-origin isolation is required');
    if (typeof Worker !== 'function') throw fault('ENOTSUP', 'Dedicated Workers are required');
    if (typeof MessageChannel !== 'function') throw fault('ENOTSUP', 'MessageChannel is required');
    if (!navigator.serviceWorker)
      throw fault(
        'ENOTSUP',
        'Service workers are required; use a supported browser in a secure context',
      );
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function')
      throw fault('ENOTSUP', 'WebAssembly is required by the guest runtime');
    const container = new BrowserContainer(
      options.asyncContext,
      options.httpAgentMode ?? 'socket',
      validateHttpHeaderPolicy(options.httpOmitHeaders),
      policy,
      assetLocation(options.assetBaseURL, new URL('./', import.meta.url).href),
      options.serviceWorker ?? 'register',
      previewOrigin,
    );
    try {
      if ((await container.rpc({ op: 'ready', resources: policy })) !== VERSION)
        throw fault(
          'EPROTO',
          'Incompatible kernel protocol version; serve matching runtime assets',
        );
      await container.connectServiceWorker();
      return container;
    } catch (error) {
      await container.teardown();
      throw error;
    }
  }
  private rpc(request: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(fault('EPIPE', 'Container closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fault('ETIMEDOUT', 'Kernel request timed out'));
      }, this.policy.syscall.kernelRequestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.kernel.postMessage({ ...request, id }, transfer);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async preview(port: number, options: PreviewOptions = {}): Promise<string> {
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
    const clientScript = validatePreviewClientScript(options.clientScript);
    if (this.closed) throw fault('EPIPE', 'Container closed');
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw fault('EINVAL', 'Invalid preview port');
    // On its own origin the app already sees its real paths.
    if (this.bridges && options.requestPath === 'preserve')
      throw fault('EINVAL', "requestPath 'preserve' has no meaning with a preview origin");
    await this.connectServiceWorker();
    const deadline = Date.now() + this.policy.timers.previewLookupMs;
    let owner = await this.rpc({ op: 'lookup', port });
    while (typeof owner !== 'number') {
      if (!this.processes.size) throw fault('ESRCH', 'No process is listening');
      if (Date.now() >= deadline) throw fault('ETIMEDOUT', 'Guest did not listen on preview port');
      await new Promise((resolve) => setTimeout(resolve, 10));
      owner = await this.rpc({ op: 'lookup', port });
    }
    if (!this.processes.has(owner)) throw fault('ESRCH', 'Preview owner exited');
    this.previewPaths.set(port, {
      pid: owner,
      preserve: options.requestPath === 'preserve',
      // Decision 5: the WebSocket bridge is on by default for a preview origin.
      webSocket: this.bridges ? options.webSocket !== false : options.webSocket === true,
      ...(clientScript !== undefined ? { clientScript } : {}),
    });
    if (this.bridges) return this.bridges.open(port, deadline);
    return new URL(`/__preview__/${this.id}/${port}/`, location.origin).href;
  }
  onPreviewClient(port: number, listener: (clientPort: MessagePort) => void): () => void {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw fault('EINVAL', 'Invalid preview port');
    if (typeof listener !== 'function')
      throw fault('EINVAL', 'Preview client listener must be a function');
    if (this.closed) throw fault('EPIPE', 'Container closed');
    let listeners = this.previewClientListeners.get(port);
    if (!listeners) {
      listeners = new Set();
      this.previewClientListeners.set(port, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.previewClientListeners.get(port);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.previewClientListeners.delete(port);
    };
  }
  private previewClientScript(port: unknown): string | undefined {
    if (this.closed || typeof port !== 'number' || !Number.isInteger(port)) return undefined;
    const policy = this.previewPaths.get(port);
    if (!policy || policy.clientScript === undefined || !this.processes.has(policy.pid))
      return undefined;
    return policy.clientScript;
  }
  private forwardPreviewClient(
    message: Record<string, unknown>,
    port: MessagePort,
    origin = location.origin,
  ): void {
    if (
      this.closed ||
      message.version !== VERSION ||
      message.containerId !== this.id ||
      typeof message.port !== 'number' ||
      !Number.isInteger(message.port) ||
      typeof message.origin !== 'string' ||
      message.origin !== origin
    ) {
      port.close();
      return;
    }
    const policy = this.previewPaths.get(message.port);
    const listeners = this.previewClientListeners.get(message.port);
    if (
      !policy ||
      policy.clientScript === undefined ||
      !this.processes.has(policy.pid) ||
      !listeners ||
      listeners.size === 0
    ) {
      port.close();
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(port);
      } catch {
        // An embedder listener error must not crash container message routing.
      }
    }
  }
  private serviceTask<T>(operation: () => Promise<T>, timeoutMessage: string): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        this.servicePending.delete(cancel);
      };
      const cancel = (error: unknown) => {
        if (settled) return;
        cleanup();
        reject(error);
      };
      const timer = setTimeout(
        () => cancel(fault('ETIMEDOUT', timeoutMessage)),
        this.policy.timers.serviceTaskMs,
      );
      this.servicePending.add(cancel);
      if (this.closed) {
        cancel(fault('EPIPE', 'Container closed'));
        return;
      }
      try {
        operation().then((value) => {
          // Native registration cannot be aborted. Ignore late completion;
          // never unregister shared browser state to clean up one container.
          if (settled) return;
          cleanup();
          resolve(value);
        }, cancel);
      } catch (error) {
        cancel(error);
      }
    });
  }
  private async connectServiceWorker(): Promise<void> {
    if (this.closed) throw fault('EPIPE', 'Container closed');
    const scriptURL = new URL('sw.js', this.assetBaseURL).href;
    const registration = await this.serviceTask(
      () => navigator.serviceWorker.getRegistration('/'),
      'Service-worker registration lookup timed out; check browser service-worker availability',
    );
    if (this.closed) throw fault('EPIPE', 'Container closed');
    const workers = [
      navigator.serviceWorker.controller,
      registration?.active,
      registration?.waiting,
      registration?.installing,
    ];
    if (
      this.serviceWorkerMode === 'register' &&
      workers.some((worker) => worker && worker.scriptURL !== scriptURL)
    )
      throw fault(
        'EBUSY',
        "A host service worker already owns this scope; integrate the runtime helper and use serviceWorker: 'existing'",
      );
    // Never trigger an update of a live controller as a side effect of boot.
    // Its actual protocol is validated by registration acknowledgement below.
    if (this.serviceWorkerMode === 'existing' && !navigator.serviceWorker.controller)
      throw fault(
        'ENOTSUP',
        'Existing service worker must control this page; reload after host activation',
      );
    if (this.serviceWorkerMode === 'register' && !registration?.active)
      await this.serviceTask(
        () =>
          navigator.serviceWorker
            .register(scriptURL, {
              type: 'module',
              scope: '/',
            })
            .catch((cause: unknown) => {
              throw Object.assign(
                fault(
                  'EASSET',
                  `Unable to register service worker ${scriptURL}; check assetBaseURL, HTTPS and Service-Worker-Allowed`,
                ),
                { cause },
              );
            }),
        'Service-worker registration timed out; check the asset response and hosting configuration',
      );
    const deadline = Date.now() + this.policy.timers.serviceTaskMs;
    while (!navigator.serviceWorker.controller) {
      if (this.closed) throw fault('EPIPE', 'Container closed');
      if (Date.now() >= deadline) throw fault('ETIMEDOUT', 'Service worker did not take control');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.closed) throw fault('EPIPE', 'Container closed');
    const worker = navigator.serviceWorker.controller;
    const channel = new MessageChannel();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.servicePending.delete(cancel);
        channel.port1.close();
        channel.port2.close();
      };
      const cancel = (error: unknown) => {
        cleanup();
        try {
          worker.postMessage({ type: 'unregister', version: VERSION, containerId: this.id });
        } catch {
          /* A redundant worker owns no usable registration. */
        }
        reject(error);
      };
      const timer = setTimeout(
        () =>
          cancel(
            fault(
              'ETIMEDOUT',
              'Runtime service-worker handshake timed out; install the matching routing helper',
            ),
          ),
        this.policy.timers.serviceTaskMs,
      );
      this.servicePending.add(cancel);
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        const reply = event.data;
        if (
          !record(reply) ||
          reply.type !== 'registered' ||
          reply.version !== VERSION ||
          reply.containerId !== this.id ||
          reply.ok !== true
        )
          cancel(
            fault(
              'EPROTO',
              'Incompatible service-worker protocol version; serve matching runtime assets',
            ),
          );
        else if (this.closed || navigator.serviceWorker.controller !== worker)
          cancel(fault('EPIPE', 'Service-worker controller changed; reboot the container'));
        else {
          this.serviceWorker = worker;
          cleanup();
          resolve();
        }
      };
      try {
        worker.postMessage(
          {
            type: 'register',
            version: VERSION,
            containerId: this.id,
            assetBaseURL: this.assetBaseURL.href,
            resources: this.policy,
          },
          [channel.port2],
        );
      } catch (error) {
        cancel(error);
      }
    });
  }
  /**
   * Streamed preview exchanges this container is relaying, with the peak
   * number of body bytes that were in flight in each direction. The peaks never
   * exceed `preview.requestWindowBytes` and `preview.responseWindowBytes`.
   */
  previewStreams(): PreviewStreams {
    return this.streams.stats();
  }
  private async forwardHttp(
    message: Record<string, unknown>,
    port: MessagePort,
    onHead?: PreviewHeadHook,
  ) {
    const fail = () => {
      port.postMessage({ version: VERSION, type: 'head', status: 503, headers: {} });
      port.postMessage({
        version: VERSION,
        type: 'data',
        bytes: new TextEncoder().encode('Guest unavailable'),
      });
      port.postMessage({ version: VERSION, type: 'end' });
      port.close();
    };
    try {
      const pid = await this.rpc({ op: 'lookup', port: message.port });
      const process = typeof pid === 'number' ? this.processes.get(pid) : undefined;
      if (!process || typeof pid !== 'number') {
        fail();
        return;
      }
      const bodyLength = message.bodyLength;
      if (
        typeof message.port !== 'number' ||
        typeof message.url !== 'string' ||
        !message.url.startsWith('/') ||
        typeof message.method !== 'string' ||
        !record(message.headers) ||
        (bodyLength !== null &&
          (typeof bodyLength !== 'number' || !Number.isSafeInteger(bodyLength) || bodyLength < 0))
      ) {
        fail();
        return;
      }
      const policy = this.previewPaths.get(message.port);
      const requestUrl =
        policy?.pid === pid && policy.preserve
          ? `/__preview__/${this.id}/${message.port}${message.url}`
          : message.url;
      // The relay owns both ports from here: it forwards body frames and
      // credit, enforces the windows and budgets, and fails the browser side
      // if the guest never answers or exits.
      const channel = new MessageChannel();
      this.streams.open(
        pid,
        port,
        channel.port1,
        policy?.pid === pid && policy.webSocket,
        bodyLength,
        onHead,
        policy?.pid === pid && policy.clientScript !== undefined,
      );
      process.worker.postMessage(
        {
          type: 'http',
          version: VERSION,
          id: this.nextId++,
          port: message.port,
          method: message.method,
          url: requestUrl,
          headers: message.headers,
          // The body follows as frames on the port; see src/preview-stream.ts.
          body: new Uint8Array(),
          bodyLength,
        },
        [channel.port2],
      );
    } catch {
      fail();
    }
  }
  /** `origin` is the page's: the host's own in prefix mode, a preview origin's through a bridge. */
  private async forwardSocket(
    message: Record<string, unknown>,
    port: MessagePort,
    origin = location.origin,
  ) {
    const fail = () => {
      port.postMessage({ version: VERSION, type: 'error' });
      port.close();
    };
    try {
      if (
        message.version !== VERSION ||
        typeof message.port !== 'number' ||
        !Number.isInteger(message.port) ||
        typeof message.url !== 'string' ||
        !message.url.startsWith('/') ||
        message.url.length > 8192 ||
        typeof message.key !== 'string' ||
        !/^[A-Za-z0-9+/]{22}==$/.test(message.key) ||
        typeof message.protocols !== 'string' ||
        message.protocols.length > 1024 ||
        /[\r\n]/.test(message.protocols) ||
        typeof message.host !== 'string' ||
        message.host.length > 256 ||
        /[\r\n]/.test(message.host) ||
        typeof message.origin !== 'string' ||
        message.origin !== origin ||
        this.sockets.size >= this.policy.preview.relaysPerContainer
      )
        return fail();
      const pid = await this.rpc({ op: 'lookup', port: message.port });
      const owner = typeof pid === 'number' ? this.processes.get(pid) : undefined;
      const policy = this.previewPaths.get(message.port);
      if (
        !owner ||
        typeof pid !== 'number' ||
        policy?.pid !== pid ||
        !policy.webSocket ||
        this.closed ||
        this.sockets.size >= this.policy.preview.relaysPerContainer
      )
        return fail();
      const channel = new MessageChannel();
      const relay = new SocketRelay(pid, port, channel.port1, () => this.sockets.delete(relay));
      this.sockets.add(relay);
      owner.worker.postMessage(
        {
          type: 'upgrade',
          version: VERSION,
          id: this.nextId++,
          port: message.port,
          method: 'GET',
          url: policy.preserve
            ? `/__preview__/${this.id}/${message.port}${message.url}`
            : message.url,
          headers: {
            host: message.host,
            origin: message.origin,
            upgrade: 'websocket',
            connection: 'Upgrade',
            'sec-websocket-key': message.key,
            'sec-websocket-version': '13',
            ...(message.protocols ? { 'sec-websocket-protocol': message.protocols } : {}),
          },
          body: new Uint8Array(),
        },
        [channel.port2],
      );
    } catch {
      fail();
    }
  }
  async resources(): Promise<{ processes: number; descriptors: number; listeners: number }> {
    const counts = await this.rpc({ op: 'resources' });
    if (
      !record(counts) ||
      typeof counts.processes !== 'number' ||
      typeof counts.descriptors !== 'number' ||
      typeof counts.listeners !== 'number'
    )
      throw fault('EPROTO', 'Invalid resource accounting');
    return {
      processes: counts.processes,
      descriptors: counts.descriptors,
      listeners: counts.listeners,
    };
  }
  async mount(files: Record<string, MountEntry>): Promise<void> {
    this.requireCacheIdle();
    // The kernel validates again (protocol input is untrusted); this rejects
    // before the round trip.
    parseMountEntries(files);
    await this.rpc({ op: 'mount', files });
  }
  async snapshot(): Promise<FilesystemSnapshot> {
    if (this.installing) throw fault('EBUSY', 'Wait for installation before taking a snapshot');
    return parseSnapshot(await this.rpc({ op: 'snapshot' }), ...this.snapshotBounds());
  }
  async restore(snapshot: FilesystemSnapshot): Promise<void> {
    this.requireCacheIdle();
    if (this.installing) throw fault('EBUSY', 'Wait for installation before restoring a snapshot');
    const parsed = parseSnapshot(snapshot, ...this.snapshotBounds());
    // Structured cloning a view clones its entire backing buffer. Validate first
    // and own tightly sized bytes so unrelated storage cannot bypass the limit.
    const normalized: FilesystemSnapshot = {
      version: 1,
      entries: parsed.entries.map((entry) =>
        entry.type === 'file' ? { ...entry, data: new Uint8Array(entry.data) } : entry,
      ),
    };
    await this.rpc({ op: 'restore', snapshot: normalized });
  }
  async saveSnapshot(name: string): Promise<void> {
    const key = snapshotKey(name);
    await writeSnapshot(key, await this.snapshot(), this.installation.signal);
  }
  async restoreSnapshot(name: string): Promise<void> {
    const key = snapshotKey(name);
    const snapshot = parseSnapshot(
      await readSnapshot(key, this.installation.signal),
      ...this.snapshotBounds(),
    );
    await this.restore(snapshot);
  }
  async checkpoint(
    name: string,
    options: { startup: StartupConfiguration | null } = { startup: null },
  ): Promise<CheckpointReceipt> {
    const key = checkpointKey(name);
    if (!record(options) || Object.keys(options).some((key) => key !== 'startup'))
      throw fault('EINVAL', 'Invalid checkpoint options');
    const startup = parseStartup(options.startup);
    this.requireCacheIdle();
    if (this.installing) throw fault('EBUSY', 'Wait for installation before checkpointing');
    this.checkpointing = true;
    try {
      const snapshot = await this.snapshot();
      const prepared = await prepareCheckpoint(snapshot, startup, this.installation.signal);
      return await commitWorkspace(
        key,
        prepared.manifest,
        prepared.blobs,
        this.installation.signal,
      );
    } finally {
      this.checkpointing = false;
    }
  }
  async recover(name: string): Promise<{ revision: number; startup: StartupConfiguration | null }> {
    const key = checkpointKey(name);
    this.requireCacheIdle();
    if (this.installing) throw fault('EBUSY', 'Wait for installation before recovery');
    this.checkpointing = true;
    try {
      const saved = await loadWorkspace(key, this.installation.signal);
      await this.rpc({ op: 'restore', snapshot: saved.snapshot });
      return { revision: saved.revision, startup: saved.startup };
    } finally {
      this.checkpointing = false;
    }
  }
  async removePackageCache(name: string): Promise<void> {
    const key = packageCacheKey(name);
    this.requireCacheIdle();
    if (this.installing) throw fault('EBUSY', 'Wait for installation before caching');
    this.caching = true;
    try {
      if ((await this.resources()).processes)
        throw fault('EBUSY', 'Stop processes before evicting their download cache');
      await removePackageCache(key, this.installation.signal);
    } finally {
      this.caching = false;
    }
  }
  async savePackageCache(name: string, options: { path: string }): Promise<void> {
    const key = packageCacheKey(name);
    const root = packageCachePath(options);
    this.requireCacheIdle();
    if (this.installing) throw fault('EBUSY', 'Wait for installation before caching');
    // Reserve synchronously before the first RPC. Earlier mutations/attachments
    // are ordered before resources(); later writers cannot change this capture.
    this.caching = true;
    try {
      if ((await this.resources()).processes)
        throw fault('EBUSY', 'Stop processes before saving their download cache');
      const cache = await capturePackageCache(this.fs, root, this.installation.signal);
      await writePackageCache(key, cache, this.installation.signal);
    } finally {
      this.caching = false;
    }
  }
  async restorePackageCache(name: string, options: { path: string }): Promise<void> {
    const key = packageCacheKey(name);
    const root = packageCachePath(options);
    this.requireCacheIdle();
    if (this.installing) throw fault('EBUSY', 'Wait for installation before caching');
    this.caching = true;
    try {
      if ((await this.resources()).processes)
        throw fault('EBUSY', 'Stop processes before restoring their download cache');
      const cache = await validatePackageCache(
        await readPackageCache(key, this.installation.signal),
        this.installation.signal,
      );
      try {
        await this.fs.lstat(root);
        throw fault('EEXIST', 'Package cache destination already exists');
      } catch (error) {
        if (!record(error) || error.code !== 'ENOENT') throw error;
      }
      this.installation.signal.throwIfAborted();
      // The reservation covers the destination check through kernel publication.
      await this.rpc({
        op: 'mount',
        files: Object.fromEntries(
          Object.entries(cache.files).map(([name, bytes]) => [root + '/' + name, bytes]),
        ),
      });
    } finally {
      this.caching = false;
    }
  }
  async install(options: { cwd: string; omitOptional?: boolean }): Promise<void> {
    this.requireCacheIdle();
    if (this.closed) throw fault('EPIPE', 'Container closed');
    if (this.installing) throw fault('EBUSY', 'An installation is already running');
    if (!record(options)) throw fault('EINVAL', 'Install options are required');
    if (options.omitOptional !== undefined && typeof options.omitOptional !== 'boolean')
      throw fault('EINVAL', 'omitOptional must be a boolean');
    this.installing = true;
    try {
      await installLocked(
        {
          readFile: this.fs.readFile,
          mount: (files) => this.mount(files),
          chmod: async (filename, mode) => {
            await this.rpc({ op: 'fs', method: 'chmodSync', args: [filename, mode] });
          },
          link: async (target, filename) => {
            await this.rpc({
              op: 'fs',
              method: 'mkdirSync',
              args: [filename.slice(0, filename.lastIndexOf('/')), { recursive: true }],
            });
            await this.rpc({ op: 'fs', method: 'symlinkSync', args: [target, filename] });
          },
        },
        options.cwd,
        this.installation.signal,
        options.omitOptional,
      );
    } finally {
      this.installing = false;
    }
  }
  readonly fs = {
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
        await this.rpc(
          {
            op: 'hostWatch',
            path,
            recursive: options.recursive ?? false,
            token,
            port: channel.port2,
          },
          [channel.port2],
        );
        return filesystemWatch(
          channel.port1,
          async () => {
            await this.rpc({ op: 'hostUnwatch', token });
          },
          this.installation.signal,
        );
      } catch (error) {
        // Also reaches a registration whose RPC response arrived after its timeout.
        channel.port1.postMessage({ version: VERSION, type: 'close' });
        channel.port1.close();
        channel.port2.close();
        throw error;
      }
    },
    readFile: async (path: string, encoding?: 'utf8'): Promise<string | Uint8Array> => {
      const value = await this.rpc({ op: 'fs', method: 'readFileSync', args: [path, encoding] });
      if (typeof value !== 'string' && !(value instanceof Uint8Array))
        throw fault('EPROTO', 'Invalid read result');
      return value;
    },
    writeFile: async (path: string, data: string | Uint8Array): Promise<void> => {
      this.requireCacheIdle();
      await this.rpc({ op: 'fs', method: 'writeFileSync', args: [path, data] });
    },
    readdir: async (path: string): Promise<string[]> => {
      const value = await this.rpc({ op: 'fs', method: 'readdirSync', args: [path] });
      if (!Array.isArray(value) || !value.every((name: unknown) => typeof name === 'string'))
        throw fault('EPROTO', 'Invalid directory listing');
      return value;
    },
    stat: async (path: string): Promise<FileStat> =>
      fileStat(await this.rpc({ op: 'fs', method: 'statSync', args: [path] })),
    lstat: async (path: string): Promise<FileStat> =>
      fileStat(await this.rpc({ op: 'fs', method: 'lstatSync', args: [path] })),
    mkdir: async (
      path: string,
      options: { recursive?: boolean; mode?: number } = {},
    ): Promise<void> => {
      if (
        !record(options) ||
        Object.keys(options).some((key) => key !== 'recursive' && key !== 'mode') ||
        (options.recursive !== undefined && typeof options.recursive !== 'boolean') ||
        (options.mode !== undefined &&
          (!Number.isSafeInteger(options.mode) || options.mode < 0 || options.mode > 0o7777))
      )
        throw fault('EINVAL', 'Invalid mkdir options');
      this.requireCacheIdle();
      await this.rpc({ op: 'fs', method: 'mkdirSync', args: [path, options] });
    },
    rename: async (source: string, destination: string): Promise<void> => {
      this.requireCacheIdle();
      await this.rpc({ op: 'fs', method: 'renameSync', args: [source, destination] });
    },
    rm: async (
      path: string,
      options: { recursive?: boolean; force?: boolean } = {},
    ): Promise<void> => {
      if (
        !record(options) ||
        Object.keys(options).some((key) => key !== 'recursive' && key !== 'force') ||
        (options.recursive !== undefined && typeof options.recursive !== 'boolean') ||
        (options.force !== undefined && typeof options.force !== 'boolean')
      )
        throw fault('EINVAL', 'Invalid removal options');
      this.requireCacheIdle();
      await this.rpc({ op: 'fs', method: 'rmSync', args: [path, options] });
    },
  };
  async spawn(
    command: string,
    argv: string[],
    options: SpawnOptions = {},
  ): Promise<ContainerProcess> {
    if (
      !record(options) ||
      (options.stdin !== undefined && options.stdin !== 'pipe' && options.stdin !== 'ignore')
    )
      throw fault('EINVAL', 'Invalid stdin mode');
    const terminal =
      options.terminal === undefined ? undefined : terminalDimensions(options.terminal);
    if (terminal && options.stdin === 'ignore') throw fault('EINVAL', 'A terminal requires input');
    return this.spawnProcess(
      command,
      argv,
      { ...options, terminal },
      undefined,
      undefined,
      terminal !== undefined || options.stdin === 'pipe',
    );
  }
  private async spawnProcess(
    command: string,
    argv: string[],
    options: SpawnOptions,
    parent?: number,
    bridge?: MessagePort,
    stdinPipe = false,
    stdinInherit = false,
    ipcPort?: MessagePort,
    ipcSerialization: 'json' | 'advanced' = 'json',
    thread?: { port: MessagePort; data: unknown; processId: number },
    execArgv: unknown = [],
    outputPipes: OutputPipes = createOutputPipes(),
    stdio: StdioBindings = [null, null, null],
  ): Promise<ContainerProcess> {
    const startup = parseExecArgv(execArgv);
    if (
      !Array.isArray(argv) ||
      Array.from(argv).some(
        (arg, index) => typeof arg !== 'string' || (index === 0 && !arg) || arg.includes('\0'),
      ) ||
      !record(options) ||
      (options.cwd !== undefined &&
        (typeof options.cwd !== 'string' || !options.cwd.startsWith('/'))) ||
      (options.env !== undefined &&
        (!record(options.env) ||
          Object.values(options.env).some((value) => typeof value !== 'string')))
    ) {
      throw fault(
        'EINVAL',
        'spawn requires string arguments, absolute cwd, and string environment values',
      );
    }
    if ((command !== 'node' && command !== 'sh') || argv.length < 1)
      throw fault('ENOSYS', 'Only node <entry> or sh -c <command> is supported');
    if (this.closed) throw fault('EPIPE', 'Container closed');
    // An existing parent makes cache preflight reject. Its descendants must
    // remain runnable while that resource query is in flight.
    if (parent === undefined) this.requireCacheIdle();
    const maxProcesses = this.policy.child.maxProcesses;
    const activeProcesses = this.processes.size + this.startingProcesses;
    if (activeProcesses >= maxProcesses)
      throw fault('EAGAIN', `Process count exceeds ${maxProcesses} process limit`, {
        kind: 'limit',
        limit: maxProcesses,
        actual: activeProcesses + 1,
      });
    const pid = this.nextPid++;
    const inheritedTerminal =
      parent === undefined || thread ? undefined : this.processes.get(parent)?.terminal;
    const terminal = options.terminal
      ? {
          device: {
            dimensions: terminalDimensions(options.terminal),
            owner: pid,
            foreground: new Set<number>(),
            interruptEpoch: 0,
          },
          fds: [true, true, true],
        }
      : inheritedTerminal
        ? {
            device: inheritedTerminal.device,
            // A standard descriptor number names that parent descriptor in any slot.
            fds: stdio.map((binding, fd) => {
              const source = binding === 'inherit' ? fd : binding;
              return source !== null && source < 3 && inheritedTerminal.fds[source] === true;
            }),
          }
        : undefined;
    // Threads do not inherit TTY descriptors, but pending admissions still
    // belong to the foreground job containing their nearest terminal ancestor.
    let admissionDevice = terminal?.device;
    for (
      let ancestor = parent;
      !admissionDevice && ancestor !== undefined;
      ancestor = this.processes.get(ancestor)?.parent
    )
      admissionDevice = this.processes.get(ancestor)?.terminal?.device;
    const interruptEpoch = admissionDevice?.interruptEpoch;
    this.startingProcesses++;
    let registered = false;
    let channel: MessageChannel;
    let shared: SharedArrayBuffer;
    let fileStdio: number[];
    let worker: Worker;
    let handle: ContainerProcess;
    let process: {
      worker: Worker;
      handle: ContainerProcess;
      modules: Map<string, string>;
      moduleBytes: number;
      parent?: number;
      bridge?: MessagePort;
      interactiveShell: boolean;
      commandInterrupted: boolean;
      interrupt?: { id: number; timer: ReturnType<typeof setTimeout> };
      terminal?: typeof terminal;
    };
    try {
      channel = new MessageChannel();
      shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
      const attached = await this.rpc(
        {
          op: 'attach',
          pid,
          shared,
          port: channel.port1,
          stdinPipe,
          terminal: options.terminal !== undefined,
          stdinParent: stdinInherit ? parent : undefined,
          descriptorParent: parent,
          stdio,
        },
        [channel.port1],
      ).catch((error: unknown) => {
        channel.port2.close();
        throw error;
      });
      if (
        !Array.isArray(attached) ||
        attached.length > 3 ||
        Array.from(attached).some((fd) => fd !== 0 && fd !== 1 && fd !== 2)
      ) {
        channel.port2.close();
        await this.rpc({ op: 'remove', pid });
        throw fault('EPROTO', 'Invalid stdio attachment reply');
      }
      fileStdio = attached;
      if (this.closed || (parent !== undefined && !this.processes.has(parent))) {
        channel.port2.close();
        if (!this.closed) await this.rpc({ op: 'remove', pid });
        throw fault('EPIPE', 'Parent process exited during child startup');
      }
      if (
        parent !== undefined &&
        admissionDevice &&
        (admissionDevice.interruptEpoch !== interruptEpoch ||
          this.processes.get(parent)?.commandInterrupted)
      ) {
        channel.port2.close();
        ipcPort?.close();
        thread?.port.close();
        await this.rpc({ op: 'remove', pid });
        bridge?.postMessage({ type: 'exit', version: VERSION, code: 130, signal: 'SIGINT' });
        bridge?.close();
        const cancelled = new ContainerProcess(pid, async () => {});
        cancelled.complete(130);
        return cancelled;
      }
      worker = new Worker(new URL('process.js', this.assetBaseURL), { type: 'module' });
      handle = new ContainerProcess(
        pid,
        () => this.finish(pid, 137),
        parent === undefined && stdinPipe
          ? async (bytes) => {
              if (!this.processes.has(pid)) throw fault('EPIPE', 'Process stdin is closed');
              await this.rpc({ op: 'stdin', pid, bytes });
            }
          : undefined,
        options.terminal
          ? (dimensions) => {
              if (!this.processes.has(pid)) throw fault('EPIPE', 'Process has exited');
              if (!terminal) throw fault('ENOTTY', 'Process has no terminal');
              terminal.device.dimensions = dimensions;
              for (const entry of this.processes.values())
                if (entry.terminal?.device === terminal.device && entry.terminal.fds.some(Boolean))
                  entry.worker.postMessage({
                    type: 'terminal-resize',
                    version: VERSION,
                    dimensions,
                  });
            }
          : undefined,
        this.policy.child.stdinChunkBytes,
        this.policy.child.captureBytes,
      );
      process = {
        worker,
        handle,
        modules: new Map<string, string>(),
        moduleBytes: 0,
        parent,
        bridge,
        terminal,
        interactiveShell: command === 'sh' && argv.length === 1 && argv[0] === '-i',
        commandInterrupted: false,
      };
      if (parent !== undefined && this.processes.get(parent)?.interactiveShell && terminal)
        terminal.device.foreground.add(pid);
      this.processes.set(pid, process);
      registered = true;
      this.startingProcesses--;
    } finally {
      if (!registered) this.startingProcesses--;
    }
    // The Worker message queue owns accepted input bytes until delivery. Track
    // capacity here so a busy guest cannot prevent writes that fit from completing.
    const inputDeliveries = new Map<number, number>();
    let inputBytes = 0;
    let inputEnded = !stdinPipe;
    let inputFailed = false;
    let lastInputId = 0;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!record(message)) return;
      if (message.type === 'terminal-prompt' && message.version === VERSION) {
        const owner = this.processes.get(pid);
        if (owner?.interactiveShell) owner.commandInterrupted = false;
        return;
      }
      if (message.type === 'page-memory' && message.version === VERSION) {
        answerPageHeap(message.shared);
        return;
      }
      if (message.type === 'signal-ack' && message.version === VERSION) {
        const owner = this.processes.get(pid);
        if (owner?.interrupt && message.id === owner.interrupt.id) {
          clearTimeout(owner.interrupt.timer);
          owner.interrupt = undefined;
        }
        return;
      }
      if (message.type === 'spawn-child') {
        const port = message.port;
        if (!(port instanceof MessagePort)) return;
        if (
          (message.thread !== undefined &&
            (!record(message.thread) ||
              !(message.thread.port instanceof MessagePort) ||
              typeof message.thread.processId !== 'number' ||
              !Number.isSafeInteger(message.thread.processId) ||
              message.thread.processId < 1)) ||
          message.version !== VERSION ||
          (message.command !== 'node' && message.command !== 'sh') ||
          typeof message.stdinPipe !== 'boolean' ||
          typeof message.stdinInherit !== 'boolean' ||
          (message.outputPipes !== undefined && !isOutputPipes(message.outputPipes)) ||
          (message.stdio !== undefined && !isStdioBindings(message.stdio)) ||
          (message.ipcPort !== undefined && !(message.ipcPort instanceof MessagePort)) ||
          (message.ipcSerialization !== undefined &&
            message.ipcSerialization !== 'json' &&
            message.ipcSerialization !== 'advanced') ||
          !Array.isArray(message.args) ||
          !message.args.every((arg) => typeof arg === 'string') ||
          !record(message.options)
        ) {
          port.postMessage({
            type: 'error',
            version: VERSION,
            code: 'EINVAL',
            message: 'Invalid child request',
          });
          if (message.ipcPort instanceof MessagePort) message.ipcPort.close();
          if (record(message.thread) && message.thread.port instanceof MessagePort)
            message.thread.port.close();
          port.close();
          return;
        }
        const options = message.options;
        if (
          typeof options.cwd !== 'string' ||
          !record(options.env) ||
          !Object.values(options.env).every((value) => typeof value === 'string')
        ) {
          port.postMessage({
            type: 'error',
            version: VERSION,
            code: 'EINVAL',
            message: 'Invalid child options',
          });
          if (message.ipcPort instanceof MessagePort) message.ipcPort.close();
          if (record(message.thread) && message.thread.port instanceof MessagePort)
            message.thread.port.close();
          port.close();
          return;
        }
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(options.env))
          if (typeof value === 'string') env[key] = value;
        void this.spawnProcess(
          message.command,
          message.args,
          { cwd: options.cwd, env },
          pid,
          port,
          message.stdinPipe,
          message.stdinInherit,
          message.ipcPort,
          message.ipcSerialization,
          record(message.thread) &&
            message.thread.port instanceof MessagePort &&
            typeof message.thread.processId === 'number'
            ? {
                port: message.thread.port,
                data: message.thread.data,
                processId: message.thread.processId,
              }
            : undefined,
          message.execArgv,
          isOutputPipes(message.outputPipes) ? message.outputPipes : outputPipes,
          isStdioBindings(message.stdio) ? message.stdio : [null, 'inherit', 'inherit'],
        ).catch((error: unknown) => {
          if (message.ipcPort instanceof MessagePort) message.ipcPort.close();
          if (record(message.thread) && message.thread.port instanceof MessagePort)
            message.thread.port.close();
          port.postMessage({ type: 'error', version: VERSION, ...errorRecord(error) });
          port.close();
        });
      }
      if (message.type === 'publish-modules') {
        const reply = event.ports[0];
        if (!reply) return;
        try {
          if (message.version !== VERSION || !Array.isArray(message.modules))
            throw fault('EPROTO', 'Invalid module publication');
          if (process.modules.size + message.modules.length > this.policy.modules.countPerProcess)
            throw fault('E2BIG', 'Module count exceeds process limit');
          const entries = new Map<string, string>();
          let bytes = 0;
          for (const entry of message.modules) {
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== 'string' ||
              !entry[0].startsWith(`/__modules__/${this.id}/${pid}/`) ||
              typeof entry[1] !== 'string'
            )
              throw fault('EPROTO', 'Invalid module entry');
            const [url, source] = entry;
            const size = new TextEncoder().encode(source).length;
            bytes += size;
            if (
              size > this.policy.modules.sourceBytes ||
              process.moduleBytes + bytes > this.policy.modules.graphBytes
            )
              throw fault('E2BIG', 'Module source exceeds process limit');
            if (entries.has(url) || process.modules.has(url))
              throw fault('EEXIST', 'Module URL was already published');
            entries.set(url, source);
          }
          // Validate the entire graph before publishing any member. A failed
          // graph cannot strand dependency URLs and poison a later import.
          for (const [url, source] of entries) process.modules.set(url, source);
          process.moduleBytes += bytes;
          reply.postMessage({ ok: true });
        } catch (error) {
          reply.postMessage({ ok: false, error: errorRecord(error) });
        }
        reply.close();
      }
      if (
        message.type === 'output' &&
        (message.stream === 'stdout' || message.stream === 'stderr') &&
        message.bytes instanceof Uint8Array
      ) {
        handle.output(message.stream, message.bytes);
        bridge?.postMessage({ ...message, version: VERSION });
      }
      if (
        message.type === 'stdin-ack' &&
        message.version === VERSION &&
        typeof message.id === 'number'
      ) {
        const bytes = inputDeliveries.get(message.id);
        if (bytes !== undefined) {
          inputDeliveries.delete(message.id);
          inputBytes -= bytes;
          if (typeof message.error === 'string' && !inputFailed) {
            inputFailed = true;
            bridge?.postMessage({
              type: 'stdin-error',
              version: VERSION,
              error: message.error,
              code: message.code,
            });
          }
        }
      }
      if (
        thread &&
        message.version === VERSION &&
        (message.type === 'thread-online' || message.type === 'thread-error')
      )
        bridge?.postMessage(message);
      if (
        message.type === 'exit' &&
        typeof message.code === 'number' &&
        (message.signal === undefined ||
          message.signal === 'SIGTERM' ||
          message.signal === 'SIGINT' ||
          message.signal === 'SIGPIPE' ||
          message.signal === 'SIGKILL' ||
          message.signal === 'SIGABRT')
      )
        void this.finish(pid, message.code, message.signal);
    };
    worker.onerror = (event) => {
      const message =
        event.message ||
        `EASSET: Process worker failed (${new URL('process.js', this.assetBaseURL).href}); check assetBaseURL and hosting headers`;
      if (thread) {
        bridge?.postMessage({
          type: 'thread-error',
          version: VERSION,
          message,
          name: 'Error',
        });
        void this.finish(pid, 1);
        return;
      }
      const bytes = new TextEncoder().encode(message + '\n');
      handle.output('stderr', bytes);
      bridge?.postMessage({ type: 'output', version: VERSION, stream: 'stderr', bytes });
      void this.finish(pid, 1);
    };
    if (bridge) {
      bridge.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (
          record(message) &&
          message.version === VERSION &&
          message.type === 'stdin' &&
          typeof message.id === 'number' &&
          Number.isSafeInteger(message.id) &&
          (message.bytes === null || message.bytes instanceof Uint8Array)
        ) {
          try {
            if (message.id <= lastInputId) throw fault('EPROTO', 'Stale stdin write');
            lastInputId = message.id;
            if (inputEnded || inputFailed || !this.processes.has(pid))
              throw fault('EPIPE', 'Child stdin is closed');
            const bytes = message.bytes?.byteLength ?? 0;
            if (
              inputDeliveries.size >= this.policy.child.inputQueueDeliveries ||
              inputBytes + bytes > this.policy.child.inputQueueBytes
            )
              throw fault('E2BIG', 'Child input delivery queue exceeds limit');
            worker.postMessage(message);
            inputDeliveries.set(message.id, bytes);
            inputBytes += bytes;
            if (message.bytes === null) inputEnded = true;
            bridge.postMessage({ type: 'stdin-ack', version: VERSION, id: message.id });
          } catch (error) {
            const failure = errorRecord(error);
            bridge.postMessage({
              type: 'stdin-ack',
              version: VERSION,
              id: message.id,
              error: failure.message,
              code: failure.code,
            });
          }
        }
        if (record(event.data) && event.data.version === VERSION && event.data.type === 'kill') {
          const signal = event.data.signal;
          if (signal === undefined) void this.finish(pid, thread ? 1 : 137);
          else if (!thread && signal === 'SIGKILL') void this.finish(pid, 137, signal);
          else if (!thread && (signal === 'SIGTERM' || signal === 'SIGINT'))
            worker.postMessage({ type: 'signal', version: VERSION, signal });
        }
      };
      bridge.postMessage({ type: 'spawned', version: VERSION, pid });
    }
    worker.postMessage(
      {
        type: 'boot',
        version: VERSION,
        advisoryHeapLimit: this.advisoryHeapLimit,
        httpAgentMode: this.httpAgentMode,
        httpOmitHeaders: this.httpOmitHeaders,
        resources: this.policy,
        asyncContext: this.asyncContext,
        command,
        stdinPipe,
        pid,
        ipcPort,
        ipcSerialization,
        thread,
        argv,
        execArgv: startup.argv,
        options: { ...options, terminal: terminal?.device.dimensions },
        terminalFds: terminal?.fds,
        outputPipes,
        fileStdio,
        shared,
        moduleBase: new URL(`/__modules__/${this.id}/${pid}/`, location.origin).href,
        port: channel.port2,
      },
      [channel.port2, ...(ipcPort ? [ipcPort] : []), ...(thread ? [thread.port] : [])],
    );
    return handle;
  }
  private interruptTerminal(pid: number) {
    const device = this.processes.get(pid)?.terminal?.device;
    if (!device) return;
    device.interruptEpoch++;
    for (const process of this.processes.values())
      if (process.terminal?.device === device && process.interactiveShell)
        process.commandInterrupted = true;
    const roots = device.foreground.size ? device.foreground : new Set([device.owner]);
    const targets = [...this.processes].filter(([candidate]) => {
      for (
        let ancestor: number | undefined = candidate;
        ancestor !== undefined;
        ancestor = this.processes.get(ancestor)?.parent
      )
        if (roots.has(ancestor)) return true;
      return false;
    });
    for (const [target, process] of targets) {
      // Coalesce while delivery is unacknowledged: repeated input must not
      // extend a busy Worker's original termination deadline.
      if (process.interrupt) continue;
      const id = this.nextInterrupt++;
      // A busy Worker cannot dispatch JavaScript signal handlers. Give a
      // responsive guest a chance to handle SIGINT, then terminate its owner.
      const timer = setTimeout(() => {
        if (this.processes.get(target)?.interrupt?.id === id)
          void this.finish(target, 130, 'SIGINT');
      }, this.policy.timers.interruptGraceMs);
      process.interrupt = { id, timer };
      process.worker.postMessage({ type: 'signal', version: VERSION, signal: 'SIGINT', id });
    }
  }
  private async finish(
    pid: number,
    code: number,
    signal?: 'SIGTERM' | 'SIGKILL' | 'SIGPIPE' | 'SIGINT' | 'SIGABRT',
  ): Promise<void> {
    const process = this.processes.get(pid);
    if (!process) return;
    if (process.interrupt) clearTimeout(process.interrupt.timer);
    this.processes.delete(pid);
    for (const socket of this.sockets) if (socket.pid === pid) socket.close();
    for (const [port, policy] of this.previewPaths)
      if (policy.pid === pid) this.previewPaths.delete(port);
    process.worker.terminate();
    for (const [childPid, child] of this.processes)
      if (child.parent === pid) await this.finish(childPid, 137);
    // A response the guest had not started gets a 503; one already streaming
    // has its body errored, so the browser reader fails instead of waiting.
    this.streams.closeProcess(pid, 'Guest exited');
    try {
      if (!this.closed) await this.rpc({ op: 'remove', pid });
    } catch {
      // A failed kernel cleanup means this container cannot safely continue.
      await this.teardown();
    } finally {
      process.terminal?.device.foreground.delete(pid);
      process.bridge?.postMessage({ type: 'exit', version: VERSION, code, signal });
      process.bridge?.close();
      process.handle.complete(code);
    }
  }
  async teardown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.previewClientListeners.clear();
    this.installation.abort(fault('EPIPE', 'Container closed'));
    navigator.serviceWorker.removeEventListener('message', this.serviceMessage);
    navigator.serviceWorker.removeEventListener('controllerchange', this.serviceChange);
    for (const cancel of this.servicePending) cancel(fault('EPIPE', 'Container closed'));
    // Bridges tell their workers the host is gone and unregister them, bounded.
    const bridges = this.bridges?.close();
    try {
      this.serviceWorker?.postMessage({
        type: 'unregister',
        version: VERSION,
        containerId: this.id,
      });
    } catch {
      // A replaced controller may no longer accept messages. Remote notification
      // is best-effort; local kernel and process disposal must always continue.
    }
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(fault('EPIPE', 'Container closed'));
    }
    this.pending.clear();
    this.kernel.terminate();
    for (const [pid] of this.processes) await this.finish(pid, 137);
    this.streams.closeAll('Guest exited');
    await bridges;
  }
}
import { type OutputPipes, createOutputPipes, isOutputPipes } from './output-pipe';
export {
  installSandboxHost,
  installSandboxHost as serveSandboxHost,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxHostHandle,
  type SandboxHostOptions,
} from './sandbox-host';
export {
  SandboxContainer,
  connectSandboxContainer,
  type SandboxConnectOptions,
  type SandboxFilesystem,
  type SandboxProcess,
} from './sandbox-client';
