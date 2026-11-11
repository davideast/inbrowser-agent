import { DRIVER_PRELOAD_SOURCE } from '../preload/export.js';
import { DRIVER_CHANNEL, PROTOCOL_VERSION } from '../protocol.js';
import { type ConnectPortOptions, DriverError, type PageDriver } from '../types.js';
import { connectPortStream } from './preview-backend.js';

export interface ContainerPreviewOptions {
  readonly requestPath?: 'strip' | 'preserve';
  readonly webSocket?: boolean;
  readonly clientScript?: string;
}

export interface PreviewCapableContainer {
  preview(port: number, options?: ContainerPreviewOptions): Promise<string>;
  onPreviewClient(port: number, listener: (clientPort: MessagePort) => void): () => void;
}

export interface ConnectContainerPreviewOptions
  extends Omit<ConnectPortOptions, 'onPortReplacement'> {
  readonly iframe?: HTMLIFrameElement;
  readonly previewOptions?: Omit<ContainerPreviewOptions, 'clientScript'> & {
    readonly extraClientScript?: string;
  };
  readonly navigateIframe?: boolean;
}

export interface ConnectedContainerPreview {
  readonly previewUrl: string;
  readonly driver: PageDriver;
}

const PREVIEW_PORT_GLOBAL_KEY = '__inbrowserPreviewPort';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function awaitPreviewUrlWithBudget(
  previewPromise: Promise<string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new DriverError('DRIVER_TIMEOUT', 'Driver handshake aborted by signal.', {
          cause: signal.reason,
        }),
      );
      return;
    }

    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new DriverError('DRIVER_TIMEOUT', 'Driver handshake aborted by signal.', {
          cause: signal?.reason,
        }),
      );
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new DriverError(
          'DRIVER_TIMEOUT',
          `Driver handshake timed out after ${String(timeoutMs)}ms.`,
        ),
      );
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });

    previewPromise.then(
      (url) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(url);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

/**
 * Builds the self-contained preview client script injected into `200 text/html`
 * container preview documents via `PreviewOptions.clientScript`.
 *
 * Installs `DRIVER_PRELOAD_SOURCE`, consumes and deletes
 * `globalThis.__inbrowserPreviewPort`, and binds the `MessagePort` into the
 * preload's `bind_port` listener before any optional `extraClientScript` runs.
 */
export function buildContainerPreviewClientScript(extraClientScript?: string): string {
  if (DRIVER_PRELOAD_SOURCE.length === 0) {
    throw new DriverError(
      'DRIVER_PROTOCOL',
      'Preload source bundle is unavailable; build @inbrowser/driver before connecting.',
    );
  }
  const bindEnvelopeJson = JSON.stringify({
    channel: DRIVER_CHANNEL,
    kind: 'bind_port',
    protocolVersion: PROTOCOL_VERSION,
  });
  const bootstrapper =
    `;(() => {` +
    `const k=${JSON.stringify(PREVIEW_PORT_GLOBAL_KEY)};` +
    `const p=Reflect.get(globalThis,k);` +
    `if(p!==undefined){` +
    `Reflect.deleteProperty(globalThis,k);` +
    `if(typeof window==='object'&&window!==null&&typeof MessagePort==='function'&&p instanceof MessagePort){` +
    `window.postMessage(${bindEnvelopeJson},'*',[p]);` +
    `}` +
    `}` +
    `})();`;
  if (extraClientScript !== undefined && extraClientScript.length > 0) {
    return `${DRIVER_PRELOAD_SOURCE}\n${bootstrapper}\n${extraClientScript}`;
  }
  return `${DRIVER_PRELOAD_SOURCE}\n${bootstrapper}`;
}

/**
 * Connects a `PageDriver` directly to an `@inbrowser/node` `BrowserContainer` or
 * `SandboxContainer` HTTP preview port using `PreviewOptions.clientScript` and
 * `container.onPreviewClient(port, ...)`.
 */
export async function connectContainerPreview(
  container: PreviewCapableContainer,
  port: number,
  options: ConnectContainerPreviewOptions = {},
): Promise<ConnectedContainerPreview> {
  if (options.signal?.aborted) {
    throw new DriverError('DRIVER_TIMEOUT', 'Driver handshake aborted by signal.', {
      cause: options.signal.reason,
    });
  }

  const clientScript = buildContainerPreviewClientScript(options.previewOptions?.extraClientScript);
  const previewCallOptions: ContainerPreviewOptions = {
    ...(options.previewOptions?.requestPath !== undefined
      ? { requestPath: options.previewOptions.requestPath }
      : {}),
    ...(options.previewOptions?.webSocket !== undefined
      ? { webSocket: options.previewOptions.webSocket }
      : {}),
    clientScript,
  };

  let closed = false;
  const queuedPorts: MessagePort[] = [];
  let candidatePortSink: ((clientPort: MessagePort) => void) | null = null;
  let rebindSink: ((clientPort: MessagePort) => void) | null = null;

  const drainQueuedInto = (sink: (clientPort: MessagePort) => void): void => {
    while (queuedPorts.length > 1) {
      queuedPorts.shift()?.close();
    }
    const latest = queuedPorts.shift();
    if (latest !== undefined) {
      sink(latest);
    }
  };

  const unsubscribe = container.onPreviewClient(port, (clientPort) => {
    if (closed) {
      clientPort.close();
      return;
    }
    if (rebindSink !== null) {
      rebindSink(clientPort);
      return;
    }
    if (candidatePortSink !== null) {
      candidatePortSink(clientPort);
      return;
    }
    queuedPorts.push(clientPort);
  });

  const releaseSubscription = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    candidatePortSink = null;
    rebindSink = null;
    while (queuedPorts.length > 0) {
      queuedPorts.shift()?.close();
    }
    unsubscribe();
  };

  try {
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const startedAtMs = nowMs();
    const previewUrl = await awaitPreviewUrlWithBudget(
      container.preview(port, previewCallOptions),
      handshakeTimeoutMs,
      options.signal,
    );
    const elapsedMs = Math.max(0, Math.round(nowMs() - startedAtMs));
    const remainingHandshakeMs = Math.max(1, handshakeTimeoutMs - elapsedMs);

    const driver = await connectPortStream({
      handshakeTimeoutMs: remainingHandshakeMs,
      ...(options.rpcTimeoutMs !== undefined ? { rpcTimeoutMs: options.rpcTimeoutMs } : {}),
      ...(options.allowEval !== undefined ? { allowEval: options.allowEval } : {}),
      ...(options.displayMediaProvider !== undefined
        ? { displayMediaProvider: options.displayMediaProvider }
        : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.iframe !== undefined ? { iframe: options.iframe } : {}),
      rebindOnIframeLoad: false,
      subscribeCandidatePorts(onCandidatePort) {
        candidatePortSink = onCandidatePort;
        drainQueuedInto(onCandidatePort);
        if (options.iframe !== undefined && options.navigateIframe !== false) {
          options.iframe.src = previewUrl;
        }
        return () => {
          if (candidatePortSink === onCandidatePort) {
            candidatePortSink = null;
          }
        };
      },
      onPortReplacement(rebind) {
        rebindSink = rebind;
        drainQueuedInto(rebind);
        return () => {
          releaseSubscription();
        };
      },
    });

    return { previewUrl, driver };
  } catch (err) {
    releaseSubscription();
    throw err;
  }
}

/** Alias for {@link connectContainerPreview} when connecting a `SandboxContainer` preview. */
export const connectSandboxPreview = connectContainerPreview;
