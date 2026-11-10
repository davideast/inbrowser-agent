import { validateDescriptorReadLimit } from './descriptor-read-limit';
import type { FilesystemChange } from './filesystem-watch';
import { validateHttpResponseLimit } from './http-response-limit';
import {
  type BootOptions,
  BrowserContainer,
  type FilesystemSnapshot,
  type MountEntry,
  type PreviewOptions,
  type ResourcePolicy,
  type ResourcePolicyOverrides,
  type SpawnOptions,
} from './index';
import { VERSION, errorRecord, fault, record } from './protocol';
import {
  DEFAULT_RESOURCE_POLICY,
  aliasResourceOverrides,
  intersectHttpEgressPolicies,
  resolveResourcePolicy,
  validateHttpEgressPolicy,
} from './resource-policy';
import { terminalDimensions } from './terminal';
import { validateUnzipLimit } from './unzip-limit';

export const SANDBOX_PROTOCOL_VERSION = 1;

export interface SandboxHostOptions {
  /**
   * Parent origins permitted to establish a `SandboxContainer` session with
   * this host frame (for example `['https://app.example.com']`), or `['*']` to
   * accept any parent origin.
   */
  allowedParentOrigins: readonly string[];
  /**
   * Host-enforced `BootOptions` applied to every booted container. Privileged
   * host fields (`preview`, `httpAgentMode`, `httpOmitHeaders`, `assetBaseURL`,
   * `serviceWorker`) come exclusively from `bootOptions`; client-supplied
   * `resources` and HTTP egress options can only tighten—never widen—host or
   * `DEFAULT_RESOURCE_POLICY` ceilings.
   */
  bootOptions?: BootOptions;
  /** Whether client-supplied `BootOptions` are accepted (default `true`). */
  allowClientBootOptions?: boolean;
  /** Maximum concurrent `SandboxContainer` sessions on this host frame (default `1`). */
  maxSessions?: number;
}

export interface SandboxHostHandle {
  dispose(): Promise<void>;
}

const BOOT_OPTION_KEYS = new Set([
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
]);

function closePorts(ports: readonly MessagePort[], startIndex = 0): void {
  for (let i = startIndex; i < ports.length; i++) ports[i]?.close();
}

function parseAllowedParentOrigins(value: unknown): Set<string> | '*' {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    throw fault(
      'EINVAL',
      'installSandboxHost requires a non-empty allowedParentOrigins array (at most 64 origins)',
    );
  if (value.length === 1 && value[0] === '*') return '*';
  const origins = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string')
      throw fault('EINVAL', 'allowedParentOrigins entries must be origin strings');
    let parsed: URL;
    try {
      parsed = new URL(item);
    } catch {
      throw fault('EINVAL', `Invalid parent origin: ${item}`);
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== item
    )
      throw fault('EINVAL', `allowedParentOrigins entry must be an exact http(s) origin: ${item}`);
    origins.add(parsed.origin);
  }
  return origins;
}

function isOriginPermitted(origin: string, allowed: Set<string> | '*'): boolean {
  if (!origin || origin === 'null') return false;
  if (allowed === '*') return true;
  return allowed.has(origin);
}

function foldAliases(raw: BootOptions): ResourcePolicyOverrides | undefined {
  return aliasResourceOverrides(raw.resources, {
    ...(raw.httpResponseLimit !== undefined
      ? { httpResponseLimit: validateHttpResponseLimit(raw.httpResponseLimit) }
      : {}),
    ...(raw.unzipLimit !== undefined ? { unzipLimit: validateUnzipLimit(raw.unzipLimit) } : {}),
    ...(raw.descriptorReadLimit !== undefined
      ? { descriptorReadLimit: validateDescriptorReadLimit(raw.descriptorReadLimit) }
      : {}),
  });
}

