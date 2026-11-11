import { Buffer } from 'buffer';
import { invalidArgType, invalidArgValue, nodeError, validateObject } from '../node-errors';
import {
  CLIENT_RENEG_LIMIT,
  CLIENT_RENEG_WINDOW,
  DEFAULT_CIPHERS,
  DEFAULT_ECDH_CURVE,
  DEFAULT_MAX_VERSION,
  DEFAULT_MIN_VERSION,
  EMPTY_ROOT_CERTIFICATES,
  checkServerIdentity,
  convertALPNProtocols,
  getCACertificates,
  getCiphers,
} from '../tls-identity';
import { fault, record } from '../value-guards';
import type { createNetBuiltin } from './net';

export interface TlsBuiltinDeps {
  net: ReturnType<typeof createNetBuiltin>;
}

const VALID_TLS_VERSIONS = new Set(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);

function validateTlsVersion(version: unknown, kind: 'minimum' | 'maximum', prop: string): void {
  if (version === undefined) return;
  if (typeof version !== 'string') {
    throw invalidArgType(`options.${prop}`, 'string', version);
  }
  if (!VALID_TLS_VERSIONS.has(version)) {
    throw nodeError(
      TypeError,
      'ERR_TLS_INVALID_PROTOCOL_VERSION',
      `${JSON.stringify(version)} is not a valid ${kind} TLS protocol version`,
    );
  }
}

export class SecureContext {
  context: Record<string, unknown>;

  constructor(context?: unknown) {
    this.context = record(context) ? context : {};
  }
}

export function createSecureContext(options?: unknown): SecureContext {
  if (options !== undefined) {
    validateObject(options, 'options');
    validateTlsVersion(options.minVersion, 'minimum', 'minVersion');
    validateTlsVersion(options.maxVersion, 'maximum', 'maxVersion');
  }
  return new SecureContext();
}

function unsupportedTlsSocket(): never {
  throw fault('ENOSYS', 'TLS sockets are not implemented');
}

export function createTlsBuiltin(deps: TlsBuiltinDeps) {
  const NetSocket = deps.net.Socket;
  const NetServer = deps.net.Server;

  class TLSSocket extends NetSocket {
    constructor(..._args: unknown[]) {
      super();
      unsupportedTlsSocket();
    }

    disableRenegotiation(): void {}
    enableTrace(): void {}
    exportKeyingMaterial(): Buffer {
      return unsupportedTlsSocket();
    }
    getCertificate(): Record<string, unknown> {
      return {};
    }
    getCipher(): { name: string; standardName: string; version: string } | undefined {
      return undefined;
    }
    getEphemeralKeyInfo(): Record<string, unknown> | null {
      return null;
    }
    getFinished(): Buffer | undefined {
      return undefined;
    }
    getPeerCertificate(_detailed?: boolean): Record<string, unknown> {
      return {};
    }
    getPeerFinished(): Buffer | undefined {
      return undefined;
    }
    getPeerX509Certificate(): undefined {
      return undefined;
    }
    getProtocol(): string | null {
      return null;
    }
    getSession(): Buffer | undefined {
      return undefined;
    }
    getSharedSigalgs(): string[] {
      return [];
    }
    getTLSTicket(): Buffer | undefined {
      return undefined;
    }
    getX509Certificate(): undefined {
      return undefined;
    }
    isSessionReused(): boolean {
      return false;
    }
    renegotiate(_options: unknown, _callback: unknown): boolean {
      return unsupportedTlsSocket();
    }
    setKeyCert(_context: unknown): void {}
    setMaxSendFragment(_size: number): boolean {
      return false;
    }
    setServername(_name: string): void {}
    setSession(_session: unknown): void {}
  }

  class Server extends NetServer {
    private _ticketKeys: Buffer;

    constructor(options?: unknown, secureConnectionListener?: unknown) {
      super();
      this._ticketKeys = Buffer.alloc(48);
      if (typeof options === 'function') {
        this.on('secureConnection', (...args: unknown[]) => {
          Reflect.apply(options, this, args);
        });
      } else {
        if (options !== undefined) {
          createSecureContext(options);
        }
        if (typeof secureConnectionListener === 'function') {
          this.on('secureConnection', (...args: unknown[]) => {
            Reflect.apply(secureConnectionListener, this, args);
          });
        }
      }
    }

    addContext(_hostname: string, _context: unknown): void {}

    getTicketKeys(): Buffer {
      return Buffer.from(this._ticketKeys);
    }

    setOptions(options: unknown): void {
      if (options !== undefined) {
        createSecureContext(options);
      }
    }

    setSecureContext(options: unknown): void {
      createSecureContext(options);
    }

    setTicketKeys(keys: unknown): void {
      if (!ArrayBuffer.isView(keys)) {
        throw invalidArgType('keys', ['Buffer', 'TypedArray', 'DataView'], keys);
      }
      if (keys.byteLength !== 48) {
        throw invalidArgValue('keys.byteLength', keys.byteLength, 'must be exactly 48 bytes');
      }
      this._ticketKeys = Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength);
    }
  }
  Object.defineProperty(Server, 'name', { configurable: true, value: 'Server' });

  function createServer(options?: unknown, secureConnectionListener?: unknown): Server {
    return new Server(options, secureConnectionListener);
  }

  function connect(..._args: unknown[]): never {
    throw fault('ENOSYS', 'TLS connections are not implemented');
  }

  function createSecurePair(..._args: unknown[]): never {
    throw fault('ENOSYS', 'TLS secure pairs are not implemented');
  }

  const tlsModule: {
    CLIENT_RENEG_LIMIT: number;
    CLIENT_RENEG_WINDOW: number;
    DEFAULT_CIPHERS: string;
    DEFAULT_ECDH_CURVE: string;
    DEFAULT_MIN_VERSION: string;
    DEFAULT_MAX_VERSION: string;
    readonly rootCertificates: readonly string[];
    getCiphers: typeof getCiphers;
    getCACertificates: typeof getCACertificates;
    convertALPNProtocols: typeof convertALPNProtocols;
    checkServerIdentity: typeof checkServerIdentity;
    createSecureContext: typeof createSecureContext;
    SecureContext: typeof SecureContext;
    TLSSocket: typeof TLSSocket;
    Server: typeof Server;
    createServer: typeof createServer;
    connect: typeof connect;
    createSecurePair: typeof createSecurePair;
  } = {
    CLIENT_RENEG_LIMIT,
    CLIENT_RENEG_WINDOW,
    DEFAULT_CIPHERS,
    DEFAULT_ECDH_CURVE,
    DEFAULT_MIN_VERSION,
    DEFAULT_MAX_VERSION,
    rootCertificates: EMPTY_ROOT_CERTIFICATES,
    getCiphers,
    getCACertificates,
    convertALPNProtocols,
    checkServerIdentity,
    createSecureContext,
    SecureContext,
    TLSSocket,
    Server,
    createServer,
    connect,
    createSecurePair,
  };

  // Delete data property first so defineProperty installs a non-configurable accessor
  // matching Node v22.18.0's Object.getOwnPropertyDescriptor(tls, 'rootCertificates').
  Reflect.deleteProperty(tlsModule, 'rootCertificates');
  Object.defineProperty(tlsModule, 'rootCertificates', {
    get: () => EMPTY_ROOT_CERTIFICATES,
    enumerable: true,
    configurable: false,
  });

  return tlsModule;
}
