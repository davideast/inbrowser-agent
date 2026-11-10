import { Buffer } from 'buffer';
import { Duplex } from 'readable-stream/lib/stream.js';
import { SOCKET_LIMIT, VERSION, fault, record } from './protocol';

export { SOCKET_LIMIT };

// Socket heartbeats belong to the transport, including when this module runs in
// a process Worker whose loader later installs unsupported guest interval APIs.
const hostSetInterval = globalThis.setInterval.bind(globalThis);
const hostClearInterval = globalThis.clearInterval.bind(globalThis);
// Node's socket idle timer is unreferenced: it never keeps the process alive, so
// it uses the transport's timers, not the guest's referenced ones.
const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
// Node's TIMEOUT_MAX. Node truncates a longer duration with a warning; this
// socket rejects it explicitly instead of emitting a warning it cannot route.
const TIMEOUT_MAX = 2 ** 31 - 1;
/**
 * One acknowledged packet per direction bounds the MessagePort delivery queue.
 *
 * As with a native TCP socket, a busy peer never ends the socket: the next
 * packet waits, without a deadline, until the peer reads the last one, and
 * later writes wait in the stream's buffer, which `write` bounds at 1 MiB. The
 * socket ends on the peer's end, close or error packet, or its own destroy. The
 * host relay sends `error` when the guest process ends or the page stops
 * sending heartbeats, and a page socket's heartbeat (`heartbeat = true`), which
 * the host relay answers, not the guest, detects a relay that has gone away.
 */
export class PortSocket extends Duplex {
  readonly remoteAddress = '127.0.0.1';
  /** The last value passed to setTimeout, as Node records it before validating. */
  timeout: unknown = undefined;
  private idleMs = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private received = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastPong = Date.now();
  private pending?: {
    id: number;
    done: (error?: Error | null) => void;
  };
  constructor(
    private readonly port: MessagePort,
    heartbeat = false,
  ) {
    super({ allowHalfOpen: false, autoDestroy: true, highWaterMark: 64 * 1024 });
    if (heartbeat)
      this.heartbeat = hostSetInterval(() => {
        if (Date.now() - this.lastPong > 15000)
          this.destroy(fault('ETIMEDOUT', 'Socket host unavailable'));
        else port.postMessage({ version: VERSION, type: 'ping' });
      }, 5000);
    port.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!record(message) || message.version !== VERSION)
        return this.destroy(fault('EPROTO', 'Invalid socket packet'));
      if (message.type === 'pong' && heartbeat) {
        this.lastPong = Date.now();
        return;
      }
      if (message.type === 'bytes') {
        if (
          !(message.bytes instanceof Uint8Array) ||
          message.bytes.length > SOCKET_LIMIT ||
          message.id !== this.received + 1 ||
          this.readableLength + message.bytes.length > SOCKET_LIMIT
        )
          return this.destroy(fault('E2BIG', 'Invalid or oversized socket input'));
        this.received++;
        this.touch();
        this.push(Buffer.from(message.bytes));
        port.postMessage({ version: VERSION, type: 'ack', id: message.id });
      } else if (message.type === 'ack') {
        const pending = this.pending;
        if (!pending || message.id !== pending.id)
          return this.destroy(fault('EPROTO', 'Invalid socket acknowledgement'));
        this.pending = undefined;
        pending.done();
      } else if (message.type === 'end') this.push(null);
      else if (message.type === 'close') this.destroy();
      else if (message.type === 'error') this.destroy(fault('EPIPE', 'Socket peer unavailable'));
      else this.destroy(fault('EPROTO', 'Unknown socket packet'));
    };
    port.onmessageerror = () =>
      this.destroy(fault('EPROTO', 'Socket message could not be decoded'));
  }
  _read() {}
  write(
    chunk: unknown,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const done = typeof encoding === 'function' ? encoding : callback;
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined)
        : chunk;
    if (!(bytes instanceof Uint8Array) || this.writableLength + bytes.length > SOCKET_LIMIT) {
      const error = fault('E2BIG', 'Socket output exceeds 1 MiB');
      queueMicrotask(() => done?.(error));
      this.destroy(error);
      return false;
    }
    return super.write(bytes, done);
  }
  _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.touch();
    const id = ++this.sequence;
    this.pending = { id, done };
    this.port.postMessage({ version: VERSION, type: 'bytes', id, bytes: new Uint8Array(bytes) });
  }
  _final(done: (error?: Error | null) => void) {
    this.port.postMessage({ version: VERSION, type: 'end' });
    done();
  }
  _destroy(error: Error | null, done: (error?: Error | null) => void) {
    hostClearInterval(this.heartbeat);
    hostClearTimeout(this.idleTimer);
    this.idleMs = 0;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) pending.done(error ?? fault('EPIPE', 'Socket closed'));
    this.port.postMessage({ version: VERSION, type: 'close' });
    this.port.close();
    done(error);
  }
  setNoDelay() {
    return this;
  }
  /**
   * net.Socket#setTimeout: emit 'timeout' (without closing) after `msecs` with no
   * bytes read or written; 0 disables it. Validation and listener handling follow
   * Node's setStreamTimeout, including recording `timeout` before validating.
   */
  setTimeout(msecs: unknown, callback?: unknown): this {
    if (this.destroyed) return this;
    this.timeout = msecs;
    if (typeof msecs !== 'number')
      throw Object.assign(new TypeError('The "msecs" argument must be of type number'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    if (msecs < 0 || !Number.isFinite(msecs) || msecs > TIMEOUT_MAX)
      throw Object.assign(
        new RangeError(
          `The value of "msecs" is out of range. It must be a non-negative finite number not above ${TIMEOUT_MAX}`,
        ),
        { code: 'ERR_OUT_OF_RANGE' },
      );
    hostClearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.idleMs = msecs;
    if (msecs > 0) this.touch();
    if (callback === undefined) return this;
    if (typeof callback !== 'function')
      throw Object.assign(new TypeError('The "callback" argument must be of type function'), {
        code: 'ERR_INVALID_ARG_TYPE',
      });
    // Safe: typeof callback is 'function' (checked above); listeners receive no arguments.
    const listener = callback as (...args: unknown[]) => void;
    if (msecs === 0) this.removeListener('timeout', listener);
    else this.once('timeout', listener);
    return this;
  }
  /** Restarts the idle countdown after activity, as Node refreshes its timer. */
  private touch() {
    if (this.idleMs === 0 || this.destroyed) return;
    hostClearTimeout(this.idleTimer);
    this.idleTimer = hostSetTimeout(() => this.emit('timeout'), this.idleMs);
  }
}
