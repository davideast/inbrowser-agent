import { EventEmitter } from 'events';
import type { BrowserRequest } from './browser-http';
import {
  formatHttpAgentName,
  formatHttpsAgentName,
  keepAgentSocketAlive,
  reuseAgentSocket,
} from './http-common';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

function concurrency(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    value === Number.POSITIVE_INFINITY ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  )
    return value;
  throw fault('EINVAL', 'HTTP request concurrency must be positive');
}

export const TLS_CONTROLS: readonly string[] = [
  'ca',
  'cert',
  'key',
  'ciphers',
  'clientCertEngine',
  'crl',
  'dhparam',
  'ecdhCurve',
  'honorCipherOrder',
  'passphrase',
  'pfx',
  'secureOptions',
  'secureProtocol',
  'servername',
  'sessionIdContext',
  'secureContext',
  'session',
  'ALPNProtocols',
  'checkServerIdentity',
  'enableTrace',
  'requestCert',
  'SNICallback',
  'minDHSize',
  'pskCallback',
  'ALPNCallback',
  'allowPartialTrustChain',
  'sigalgs',
  'privateKeyEngine',
  'privateKeyIdentifier',
  'maxVersion',
  'minVersion',
  'ticketKeys',
  'sessionTimeout',
];

export class BrowserAgent extends EventEmitter {
  readonly transport = 'browser-http';
  defaultPort = 80;
  protocol = 'http:';
  readonly options: Record<string, unknown>;
  readonly keepAlive: boolean;
  readonly keepAliveMsecs: number;
  readonly maxSockets: number;
  readonly maxFreeSockets: number;
  readonly maxTotalSockets: number;
  freeSockets: Record<string, unknown[]> = Object.create(null);
  sockets: Record<string, unknown[]> = Object.create(null);
  requests: Record<string, unknown[]> = Object.create(null);
  readonly #active = new Set<BrowserRequest>();
  readonly #queue: BrowserRequest[] = [];
  #closed = false;

  constructor(options: unknown = {}) {
    super();
    if (!record(options)) throw fault('EINVAL', 'Invalid browser HTTP agent options');
    // Node agents accept opaque caller metadata. Retain it for guest inspection;
    // only documented transport fields influence this explicit HTTP adapter.
    this.options = { ...options };
    const unsupported = [
      ...TLS_CONTROLS,
      'localAddress',
      'localPort',
      'socketPath',
      'createConnection',
      'proxy',
      'timeout',
      'socket',
      'path',
      'host',
      'hostname',
      'port',
      'protocol',
      'signal',
      'onread',
      'fd',
      'readable',
      'writable',
      'noDelay',
      'allowHalfOpen',
      'autoSelectFamily',
      'autoSelectFamilyAttemptTimeout',
      'blockList',
    ];
    for (const key of unsupported)
      if (options[key] !== undefined && options[key] !== null)
        throw fault('ENOSYS', `Browser HTTP agent control ${key} is unsupported`);
    if (options.rejectUnauthorized !== undefined && options.rejectUnauthorized !== true)
      throw fault('ENOSYS', 'Browser certificate verification cannot be disabled');
    if (options.keepAlive !== undefined && typeof options.keepAlive !== 'boolean')
      throw fault('EINVAL', 'Invalid keepAlive');
    if (options.scheduling !== undefined && options.scheduling !== 'fifo')
      throw fault('ENOSYS', 'Browser HTTP request queue supports FIFO scheduling');
    if (options.family !== undefined && options.family !== 0)
      throw fault('ENOSYS', 'Browser controls DNS address family');
    if (options.lookup !== undefined && typeof options.lookup !== 'function')
      throw fault('EINVAL', 'Invalid lookup hook');
    if (options.hints !== undefined && typeof options.hints !== 'number')
      throw fault('EINVAL', 'Invalid DNS hints');
    // This explicit mode replaces socket lookup and physical pooling hooks.
    for (const key of ['keepAliveMsecs', 'maxFreeSockets']) {
      const value = options[key];
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      )
        throw fault('EINVAL', `Invalid ${key}`);
    }
    this.keepAlive = options.keepAlive === true;
    this.keepAliveMsecs =
      typeof options.keepAliveMsecs === 'number' ? options.keepAliveMsecs : 1000;
    this.maxSockets = concurrency(options.maxSockets, Number.POSITIVE_INFINITY);
    this.maxFreeSockets = typeof options.maxFreeSockets === 'number' ? options.maxFreeSockets : 256;
    this.maxTotalSockets = concurrency(options.maxTotalSockets, Number.POSITIVE_INFINITY);
  }

  createConnection(_options?: unknown, _done?: unknown): never {
    throw fault('ENOSYS', 'Default outbound connections are not implemented');
  }

  getName(options: unknown = {}): string {
    return formatHttpAgentName(options);
  }

  keepSocketAlive(socket: unknown): boolean {
    return keepAgentSocketAlive(socket, this.keepAlive, this.keepAliveMsecs);
  }

  reuseSocket(socket: unknown, request: unknown): void {
    reuseAgentSocket(socket, request);
  }

  addRequest(request: BrowserRequest, _options: unknown) {
    if (this.#closed) throw fault('EPIPE', 'Browser HTTP agent is destroyed');
    if (this.#active.size + this.#queue.length >= resourceLimits().http.agentRequests)
      throw fault('E2BIG', 'Browser HTTP agent request limit exceeded');
    this.#queue.push(request);
    request.once('close', () => {
      this.#active.delete(request);
      const index = this.#queue.indexOf(request);
      if (index >= 0) this.#queue.splice(index, 1);
      this.#drain();
    });
    // Defer dispatch until the caller can register errors and finish the request.
    queueMicrotask(() => this.#drain());
  }

  #drain() {
    if (this.#closed) return;
    while (this.#active.size < this.maxTotalSockets) {
      const index = this.#queue.findIndex((request) => {
        if (request.destroyed) return false;
        let count = 0;
        for (const active of this.#active) if (active.origin === request.origin) count++;
        return count < this.maxSockets;
      });
      if (index < 0) return;
      const request = this.#queue.splice(index, 1)[0];
      this.#active.add(request);
      request.dispatch();
    }
  }

  destroy() {
    this.#closed = true;
    const owned = [...this.#queue, ...this.#active];
    this.#queue.length = 0;
    this.#active.clear();
    // Response end destroys the request before its asynchronous close removes
    // it from this set. Do not inject an error into that completed request.
    for (const request of owned)
      if (!request.destroyed) request.destroy(fault('ECONNRESET', 'Browser HTTP agent destroyed'));
  }
}

class Agent extends BrowserAgent {
  override defaultPort = 443;
  override protocol = 'https:';

  override getName(options: unknown = {}): string {
    return formatHttpsAgentName(options);
  }
}

export { Agent as HttpsAgent };