function foldClientAliases(raw: Record<string, unknown>): ResourcePolicyOverrides | undefined {
  const resourcesRaw = raw.resources;
  if (resourcesRaw !== undefined && !record(resourcesRaw))
    throw fault('EINVAL', 'Expected an object for resources');
  // Invariant: resolveResourcePolicy validates every group, key, and numeric range on resourcesRaw.
  return aliasResourceOverrides(resourcesRaw as ResourcePolicyOverrides | undefined, {
    ...(raw.httpResponseLimit !== undefined
      ? { httpResponseLimit: validateHttpResponseLimit(raw.httpResponseLimit) }
      : {}),
    ...(raw.unzipLimit !== undefined ? { unzipLimit: validateUnzipLimit(raw.unzipLimit) } : {}),
    ...(raw.descriptorReadLimit !== undefined
      ? { descriptorReadLimit: validateDescriptorReadLimit(raw.descriptorReadLimit) }
      : {}),
  });
}

function clampResourceOverrides(
  clientOverrides: ResourcePolicyOverrides | undefined,
  clientValidated: ResourcePolicy,
  hostCeilings: ResourcePolicy,
): ResourcePolicyOverrides {
  const clamped: Record<string, Record<string, number>> = {};
  for (const [group, ceilingGroup] of Object.entries(hostCeilings)) {
    const rawClientGroup: unknown = record(clientOverrides)
      ? Reflect.get(clientOverrides, group)
      : undefined;
    const validatedClientGroup: unknown = Reflect.get(clientValidated, group);
    const outGroup: Record<string, number> = {};
    if (record(ceilingGroup) && record(validatedClientGroup)) {
      for (const [key, ceilingVal] of Object.entries(ceilingGroup)) {
        if (typeof ceilingVal !== 'number') continue;
        const clientSpecified =
          record(rawClientGroup) && Reflect.get(rawClientGroup, key) !== undefined;
        const clientVal = Reflect.get(validatedClientGroup, key);
        outGroup[key] =
          clientSpecified && typeof clientVal === 'number'
            ? Math.min(clientVal, ceilingVal)
            : ceilingVal;
      }
    }
    clamped[group] = outGroup;
  }
  // Invariant: clamped mirrors every group and numeric key of ResourcePolicy with validated positive integer or UNBOUNDED bounds.
  return clamped as ResourcePolicyOverrides;
}

function mergeBootOptions(clientRaw: unknown, hostBoot: BootOptions | undefined): BootOptions {
  if (clientRaw !== undefined) {
    if (
      !record(clientRaw) ||
      Object.keys(clientRaw).some((key) => !BOOT_OPTION_KEYS.has(key)) ||
      (clientRaw.asyncContext !== undefined && clientRaw.asyncContext !== 'experimental')
    )
      throw fault('EINVAL', 'Invalid client bootOptions');
  }

  const hostCeilings = resolveResourcePolicy(foldAliases(hostBoot ?? {}));
  const clientOverrides = record(clientRaw) ? foldClientAliases(clientRaw) : undefined;
  const clientValidated = resolveResourcePolicy(clientOverrides);
  const clampedResources = clampResourceOverrides(clientOverrides, clientValidated, hostCeilings);

  const hostEgress = hostBoot
    ? validateHttpEgressPolicy(
        hostBoot.httpEgress,
        hostBoot.httpAllowedHosts,
        hostBoot.httpBlockedHosts,
      )
    : undefined;
  if (record(clientRaw) && clientRaw.httpEgress !== undefined) {
    if (
      !record(clientRaw.httpEgress) ||
      Object.keys(clientRaw.httpEgress).some(
        (key) => key !== 'allowedHosts' && key !== 'blockedHosts',
      )
    )
      throw fault('EINVAL', 'Invalid HTTP egress policy');
  }
  const clientEgress = record(clientRaw)
    ? validateHttpEgressPolicy(
        clientRaw.httpEgress,
        clientRaw.httpAllowedHosts,
        clientRaw.httpBlockedHosts,
      )
    : undefined;
  const effectiveEgress = intersectHttpEgressPolicies(hostEgress, clientEgress);

  const clientAsyncContext =
    record(clientRaw) && clientRaw.asyncContext === 'experimental' ? 'experimental' : undefined;
  const asyncContext = hostBoot?.asyncContext ?? clientAsyncContext;

  return {
    ...(asyncContext !== undefined ? { asyncContext } : {}),
    ...(hostBoot?.assetBaseURL !== undefined ? { assetBaseURL: hostBoot.assetBaseURL } : {}),
    ...(hostBoot?.serviceWorker !== undefined ? { serviceWorker: hostBoot.serviceWorker } : {}),
    ...(hostBoot?.httpAgentMode !== undefined ? { httpAgentMode: hostBoot.httpAgentMode } : {}),
    ...(hostBoot?.httpOmitHeaders !== undefined
      ? { httpOmitHeaders: hostBoot.httpOmitHeaders }
      : {}),
    ...(hostBoot?.preview !== undefined ? { preview: hostBoot.preview } : {}),
    resources: clampedResources,
    ...(effectiveEgress !== undefined ? { httpEgress: effectiveEgress } : {}),
  };
}

