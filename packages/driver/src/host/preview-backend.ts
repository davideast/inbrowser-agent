import {
  type CaptureRpcParams,
  DRIVER_CHANNEL,
  type DriverHelloMessage,
  type DriverNavigatingMessage,
  type DriverRpcMethod,
  type DriverRpcRequest,
  type ObserveRpcParams,
  PROTOCOL_VERSION,
  isActResult,
  isCaptureResult,
  isDriverChannelEnvelope,
  isDriverHelloAck,
  isDriverNavigating,
  isDriverRpcResponse,
  isEvalResult,
  isObservationSnapshot,
} from '../protocol.js';
import {
  type ActOptions,
  type ActResult,
  type CaptureBackendMode,
  type CaptureOptions,
  type CaptureResult,
  type ConnectIframeOptions,
  type ConnectPortOptions,
  type DiagnosticsDelta,
  type DriverCapabilities,
  DriverError,
  type EvalOptions,
  type EvalResult,
  type ObservationOptions,
  type ObservationSnapshot,
  type PageDriver,
} from '../types.js';
import { type HostCaptureSeamContext, createHostCaptureSeam } from './capture-seam.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

let nextDriverSessionSeq = 1;

interface InternalConnectOptions extends ConnectPortOptions {
  readonly iframe?: HTMLIFrameElement;
  readonly targetOrigin?: string;
  readonly rebindOnIframeLoad?: boolean;
}

export interface ConnectPortStreamOptions extends ConnectPortOptions {
  readonly iframe?: HTMLIFrameElement;
  readonly rebindOnIframeLoad?: boolean;
  readonly subscribeCandidatePorts: (onCandidatePort: (port: MessagePort) => void) => () => void;
}

interface RpcCallExecutionOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly actMeta?: { readonly rev: number; readonly totalSteps: number };
}

interface PendingRpcEntry {
  readonly id: number;
  readonly method: DriverRpcMethod;
  readonly request: DriverRpcRequest;
  readonly actMeta?: { readonly rev: number; readonly totalSteps: number };
  navigatingInfo?: DriverNavigatingMessage;
  readonly cleanup: () => void;
  readonly resolve: (result: unknown) => void;
  readonly reject: (err: DriverError) => void;
}

interface HelloEnvelopeOptions {
  readonly sessionId?: string;
  readonly rebindOnlyIfUnbound?: boolean;
  readonly minRev?: number;
}

function buildHelloMessage(allowEval: boolean, extra?: HelloEnvelopeOptions): DriverHelloMessage {
  return {
    channel: DRIVER_CHANNEL,
    kind: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    allowEval,
    ...(extra?.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
    ...(extra?.rebindOnlyIfUnbound !== undefined
      ? { rebindOnlyIfUnbound: extra.rebindOnlyIfUnbound }
      : {}),
    ...(extra?.minRev !== undefined ? { minRev: extra.minRev } : {}),
  };
}

function mergeDiagnostics(
  before: DiagnosticsDelta | undefined,
  after: DiagnosticsDelta,
): DiagnosticsDelta {
  if (!before) return after;
  return {
    compileOverlay: after.compileOverlay ?? before.compileOverlay,
    consoleErrors: [...before.consoleErrors, ...after.consoleErrors],
    pageErrors: [...before.pageErrors, ...after.pageErrors],
    networkFailures: [...before.networkFailures, ...after.networkFailures],
  };
}

function stripObserveOptions(options?: ObservationOptions): ObserveRpcParams | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.includeAllText !== undefined ? { includeAllText: options.includeAllText } : {}),
  };
}

