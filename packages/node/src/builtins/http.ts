import type { EventEmitter } from 'events';
import { createBrowserHttpClient } from '../browser-http';
import { createHttp } from '../http';
import { validateHttpHeaderPolicy } from '../http-header-policy';
import { validateObject } from '../node-errors';
import type { Syscalls } from '../protocol';
import { fault } from '../value-guards';
import { Server as NetServer, type createNetBuiltin } from './net';
import type { createTlsBuiltin } from './tls';

export interface HttpBuiltinsDeps {
  sys: Syscalls;
  retain: () => void;
  release: () => void;
  httpAgentMode: 'socket' | 'fetch';
  httpOmitHeaders: unknown;
  responseBytes: number;
  process?: EventEmitter;
  events?: unknown;
  stream?: unknown;
  net?: ReturnType<typeof createNetBuiltin>;
  tls?: ReturnType<typeof createTlsBuiltin>;
  setTimeout?: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => unknown;
  clearTimeout?: (timer: unknown) => void;
  setImmediate?: (fn: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
  clearImmediate?: (timer: unknown) => void;
  setInterval?: (fn: (...args: unknown[]) => void, delay?: unknown, ...args: unknown[]) => unknown;
  clearInterval?: (timer: unknown) => void;
}

export function createHttpBuiltins({
  sys,
  retain,
  release,
  httpAgentMode,
  httpOmitHeaders,
  responseBytes,
  net,
  tls,
}: HttpBuiltinsDeps) {
  const fetchMode = httpAgentMode === 'fetch';
  const omitHeaders = validateHttpHeaderPolicy(httpOmitHeaders);
  const http = createHttp(
    sys,
    retain,
    release,
    fetchMode,
    omitHeaders,
    responseBytes,
    net?.Server ?? NetServer,
  );
  const httpsClient = createBrowserHttpClient(
    'https:',
    retain,
    release,
    fetchMode,
    omitHeaders,
    responseBytes,
  );

  const BaseTlsServer = tls ? tls.Server : (net?.Server ?? NetServer);
  class Server extends BaseTlsServer {
    timeout = 0;
    headersTimeout = 60000;
    keepAliveTimeout = 5000;
    requestTimeout = 300000;
    maxHeadersCount: number | null = null;
    maxRequestsPerSocket = 0;

    constructor(optionsOrListener?: unknown, maybeListener?: unknown) {
      if (typeof optionsOrListener === 'function') {
        super();
        this.on('request', (...args: unknown[]) => {
          Reflect.apply(optionsOrListener, this, args);
        });
      } else {
        if (optionsOrListener !== undefined) {
          validateObject(optionsOrListener, 'options');
        }
        super(optionsOrListener);
        if (typeof maybeListener === 'function') {
          this.on('request', (...args: unknown[]) => {
            Reflect.apply(maybeListener, this, args);
          });
        }
      }
    }

    override close(callback?: (err?: Error) => void): this {
      return super.close(callback);
    }

    closeAllConnections(): void {}

    closeIdleConnections(): void {}

    setTimeout(msecs = 0, callback?: () => void): this {
      this.timeout = msecs;
      if (typeof callback === 'function') {
        this.on('timeout', callback);
      }
      return this;
    }

    override async [Symbol.asyncDispose](): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        this.close((err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
  Object.defineProperty(Server, 'name', { configurable: true, value: 'Server' });

  const https = {
    Agent: httpsClient.Agent,
    Server,
    globalAgent: new httpsClient.Agent(),
    request: httpsClient.request,
    get: httpsClient.get,
    createServer: () => {
      throw fault('ENOSYS', 'https.createServer is not implemented');
    },
  };
  return { http, https };
}