async function pumpProcessStream(
  stream: ReadableStream<Uint8Array>,
  channelName: 'stdout' | 'stderr',
  port: MessagePort,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      port.postMessage({
        sandbox: SANDBOX_PROTOCOL_VERSION,
        version: VERSION,
        type: 'output',
        stream: channelName,
        bytes: step.value,
      });
    }
  } catch {
    /* Stream cancelled on process teardown. */
  } finally {
    reader.releaseLock();
  }
}

async function startWatchSession(
  container: BrowserContainer,
  request: Record<string, unknown>,
  attachedPort: MessagePort | undefined,
  watchers: Map<string, () => Promise<void>>,
  pendingWatchTokens: Set<string>,
  isSessionClosed: () => boolean,
): Promise<void> {
  if (
    typeof request.path !== 'string' ||
    typeof request.token !== 'string' ||
    !(attachedPort instanceof MessagePort)
  )
    throw fault('EINVAL', 'Invalid watch request');
  const token = request.token;
  if (token.length < 1 || token.length > 128)
    throw fault('EINVAL', 'Watch token must be between 1 and 128 characters');
  if (watchers.has(token) || pendingWatchTokens.has(token))
    throw fault('EEXIST', 'Duplicate watch token');

  let watchOpts: { recursive?: boolean } | undefined;
  if (request.options !== undefined) {
    if (!record(request.options)) throw fault('EINVAL', 'Invalid watch options');
    // Invariant: container.fs.watch validates keys and boolean recursive flag.
    watchOpts = request.options as { recursive?: boolean };
  }

  pendingWatchTokens.add(token);
  let stream: ReadableStream<FilesystemChange>;
  try {
    stream = await container.fs.watch(request.path, watchOpts);
  } finally {
    pendingWatchTokens.delete(token);
  }

  const reader = stream.getReader();
  if (isSessionClosed()) {
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* Already released. */
    }
    attachedPort.close();
    throw fault('EPIPE', 'Sandbox container closed');
  }

  let watcherClosed = false;
  const cleanupWatcher = async () => {
    if (watcherClosed) return;
    watcherClosed = true;
    watchers.delete(token);
    attachedPort.onmessage = null;
    try {
      await reader.cancel().catch(() => undefined);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* Reader already released. */
      }
      attachedPort.close();
    }
  };
  watchers.set(token, cleanupWatcher);

  let pumping = false;
  let credits = 0;
  const pumpWatch = async () => {
    if (pumping || watcherClosed) return;
    pumping = true;
    let shouldClose = false;
    try {
      while (credits > 0 && !watcherClosed) {
        credits--;
        const next = await reader.read();
        if (watcherClosed) break;
        if (next.done) {
          shouldClose = true;
          break;
        }
        attachedPort.postMessage({
          version: VERSION,
          type: 'event',
          event: next.value.event,
          filename: next.value.filename,
        });
      }
    } catch (watchErr) {
      if (!watcherClosed) {
        try {
          attachedPort.postMessage({
            version: VERSION,
            type: 'error',
            error: errorRecord(watchErr),
          });
        } catch {
          /* Port already closed. */
        }
        shouldClose = true;
      }
    } finally {
      pumping = false;
      if (shouldClose) await cleanupWatcher();
    }
  };

  attachedPort.onmessage = (watchMsg: MessageEvent<unknown>) => {
    closePorts(watchMsg.ports);
    if (watcherClosed) return;
    const data = watchMsg.data;
    if (
      !record(data) ||
      data.version !== VERSION ||
      (data.sandbox !== undefined && data.sandbox !== SANDBOX_PROTOCOL_VERSION) ||
      (data.type !== 'next' && data.type !== 'close')
    ) {
      try {
        attachedPort.postMessage({
          version: VERSION,
          type: 'error',
          error: errorRecord(fault('EPROTO', 'Invalid watcher request')),
        });
      } catch {
        /* Port already closed. */
      }
      void cleanupWatcher();
      return;
    }
    if (data.type === 'close') {
      void cleanupWatcher();
      return;
    }
    credits++;
    void pumpWatch();
  };
}