function createPreviewPortDriver(
  initialPort: MessagePort,
  preloadCapabilities: DriverCapabilities,
  options: InternalConnectOptions,
  sessionId: string,
): PageDriver {
  const defaultRpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const allowEval = options.allowEval ?? preloadCapabilities.allowEval;
  let activePort = initialPort;
  let nextRequestId = 1;
  let highestRev = 0;
  let disposed = false;
  const pending = new Map<number, PendingRpcEntry>();

  let candidatePort: MessagePort | null = null;
  let candidateListener: ((event: MessageEvent<unknown>) => void) | null = null;

  const releaseCandidate = (): void => {
    if (candidatePort !== null && candidateListener !== null) {
      candidatePort.removeEventListener('message', candidateListener);
    }
    if (candidatePort !== null) {
      candidatePort.close();
    }
    candidatePort = null;
    candidateListener = null;
  };

  const trackRev = (rev: number): void => {
    if (rev > highestRev) highestRev = rev;
  };

  const onPortMessage = (event: MessageEvent<unknown>): void => {
    const payload: unknown = event.data;
    if (isDriverNavigating(payload)) {
      const entry = pending.get(payload.id);
      if (entry !== undefined && entry.method === 'act') {
        entry.navigatingInfo = payload;
        trackRev(payload.fromRev);
      }
      return;
    }
    if (!isDriverRpcResponse(payload)) {
      return;
    }
    const entry = pending.get(payload.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(payload.id);
    entry.cleanup();
    if (payload.ok) {
      entry.resolve(payload.result);
      return;
    }
    entry.reject(
      new DriverError(payload.error.code, payload.error.message, {
        ...(payload.error.candidates !== undefined ? { candidates: payload.error.candidates } : {}),
      }),
    );
  };

  activePort.addEventListener('message', onPortMessage);
  activePort.start();

  function sendRpc<R>(
    method: DriverRpcMethod,
    buildRequest: (id: number) => DriverRpcRequest,
    validateResult: (value: unknown) => value is R,
    callOptions?: RpcCallExecutionOptions,
  ): Promise<R> {
    if (disposed) {
      return Promise.reject(new DriverError('DRIVER_DISPOSED', 'Driver has been disposed.'));
    }

    const signal = callOptions?.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new DriverError('DRIVER_TIMEOUT', `Driver '${method}' operation aborted by signal.`, {
          cause: signal.reason,
        }),
      );
    }

    const timeoutMs = callOptions?.timeoutMs ?? defaultRpcTimeoutMs;
    const id = nextRequestId;
    nextRequestId += 1;
    const request = buildRequest(id);

    return new Promise<R>((resolve, reject) => {
      const onAbort = (): void => {
        const entry = pending.get(id);
        if (entry === undefined) {
          return;
        }
        pending.delete(id);
        entry.cleanup();
        reject(
          new DriverError('DRIVER_TIMEOUT', `Driver '${method}' operation aborted by signal.`, {
            cause: signal?.reason,
          }),
        );
      };

      const timer = setTimeout(() => {
        const entry = pending.get(id);
        if (entry === undefined) {
          return;
        }
        pending.delete(id);
        entry.cleanup();
        reject(
          new DriverError(
            'DRIVER_TIMEOUT',
            `Driver '${method}' RPC timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      pending.set(id, {
        id,
        method,
        request,
        ...(callOptions?.actMeta !== undefined ? { actMeta: callOptions.actMeta } : {}),
        cleanup,
        resolve(rawResult: unknown) {
          if (!validateResult(rawResult)) {
            reject(
              new DriverError(
                'DRIVER_PROTOCOL',
                `Invalid '${method}' RPC response payload received from frame.`,
              ),
            );
            return;
          }
          resolve(rawResult);
        },
        reject,
      });

      activePort.postMessage(request);
    });
  }

  const observeInternal = (observeOptions?: ObservationOptions): Promise<ObservationSnapshot> => {
    const params = stripObserveOptions(observeOptions);
    return sendRpc(
      'observe',
      (id) => ({
        channel: DRIVER_CHANNEL,
        kind: 'rpc_request',
        protocolVersion: PROTOCOL_VERSION,
        id,
        method: 'observe',
        ...(params !== undefined ? { params } : {}),
      }),
      isObservationSnapshot,
      observeOptions?.signal !== undefined ? { signal: observeOptions.signal } : undefined,
    ).then((snap) => {
      trackRev(snap.rev);
      return snap;
    });
  };

  const reconcilePendingAfterNavigation = (): void => {
    const entries = [...pending.values()];
    for (const entry of entries) {
      if (entry.method === 'act') {
        pending.delete(entry.id);
        const navInfo = entry.navigatingInfo;
        const fromRev = navInfo?.fromRev ?? entry.actMeta?.rev ?? highestRev;
        const totalSteps = navInfo?.totalSteps ?? entry.actMeta?.totalSteps ?? 1;
        const completedSteps = navInfo?.completedSteps ?? Math.min(1, totalSteps);
        trackRev(fromRev);

        observeInternal()
          .then((afterSnap) => {
            entry.cleanup();
            const actResult: ActResult = {
              completedSteps,
              totalSteps,
              ...(completedSteps < totalSteps ? { interruptedReason: 'navigation' } : {}),
              rev: afterSnap.rev,
              url: afterSnap.url,
              title: afterSnap.title,
              diff: {
                fromRev,
                toRev: afterSnap.rev,
                fullReset: true,
                added: [],
                removed: [],
                changed: [],
                elements: afterSnap.elements,
              },
              diagnostics: mergeDiagnostics(navInfo?.diagnostics, afterSnap.diagnostics),
            };
            entry.resolve(actResult);
          })
          .catch((err: unknown) => {
            entry.cleanup();
            entry.reject(
              err instanceof DriverError
                ? err
                : new DriverError(
                    'DRIVER_PROTOCOL',
                    err instanceof Error ? err.message : String(err),
                  ),
            );
          });
      } else if (entry.method === 'observe') {
        activePort.postMessage(entry.request);
      }
    }
  };

  const initiatePortReplacementHandshake = (
    nextPort: MessagePort,
    rebindOnlyIfUnbound: boolean,
    alreadyPostedHello = false,
  ): void => {
    if (disposed) {
      nextPort.close();
      return;
    }
    releaseCandidate();

    const listener = (event: MessageEvent<unknown>): void => {
      if (disposed || candidatePort !== nextPort) return;
      if (!isDriverHelloAck(event.data)) return;

      nextPort.removeEventListener('message', listener);
      candidatePort = null;
      candidateListener = null;

      const prevPort = activePort;
      prevPort.removeEventListener('message', onPortMessage);
      prevPort.close();

      activePort = nextPort;
      activePort.addEventListener('message', onPortMessage);
      activePort.start();
      reconcilePendingAfterNavigation();
    };

    candidatePort = nextPort;
    candidateListener = listener;
    nextPort.addEventListener('message', listener);
    nextPort.start();

    if (!alreadyPostedHello) {
      nextPort.postMessage(
        buildHelloMessage(allowEval, {
          sessionId,
          rebindOnlyIfUnbound,
          minRev: highestRev,
        }),
      );
    }
  };

  let detachIframeLoad: (() => void) | null = null;
  if (options.iframe !== undefined && options.rebindOnIframeLoad !== false) {
    const iframe = options.iframe;
    const targetOrigin = options.targetOrigin ?? '*';
    const onIframeLoad = (): void => {
      if (disposed || iframe.contentWindow === null) return;
      const channel = new MessageChannel();
      initiatePortReplacementHandshake(channel.port1, true, true);
      iframe.contentWindow.postMessage(
        buildHelloMessage(allowEval, {
          sessionId,
          rebindOnlyIfUnbound: true,
          minRev: highestRev,
        }),
        targetOrigin,
        [channel.port2],
      );
    };
    iframe.addEventListener('load', onIframeLoad);
    detachIframeLoad = (): void => {
      iframe.removeEventListener('load', onIframeLoad);
    };
  }

  const detachExternalReplacement =
    options.onPortReplacement !== undefined
      ? options.onPortReplacement((replacementPort) => {
          initiatePortReplacementHandshake(replacementPort, false, false);
        })
      : null;

  const captureContext: HostCaptureSeamContext = {
    ...(options.iframe !== undefined ? { iframe: options.iframe } : {}),
    ...(options.displayMediaProvider !== undefined
      ? { displayMediaProvider: options.displayMediaProvider }
      : {}),
    requestPreloadCapture(params: CaptureRpcParams, signal?: AbortSignal): Promise<CaptureResult> {
      return sendRpc(
        'capture',
        (id) => ({
          channel: DRIVER_CHANNEL,
          kind: 'rpc_request',
          protocolVersion: PROTOCOL_VERSION,
          id,
          method: 'capture',
          params,
        }),
        isCaptureResult,
        signal !== undefined ? { signal } : undefined,
      );
    },
  };
  const hostCapture = createHostCaptureSeam(captureContext);

  const mergedModes = new Set<CaptureBackendMode>([
    ...preloadCapabilities.captureModes,
    ...hostCapture.captureModes,
  ]);
  const capabilities: DriverCapabilities = {
    protocolVersion: PROTOCOL_VERSION,
    allowEval: preloadCapabilities.allowEval,
    captureModes: [...mergedModes],
    trustedInput: preloadCapabilities.trustedInput,
  };

  return {
    capabilities,
    observe: observeInternal,
    act(actOptions: ActOptions): Promise<ActResult> {
      trackRev(actOptions.rev);
      const params = {
        rev: actOptions.rev,
        steps: actOptions.steps,
        ...(actOptions.timeoutMs !== undefined ? { timeoutMs: actOptions.timeoutMs } : {}),
      };
      return sendRpc(
        'act',
        (id) => ({
          channel: DRIVER_CHANNEL,
          kind: 'rpc_request',
          protocolVersion: PROTOCOL_VERSION,
          id,
          method: 'act',
          params,
        }),
        isActResult,
        {
          actMeta: { rev: actOptions.rev, totalSteps: actOptions.steps.length },
          ...(actOptions.timeoutMs !== undefined
            ? { timeoutMs: Math.max(defaultRpcTimeoutMs, actOptions.timeoutMs + 2_000) }
            : {}),
          ...(actOptions.signal !== undefined ? { signal: actOptions.signal } : {}),
        },
      ).then((res) => {
        trackRev(res.rev);
        return res;
      });
    },
    async capture(captureOptions: CaptureOptions): Promise<CaptureResult> {
      if (disposed) {
        throw new DriverError('DRIVER_DISPOSED', 'Driver has been disposed.');
      }
      if (captureOptions.signal?.aborted) {
        throw new DriverError('DRIVER_TIMEOUT', "Driver 'capture' operation aborted by signal.", {
          cause: captureOptions.signal.reason,
        });
      }
      return hostCapture.capture(captureOptions);
    },
    eval(evalOptions: EvalOptions): Promise<EvalResult> {
      const params = {
        expression: evalOptions.expression,
        ...(evalOptions.timeoutMs !== undefined ? { timeoutMs: evalOptions.timeoutMs } : {}),
      };
      return sendRpc(
        'eval',
        (id) => ({
          channel: DRIVER_CHANNEL,
          kind: 'rpc_request',
          protocolVersion: PROTOCOL_VERSION,
          id,
          method: 'eval',
          params,
        }),
        isEvalResult,
        {
          ...(evalOptions.timeoutMs !== undefined
            ? { timeoutMs: Math.max(defaultRpcTimeoutMs, evalOptions.timeoutMs + 2_000) }
            : {}),
          ...(evalOptions.signal !== undefined ? { signal: evalOptions.signal } : {}),
        },
      );
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      detachIframeLoad?.();
      detachExternalReplacement?.();
      releaseCandidate();
      activePort.removeEventListener('message', onPortMessage);
      const pendingEntries = [...pending.values()];
      pending.clear();
      for (const entry of pendingEntries) {
        entry.cleanup();
        entry.reject(
          new DriverError('DRIVER_DISPOSED', 'Driver was disposed before RPC completed.'),
        );
      }
      hostCapture.dispose();
      activePort.close();
    },
  };
}

interface HandshakeAttachControls {
  readonly bindCandidatePort: (port: MessagePort) => void;
  readonly fail: (err: DriverError) => void;
}

function awaitPortHandshake(
  options: InternalConnectOptions,
  sessionId: string,
  attachTransport: (controls: HandshakeAttachControls) => () => void,
): Promise<PageDriver> {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  return new Promise<PageDriver>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(
        new DriverError('DRIVER_TIMEOUT', 'Driver handshake aborted by signal.', {
          cause: options.signal.reason,
        }),
      );
      return;
    }

    let settled = false;
    let activePort: MessagePort | null = null;
    let activeListener: ((event: MessageEvent<unknown>) => void) | null = null;
    let detachTransport = (): void => {};

    const releaseCandidatePort = (): void => {
      if (activePort !== null && activeListener !== null) {
        activePort.removeEventListener('message', activeListener);
      }
      if (activePort !== null) {
        activePort.close();
      }
      activePort = null;
      activeListener = null;
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      detachTransport();
      options.signal?.removeEventListener('abort', onAbort);
    };

    const fail = (err: DriverError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      releaseCandidatePort();
      reject(err);
    };

    const onAbort = (): void => {
      fail(
        new DriverError('DRIVER_TIMEOUT', 'Driver handshake aborted by signal.', {
          cause: options.signal?.reason,
        }),
      );
    };

    const bindCandidatePort = (candidatePort: MessagePort): void => {
      if (settled) {
        candidatePort.close();
        return;
      }
      releaseCandidatePort();

      const listener = (event: MessageEvent<unknown>): void => {
        const payload: unknown = event.data;
        if (isDriverHelloAck(payload)) {
          if (settled) return;
          settled = true;
          candidatePort.removeEventListener('message', listener);
          activePort = null;
          activeListener = null;
          cleanup();
          resolve(createPreviewPortDriver(candidatePort, payload.capabilities, options, sessionId));
          return;
        }
        if (isDriverChannelEnvelope(payload)) {
          fail(
            new DriverError(
              'DRIVER_PROTOCOL',
              'Received malformed driver handshake envelope on MessagePort.',
            ),
          );
        }
      };

      activePort = candidatePort;
      activeListener = listener;
      candidatePort.addEventListener('message', listener);
      candidatePort.start();
    };

    const timer = setTimeout(() => {
      fail(
        new DriverError(
          'DRIVER_TIMEOUT',
          `Driver handshake timed out after ${handshakeTimeoutMs}ms.`,
        ),
      );
    }, handshakeTimeoutMs);

    options.signal?.addEventListener('abort', onAbort, { once: true });
    detachTransport = attachTransport({ bindCandidatePort, fail });
  });
}

function allocateSessionId(): string {
  const id = `drv-${String(nextDriverSessionSeq)}-${Math.random().toString(36).slice(2, 10)}`;
  nextDriverSessionSeq += 1;
  return id;
}

export function connectPort(
  port: MessagePort,
  options: ConnectPortOptions = {},
): Promise<PageDriver> {
  const allowEval = options.allowEval ?? false;
  const sessionId = allocateSessionId();
  if (options.signal?.aborted) {
    port.close();
  }
  return awaitPortHandshake(options, sessionId, ({ bindCandidatePort }) => {
    bindCandidatePort(port);
    port.postMessage(buildHelloMessage(allowEval, { sessionId }));
    return () => {};
  });
}

export function connectPortStream(options: ConnectPortStreamOptions): Promise<PageDriver> {
  const allowEval = options.allowEval ?? false;
  const sessionId = allocateSessionId();
  const internalOptions: InternalConnectOptions = {
    ...options,
    rebindOnIframeLoad: options.rebindOnIframeLoad ?? false,
  };
  return awaitPortHandshake(internalOptions, sessionId, ({ bindCandidatePort }) =>
    options.subscribeCandidatePorts((port) => {
      bindCandidatePort(port);
      port.postMessage(buildHelloMessage(allowEval, { sessionId }));
    }),
  );
}

export function connectIframe(
  iframe: HTMLIFrameElement,
  options: ConnectIframeOptions = {},
): Promise<PageDriver> {
  if (iframe.contentWindow === null) {
    return Promise.reject(
      new DriverError(
        'DRIVER_PROTOCOL',
        'Target iframe has no contentWindow; attach the iframe to a document before connecting.',
      ),
    );
  }

  const allowEval = options.allowEval ?? false;
  const targetOrigin = options.targetOrigin ?? '*';
  const sessionId = allocateSessionId();

  return awaitPortHandshake(
    { ...options, iframe, targetOrigin },
    sessionId,
    ({ bindCandidatePort, fail }) => {
      const sendHandshake = (): void => {
        const contentWin = iframe.contentWindow;
        if (contentWin === null) {
          fail(new DriverError('DRIVER_PROTOCOL', 'Target iframe detached during handshake.'));
          return;
        }
        const channel = new MessageChannel();
        bindCandidatePort(channel.port1);
        contentWin.postMessage(buildHelloMessage(allowEval, { sessionId }), targetOrigin, [
          channel.port2,
        ]);
      };

      iframe.addEventListener('load', sendHandshake);
      sendHandshake();
      return () => {
        iframe.removeEventListener('load', sendHandshake);
      };
    },
  );
}
