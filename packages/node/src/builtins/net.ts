import { EventEmitter } from 'events';
import { Duplex } from 'readable-stream/lib/stream.js';
import { BlockList, SocketAddress, isIP, isIPv4, isIPv6 } from '../net-address';
import { invalidArgType, validateInteger } from '../node-errors';
import type { Syscalls } from '../protocol';
import { fault, record } from '../value-guards';

export interface NetBuiltinDeps {
  sys: Syscalls;
  process: EventEmitter;
  retain: () => void;
  release: () => void;
  events: unknown;
  stream: unknown;
  setTimeout: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => unknown;
  clearTimeout: (timer: unknown) => void;
  setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
}

export class Socket extends Duplex {
  connecting = false;
  timeout: number | undefined = undefined;

  constructor(options?: unknown) {
    if (options !== undefined && options !== null && typeof options !== 'object') {
      throw invalidArgType('options', 'Object', options);
    }
    const opts = record(options) ? options : {};
    if (opts.fd !== undefined) {
      throw fault('ENOSYS', 'Raw socket file descriptors are outside this POC');
    }
    if (opts.blockList !== undefined && !BlockList.isBlockList(opts.blockList)) {
      throw invalidArgType('options.blockList', 'net.BlockList', opts.blockList);
    }
    super({
      allowHalfOpen: Boolean(opts.allowHalfOpen),
    });
    if (opts.readable === false) Reflect.set(this, 'readable', false);
    if (opts.writable === false) Reflect.set(this, 'writable', false);
  }

  override _read(_size?: number): void {}

  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(fault('ENOTCONN', 'Socket is not connected'));
  }

  get bufferSize(): number | undefined {
    return undefined;
  }

  get bytesRead(): number {
    return 0;
  }

  get bytesWritten(): number {
    return 0;
  }

  get localAddress(): string | undefined {
    return undefined;
  }

  get localFamily(): string | undefined {
    return undefined;
  }

  get localPort(): number | undefined {
    return undefined;
  }

  get pending(): boolean {
    return true;
  }

  get readyState(): string {
    if (this.connecting) return 'opening';
    if (this.readable && this.writable) return 'open';
    if (this.readable && !this.writable) return 'readOnly';
    if (!this.readable && this.writable) return 'writeOnly';
    return 'closed';
  }

  get remoteAddress(): string | undefined {
    return undefined;
  }

  get remoteFamily(): string | undefined {
    return undefined;
  }

  get remotePort(): number | undefined {
    return undefined;
  }

  address(): Record<string, never> {
    return {};
  }

  connect(..._args: unknown[]): this {
    throw fault('ENOSYS', 'Raw sockets are outside this POC');
  }

  destroySoon(): void {
    if (this.writable) this.end();
    if (this.writableFinished) this.destroy();
  }

  resetAndDestroy(): this {
    this.destroy();
    return this;
  }

  setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this;
  }

  setNoDelay(_noDelay?: boolean): this {
    return this;
  }

  setTimeout(msecs: number, callback?: () => void): this {
    this.timeout = msecs;
    if (typeof callback === 'function') {
      this.once('timeout', callback);
    }
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export class Server extends EventEmitter {
  constructor(options?: unknown, connectionListener?: unknown) {
    super();
    if (typeof options === 'function') {
      this.on('connection', (...args: unknown[]) => {
        Reflect.apply(options, this, args);
      });
    } else {
      if (
        options !== undefined &&
        (options === null || typeof options !== 'object' || Array.isArray(options))
      ) {
        throw invalidArgType('options', 'Object', options);
      }
      if (typeof connectionListener === 'function') {
        this.on('connection', (...args: unknown[]) => {
          Reflect.apply(connectionListener, this, args);
        });
      }
    }
  }

  get listening(): boolean {
    return false;
  }

  address(): null {
    return null;
  }

  close(callback?: (err?: Error) => void): this {
    const err = Object.assign(new Error('Server is not running.'), {
      code: 'ERR_SERVER_NOT_RUNNING',
    });
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(err));
    }
    this.emit('close');
    return this;
  }

  getConnections(callback?: (err: Error | null, count: number) => void): this {
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, 0));
    }
    return this;
  }

  listen(..._args: unknown[]): this {
    throw fault('ENOSYS', 'Raw sockets are outside this POC');
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await new Promise<void>((resolve) => {
      this.close(() => resolve());
    });
  }
}

export function createNetBuiltin(_deps: NetBuiltinDeps) {
  let autoSelectFamilyDefault = true;
  let autoSelectFamilyAttemptTimeoutDefault = 250;

  const createConnection = (..._args: unknown[]): never => {
    throw fault('ENOSYS', 'Raw sockets are outside this POC');
  };

  const createServer = (options?: unknown, connectionListener?: unknown): Server =>
    new Server(options, connectionListener);

  return {
    _setSimultaneousAccepts: () => {},
    get BlockList() {
      return BlockList;
    },
    get SocketAddress() {
      return SocketAddress;
    },
    connect: createConnection,
    createConnection,
    createServer,
    getDefaultAutoSelectFamily: (): boolean => autoSelectFamilyDefault,
    setDefaultAutoSelectFamily: (value: unknown): void => {
      if (typeof value !== 'boolean') {
        throw invalidArgType('value', 'boolean', value);
      }
      autoSelectFamilyDefault = value;
    },
    getDefaultAutoSelectFamilyAttemptTimeout: (): number => autoSelectFamilyAttemptTimeoutDefault,
    setDefaultAutoSelectFamilyAttemptTimeout: (value: unknown): void => {
      validateInteger(value, 'value', 1, 2147483647);
      const numeric = Number(value);
      autoSelectFamilyAttemptTimeoutDefault = numeric < 10 ? 10 : numeric;
    },
    isIP,
    isIPv4,
    isIPv6,
    Server,
    Socket,
    Stream: Socket,
  };
}
