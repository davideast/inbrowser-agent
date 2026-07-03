import type {
  BridgeConnection,
  BridgeEnvelope,
  BridgePeerRole,
  BridgeRequestOptions,
} from './types.js';

export interface EnvelopeTransport {
  send(envelope: BridgeEnvelope): Promise<void>;
  subscribe(callback: (envelope: BridgeEnvelope) => void): () => void;
  close(reason?: string): Promise<void>;
}

export interface CreateBridgeConnectionOptions {
  sessionId: string;
  role: BridgePeerRole;
  transport: EnvelopeTransport;
  now?: () => number;
}

export function createBridgeConnection(options: CreateBridgeConnectionOptions): BridgeConnection {
  const listeners = new Set<(envelope: BridgeEnvelope) => void>();
  const pending = new Map<
    string,
    {
      resolve(envelope: BridgeEnvelope): void;
      reject(err: Error): void;
      cleanup(): void;
    }
  >();

  const unsubscribe = options.transport.subscribe((envelope) => {
    if (envelope.kind === 'response' || envelope.kind === 'error') {
      const pendingRequest = envelope.replyTo ? pending.get(envelope.replyTo) : undefined;
      if (pendingRequest) {
        pending.delete(envelope.replyTo as string);
        pendingRequest.cleanup();
        if (envelope.kind === 'error') {
          pendingRequest.reject(bridgeError(envelope));
        } else {
          pendingRequest.resolve(envelope);
        }
      }
    }
    for (const listener of Array.from(listeners)) listener(envelope);
  });

  return {
    sessionId: options.sessionId,
    role: options.role,
    async send(envelope) {
      await options.transport.send(normalizeEnvelope(envelope, options));
    },
    async request(envelope, requestOptions) {
      const requestEnvelope = normalizeEnvelope(
        { ...envelope, kind: 'request' },
        options,
      ) as BridgeEnvelope;
      if (pending.has(requestEnvelope.id)) {
        throw new Error(`Bridge request already pending: ${requestEnvelope.id}`);
      }
      const response = await waitForResponse(
        requestEnvelope,
        options.transport,
        pending,
        requestOptions,
      );
      return response as never;
    },
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    async close(reason) {
      unsubscribe();
      for (const [id, pendingRequest] of Array.from(pending)) {
        pending.delete(id);
        pendingRequest.cleanup();
        pendingRequest.reject(new Error(reason ? `Bridge closed: ${reason}` : 'Bridge closed'));
      }
      listeners.clear();
      await options.transport.close(reason);
    },
  };
}

function normalizeEnvelope(
  envelope: Omit<BridgeEnvelope, 'sentAt'> & { sentAt?: number },
  options: Pick<CreateBridgeConnectionOptions, 'sessionId' | 'role' | 'now'>,
): BridgeEnvelope {
  return {
    ...envelope,
    sessionId: envelope.sessionId || options.sessionId,
    sentAt: envelope.sentAt ?? options.now?.() ?? Date.now(),
    peer: envelope.peer ?? options.role,
  };
}

async function waitForResponse(
  envelope: BridgeEnvelope,
  transport: EnvelopeTransport,
  pending: Map<
    string,
    {
      resolve(envelope: BridgeEnvelope): void;
      reject(err: Error): void;
      cleanup(): void;
    }
  >,
  options: BridgeRequestOptions = {},
): Promise<BridgeEnvelope> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      cleanup();
      pending.delete(envelope.id);
      reject(new Error(`Bridge request aborted: ${envelope.type}`));
    };
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        cleanup();
        pending.delete(envelope.id);
        reject(new Error(`Bridge request timed out: ${envelope.type}`));
      }, options.timeoutMs);
    }
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(envelope.id, { resolve, reject, cleanup });
    transport.send(envelope).catch((err) => {
      cleanup();
      pending.delete(envelope.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function bridgeError(envelope: BridgeEnvelope): Error {
  const payload = envelope.payload as { message?: string } | undefined;
  return new Error(payload?.message ?? `Bridge request failed: ${envelope.type}`);
}

let idCounter = 0;

export function createBridgeEnvelopeId(prefix = 'bridge'): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