async function startProcessSession(
  container: BrowserContainer,
  request: Record<string, unknown>,
  attachedPort: MessagePort | undefined,
  processCleanups: Set<() => void>,
  isSessionClosed: () => boolean,
): Promise<{ pid: number; hasStdin: boolean; hasTerminal: boolean }> {
  if (
    typeof request.command !== 'string' ||
    !Array.isArray(request.argv) ||
    !request.argv.every((arg): arg is string => typeof arg === 'string') ||
    !(attachedPort instanceof MessagePort)
  )
    throw fault('EINVAL', 'Invalid spawn request');
  let spawnOpts: SpawnOptions | undefined;
  if (request.options !== undefined) {
    if (!record(request.options)) throw fault('EINVAL', 'Invalid spawn options');
    // Invariant: BrowserContainer.spawn validates stdin, terminal, cwd, and env fields.
    spawnOpts = request.options as SpawnOptions;
  }

  const proc = await container.spawn(request.command, request.argv, spawnOpts);
  if (isSessionClosed()) {
    await proc.kill().catch(() => undefined);
    attachedPort.close();
    throw fault('EPIPE', 'Sandbox container closed');
  }

  const stdinWriter = proc.stdin ? proc.stdin.getWriter() : null;
  let stdinClosed = false;
  let procDisposed = false;

  const cleanupProcessPort = () => {
    if (procDisposed) return;
    procDisposed = true;
    processCleanups.delete(cleanupProcessPort);
    if (stdinWriter) {
      try {
        stdinWriter.releaseLock();
      } catch {
        /* Writer lock already released. */
      }
    }
    attachedPort.onmessage = null;
    attachedPort.close();
  };
  processCleanups.add(cleanupProcessPort);

  attachedPort.onmessage = (procEvent: MessageEvent<unknown>) => {
    closePorts(procEvent.ports);
    if (procDisposed) return;
    const msg = procEvent.data;
    if (
      !record(msg) ||
      msg.sandbox !== SANDBOX_PROTOCOL_VERSION ||
      msg.version !== VERSION ||
      typeof msg.id !== 'number' ||
      !Number.isSafeInteger(msg.id) ||
      msg.id < 1 ||
      typeof msg.op !== 'string'
    )
      return;
    const msgId = msg.id;
    void (async () => {
      try {
        if (procDisposed) throw fault('EPIPE', 'Process channel closed');
        if (msg.op === 'stdin') {
          if (!stdinWriter || stdinClosed) throw fault('EPIPE', 'Process stdin is closed');
          if (msg.bytes === null) {
            stdinClosed = true;
            await stdinWriter.close();
          } else if (msg.bytes instanceof Uint8Array) {
            await stdinWriter.write(msg.bytes);
          } else {
            throw fault('EINVAL', 'stdin expects Uint8Array or null');
          }
        } else if (msg.op === 'kill') {
          await proc.kill();
        } else if (msg.op === 'resize') {
          proc.resize(terminalDimensions(msg.dimensions));
        } else {
          throw fault('ENOSYS', `Unsupported process operation: ${msg.op}`);
        }
        if (!procDisposed) {
          attachedPort.postMessage({
            sandbox: SANDBOX_PROTOCOL_VERSION,
            version: VERSION,
            id: msgId,
            ok: true,
            value: undefined,
          });
        }
      } catch (procErr) {
        if (!procDisposed) {
          attachedPort.postMessage({
            sandbox: SANDBOX_PROTOCOL_VERSION,
            version: VERSION,
            id: msgId,
            ok: false,
            error: errorRecord(procErr),
          });
        }
      }
    })();
  };

  const stdoutDone = pumpProcessStream(proc.stdoutStream, 'stdout', attachedPort);
  const stderrDone = pumpProcessStream(proc.stderrStream, 'stderr', attachedPort);
  void Promise.all([proc.exit, stdoutDone, stderrDone]).then(([exitCode]) => {
    if (procDisposed) return;
    try {
      attachedPort.postMessage({
        sandbox: SANDBOX_PROTOCOL_VERSION,
        version: VERSION,
        type: 'exit',
        code: exitCode,
      });
    } finally {
      cleanupProcessPort();
    }
  });

  return {
    pid: proc.pid,
    hasStdin: proc.stdin !== null,
    hasTerminal: spawnOpts?.terminal !== undefined,
  };
}

export function installSandboxHost(options: SandboxHostOptions): SandboxHostHandle {
  if (!record(options)) throw fault('EINVAL', 'SandboxHostOptions object is required');
  if (
    options.allowClientBootOptions !== undefined &&
    typeof options.allowClientBootOptions !== 'boolean'
  )
    throw fault('EINVAL', 'allowClientBootOptions must be a boolean');
  if (
    options.maxSessions !== undefined &&
    (typeof options.maxSessions !== 'number' ||
      !Number.isSafeInteger(options.maxSessions) ||
      options.maxSessions < 1)
  )
    throw fault('EINVAL', 'maxSessions must be a positive safe integer');

  const maxSessions = options.maxSessions ?? 1;
  const allowedOrigins = parseAllowedParentOrigins(options.allowedParentOrigins);
  let hostDisposed = false;
  let startingSessions = 0;
  const activeSessions = new Set<() => Promise<void>>();

  const announceReady = (targetOrigin: string) => {
    if (typeof window === 'undefined' || window.parent === window) return;
    try {
      window.parent.postMessage(
        {
          sandbox: SANDBOX_PROTOCOL_VERSION,
          version: VERSION,
          type: 'sandbox-host-ready',
        },
        targetOrigin,
      );
    } catch {
      /* Parent frame navigated or disallowed targetOrigin. */
    }
  };

  const attachSession = async (port: MessagePort, clientBootRaw: unknown) => {
    let container: BrowserContainer;
    let mergedBoot: BootOptions;
    try {
      mergedBoot = mergeBootOptions(
        options.allowClientBootOptions === false ? undefined : clientBootRaw,
        options.bootOptions,
      );
      container = await BrowserContainer.boot(mergedBoot);
    } catch (error) {
      startingSessions--;
      try {
        port.postMessage({
          sandbox: SANDBOX_PROTOCOL_VERSION,
          version: VERSION,
          id: 0,
          ok: false,
          error: errorRecord(error),
        });
      } finally {
        port.close();
      }
      return;
    }

    const effectivePolicy =
      mergedBoot.resources !== undefined
        ? resolveResourcePolicy(mergedBoot.resources)
        : DEFAULT_RESOURCE_POLICY;

    let sessionClosed = false;
    const isSessionClosed = () => sessionClosed;
    const watchers = new Map<string, () => Promise<void>>();
    const pendingWatchTokens = new Set<string>();
    const processCleanups = new Set<() => void>();
    const previewListeners = new Map<number, () => void>();

    const closeSession = async () => {
      if (sessionClosed) return;
      sessionClosed = true;
      activeSessions.delete(closeSession);
      port.onmessage = null;
      for (const unsub of previewListeners.values()) unsub();
      previewListeners.clear();
      const closingWatchers = Array.from(watchers.values(), (cleanup) => cleanup());
      watchers.clear();
      await Promise.all(closingWatchers);
      for (const cleanupProc of Array.from(processCleanups)) cleanupProc();
      processCleanups.clear();
      port.close();
      await container.teardown();
    };
    activeSessions.add(closeSession);
    startingSessions--;

    if (hostDisposed) {
      await closeSession();
      return;
    }

    port.onmessage = (event: MessageEvent<unknown>) => {
      closePorts(event.ports, 1);
      const request = event.data;
      const attachedPort = event.ports[0];
      if (
        !record(request) ||
        request.sandbox !== SANDBOX_PROTOCOL_VERSION ||
        request.version !== VERSION ||
        typeof request.id !== 'number' ||
        !Number.isSafeInteger(request.id) ||
        request.id < 1 ||
        typeof request.op !== 'string'
      ) {
        attachedPort?.close();
        return;
      }
      const reqId = request.id;
      const op = request.op;
      if (op !== 'spawn' && op !== 'fs.watch') attachedPort?.close();

      void (async () => {
        try {
          if (sessionClosed) throw fault('EPIPE', 'Sandbox container closed');
          let value: unknown;
          if (op === 'dispose') {
            port.postMessage({
              sandbox: SANDBOX_PROTOCOL_VERSION,
              version: VERSION,
              id: reqId,
              ok: true,
              value: undefined,
            });
            await closeSession();
            return;
          }
          if (op === 'resources') {
            value = await container.resources();
          } else if (op === 'mount') {
            if (!record(request.files)) throw fault('EINVAL', 'mount requires a files object');
            // Invariant: BrowserContainer.mount runs parseMountEntries on the record before RPC dispatch.
            await container.mount(request.files as Record<string, MountEntry>);
          } else if (op === 'snapshot') {
            value = await container.snapshot();
          } else if (op === 'restore') {
            if (!record(request.snapshot))
              throw fault('EINVAL', 'restore requires a snapshot object');
            // Invariant: BrowserContainer.restore runs parseSnapshot with container bounds before RPC dispatch.
            await container.restore(request.snapshot as unknown as FilesystemSnapshot);
          } else if (op === 'preview') {
            if (typeof request.port !== 'number') throw fault('EINVAL', 'Invalid preview port');
            let previewOpts: PreviewOptions | undefined;
            if (request.options !== undefined) {
              if (!record(request.options)) throw fault('EINVAL', 'Invalid preview options');
              // Invariant: BrowserContainer.preview validates option keys and field types.
              previewOpts = request.options as PreviewOptions;
            }
            value = await container.preview(request.port, previewOpts);
          } else if (op === 'preview.listen') {
            if (
              typeof request.port !== 'number' ||
              !Number.isInteger(request.port) ||
              request.port < 1 ||
              request.port > 65535
            )
              throw fault('EINVAL', 'Invalid preview port');
            const listenPort = request.port;
            if (!previewListeners.has(listenPort)) {
              const unsub = container.onPreviewClient(listenPort, (clientPort) => {
                if (sessionClosed) {
                  clientPort.close();
                  return;
                }
                try {
                  port.postMessage(
                    {
                      sandbox: SANDBOX_PROTOCOL_VERSION,
                      version: VERSION,
                      type: 'preview-client',
                      port: listenPort,
                    },
                    [clientPort],
                  );
                } catch {
                  clientPort.close();
                }
              });
              previewListeners.set(listenPort, unsub);
            }
          } else if (op === 'preview.unlisten') {
            if (typeof request.port === 'number') {
              const unsub = previewListeners.get(request.port);
              if (unsub) {
                previewListeners.delete(request.port);
                unsub();
              }
            }
          } else if (op === 'install') {
            if (!record(request.options) || typeof request.options.cwd !== 'string')
              throw fault('EINVAL', 'Install options require cwd');
            await container.install({
              cwd: request.options.cwd,
              ...(typeof request.options.omitOptional === 'boolean'
                ? { omitOptional: request.options.omitOptional }
                : {}),
            });
          } else if (op === 'fs.readFile') {
            if (typeof request.path !== 'string') throw fault('EINVAL', 'Invalid path');
            const enc =
              request.encoding === undefined
                ? undefined
                : request.encoding === 'utf8'
                  ? 'utf8'
                  : (() => {
                      throw fault('EINVAL', 'Unsupported encoding');
                    })();
            value = await container.fs.readFile(request.path, enc);
          } else if (op === 'fs.writeFile') {
            if (
              typeof request.path !== 'string' ||
              (typeof request.data !== 'string' && !(request.data instanceof Uint8Array))
            )
              throw fault('EINVAL', 'Invalid writeFile arguments');
            await container.fs.writeFile(request.path, request.data);
          } else if (op === 'fs.readdir') {
            if (typeof request.path !== 'string') throw fault('EINVAL', 'Invalid path');
            value = await container.fs.readdir(request.path);
          } else if (op === 'fs.stat') {
            if (typeof request.path !== 'string') throw fault('EINVAL', 'Invalid path');
            value = await container.fs.stat(request.path);
          } else if (op === 'fs.lstat') {
            if (typeof request.path !== 'string') throw fault('EINVAL', 'Invalid path');
            value = await container.fs.lstat(request.path);
          } else if (op === 'fs.mkdir') {
            if (typeof request.path !== 'string') throw fault('EINVAL', 'Invalid path');
            let mkdirOpts: { recursive?: boolean; mode?: number } | undefined;
            if (request.options !== undefined) {
              if (!record(request.options)) throw fault('EINVAL', 'Invalid mkdir options');
              // Invariant: container.fs.mkdir validates keys, boolean recursive, and mode integer bounds.
              mkdirOpts = request.options as { recursive?: boolean; mode?: number };
            }
            await container.fs.mkdir(request.path, mkdirOpts);
          } else if (op === 'fs.rename') {
            if (typeof request.oldPath !== 'string' || typeof request.newPath !== 'string')
              throw fault('EINVAL', 'Invalid rename paths');
            await container.fs.rename(request.oldPath, request.newPath);
          } else if (op === 'fs.rm') {
            if (typeof request.path !== 'string') throw fault('EINVAL', 'Invalid path');
            let rmOpts: { recursive?: boolean; force?: boolean } | undefined;
            if (request.options !== undefined) {
              if (!record(request.options)) throw fault('EINVAL', 'Invalid rm options');
              // Invariant: container.fs.rm validates keys and boolean flags before RPC dispatch.
              rmOpts = request.options as { recursive?: boolean; force?: boolean };
            }
            await container.fs.rm(request.path, rmOpts);
          } else if (op === 'fs.watch') {
            await startWatchSession(
              container,
              request,
              attachedPort,
              watchers,
              pendingWatchTokens,
              isSessionClosed,
            );
          } else if (op === 'fs.unwatch') {
            if (typeof request.token === 'string') {
              const cleanup = watchers.get(request.token);
              if (cleanup) await cleanup();
            }
          } else if (op === 'spawn') {
            value = await startProcessSession(
              container,
              request,
              attachedPort,
              processCleanups,
              isSessionClosed,
            );
          } else {
            throw fault('ENOSYS', `Unsupported sandbox RPC operation: ${op}`);
          }
          if (!sessionClosed) {
            port.postMessage({
              sandbox: SANDBOX_PROTOCOL_VERSION,
              version: VERSION,
              id: reqId,
              ok: true,
              value,
            });
          }
        } catch (error) {
          if (op === 'spawn' || op === 'fs.watch') attachedPort?.close();
          if (!sessionClosed) {
            port.postMessage({
              sandbox: SANDBOX_PROTOCOL_VERSION,
              version: VERSION,
              id: reqId,
              ok: false,
              error: errorRecord(error),
            });
          }
        }
      })();
    };

    port.postMessage({
      sandbox: SANDBOX_PROTOCOL_VERSION,
      version: VERSION,
      id: 0,
      ok: true,
      value: {
        containerId: container.id,
        origin: location.origin,
        stdinChunkBytes: effectivePolicy.child.stdinChunkBytes,
        captureBytes: effectivePolicy.child.captureBytes,
        snapshotEntries: effectivePolicy.snapshot.entries,
        snapshotBytes: effectivePolicy.snapshot.bytes,
      },
    });
  };

  const onWindowMessage = (event: MessageEvent<unknown>) => {
    if (typeof window === 'undefined' || event.source !== window.parent || window.parent === window)
      return;
    if (hostDisposed || !isOriginPermitted(event.origin, allowedOrigins)) {
      closePorts(event.ports);
      return;
    }
    const data = event.data;
    if (!record(data) || data.sandbox !== SANDBOX_PROTOCOL_VERSION) {
      closePorts(event.ports);
      return;
    }
    if (data.version !== VERSION) {
      closePorts(event.ports, 1);
      const replyPort = event.ports[0];
      if (replyPort) {
        try {
          replyPort.postMessage({
            sandbox: SANDBOX_PROTOCOL_VERSION,
            version: VERSION,
            id: 0,
            ok: false,
            error: errorRecord(
              fault(
                'EPROTO',
                'Incompatible sandbox runtime protocol version; serve matching assets',
              ),
            ),
          });
        } finally {
          replyPort.close();
        }
      }
      return;
    }
    if (data.type === 'sandbox-ping') {
      closePorts(event.ports);
      announceReady(event.origin);
      return;
    }
    if (data.type === 'sandbox-connect') {
      closePorts(event.ports, 1);
      const connectPort = event.ports[0];
      if (!(connectPort instanceof MessagePort)) return;
      const inFlight = activeSessions.size + startingSessions;
      if (inFlight >= maxSessions) {
        try {
          connectPort.postMessage({
            sandbox: SANDBOX_PROTOCOL_VERSION,
            version: VERSION,
            id: 0,
            ok: false,
            error: errorRecord(
              fault('EBUSY', 'Sandbox host session limit reached', {
                kind: 'limit',
                limit: maxSessions,
                actual: inFlight + 1,
              }),
            ),
          });
        } finally {
          connectPort.close();
        }
        return;
      }
      startingSessions++;
      void attachSession(connectPort, data.bootOptions);
      return;
    }
    closePorts(event.ports);
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('message', onWindowMessage);
    if (allowedOrigins === '*') announceReady('*');
    else for (const origin of allowedOrigins) announceReady(origin);
  }

  return {
    async dispose(): Promise<void> {
      if (hostDisposed) return;
      hostDisposed = true;
      if (typeof window !== 'undefined') window.removeEventListener('message', onWindowMessage);
      await Promise.all(Array.from(activeSessions, (close) => close()));
    },
  };
}
