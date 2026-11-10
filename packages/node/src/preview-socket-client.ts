import { Buffer } from 'buffer';
import createHash from 'sha.js';
import { PortSocket, SOCKET_LIMIT } from './port-socket';
import { VERSION } from './protocol';

// The page side of the preview WebSocket bridge. A page socket never reaches a
// service worker (design §3.5), so the bridge script replaces the WebSocket
// constructor in preview documents and sends each socket it claims to the
// page's controlling service worker over a MessagePort, as a byte stream the
// host relays into the guest's `upgrade` handler. The two entries differ only in
// which sockets they claim: src/preview-socket.ts (prefix mode) and
// src/preview-origin-socket.ts (per-origin previews).

/** Where a claimed socket goes: extra message fields and the guest path (no query). */
export interface SocketRoute {
  fields: Record<string, unknown>;
  path: string;
}

const active = new Set<PreviewWebSocket>();
class PreviewWebSocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: BinaryType = 'blob';
  readonly extensions = '';
  private state = 0;
  private selected = '';
  private input = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentSize = 0;
  private fragmentOpcode = 0;
  private closeCode = 1006;
  private closeReason = '';
  private closeReceived = false;
  private socket: PortSocket;
  // The closing handshake's deadline; armed once the server has read our close frame.
  private timer?: ReturnType<typeof setTimeout>;
  private queued = 0;
  private queuedPackets = 0;
  private sends = Promise.resolve();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  get readyState() {
    return this.state;
  }
  get protocol() {
    return this.selected;
  }
  get bufferedAmount() {
    return this.queued + this.socket.writableLength;
  }
  constructor(
    readonly url: string,
    protocols: string[],
    route: SocketRoute,
  ) {
    super();
    const channel = new MessageChannel();
    // The handshake has no deadline: as with a native server, a busy guest answers
    // when its event loop turns. The host relay reports a missing listener or the
    // guest's end, and the heartbeat reports a relay that has gone away.
    this.socket = new PortSocket(channel.port1, true);
    active.add(this);
    const parsed = new URL(url);
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
    this.socket.on('data', (bytes: Buffer) => {
      try {
        if (this.input.length + bytes.length > SOCKET_LIMIT + 16384)
          throw new Error('Socket input limit');
        this.input = Buffer.concat([this.input, bytes]);
        if (this.state === 0) {
          const end = this.input.indexOf('\r\n\r\n');
          if (end < 0) {
            if (this.input.length > 16384) throw new Error('Handshake limit');
            return;
          }
          const lines = this.input.subarray(0, end).toString().split('\r\n');
          const headers = new Map(
            lines.slice(1).map((line) => {
              const at = line.indexOf(':');
              return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
            }),
          );
          const expected = createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          const selected = headers.get('sec-websocket-protocol') ?? '';
          if (
            !/^HTTP\/1\.1 101(?: |$)/.test(lines[0]) ||
            headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
            !headers
              .get('connection')
              ?.toLowerCase()
              .split(/\s*,\s*/)
              .includes('upgrade') ||
            headers.get('sec-websocket-accept') !== expected ||
            headers.has('sec-websocket-extensions') ||
            (protocols.length ? !protocols.includes(selected) : selected !== '')
          )
            throw new Error('Invalid handshake');
          this.selected = selected;
          this.state = 1;
          this.input = this.input.subarray(end + 4);
          this.emitEvent(new Event('open'));
        }
        this.frames();
      } catch {
        this.fail();
      }
    });
    this.socket.on('error', () => this.fail());
    this.socket.on('end', () => this.socket.end());
    this.socket.on('close', () => {
      if (this.state === 3) return;
      this.state = 3;
      clearTimeout(this.timer);
      active.delete(this);
      this.emitEvent(
        new CloseEvent('close', {
          code: this.closeCode,
          reason: this.closeReason,
          wasClean: this.closeReceived,
        }),
      );
    });
    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      channel.port2.close();
      queueMicrotask(() => this.fail());
      return;
    }
    controller.postMessage(
      {
        type: 'socket',
        version: VERSION,
        ...route.fields,
        url: route.path + parsed.search,
        key,
        protocols: protocols.join(', '),
        host: parsed.host,
        origin: location.origin,
      },
      [channel.port2],
    );
  }
  private emitEvent(event: Event) {
    queueMicrotask(() => {
      this.dispatchEvent(event);
      if (event instanceof CloseEvent) this.onclose?.(event);
      else if (event instanceof MessageEvent) this.onmessage?.(event);
      else if (event.type === 'open') this.onopen?.(event);
      else if (event.type === 'error') this.onerror?.(event);
    });
  }
  private fail() {
    if (this.state === 3) return;
    if (this.state !== 2) this.emitEvent(new Event('error'));
    this.state = 2;
    this.socket.destroy();
  }
  private frame(opcode: number, payload: Uint8Array, done?: () => void) {
    const length = payload.length;
    const header = Buffer.alloc(length < 126 ? 6 : 10);
    header[0] = 128 | opcode;
    if (length < 126) header[1] = 128 | length;
    else if (length <= 65535) {
      header[1] = 128 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 128 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    const size = length < 126 ? 2 : length <= 65535 ? 4 : 10;
    const mask = crypto.getRandomValues(new Uint8Array(4));
    const frame = Buffer.alloc(size + 4 + length);
    frame.set(header.subarray(0, size));
    frame.set(mask, size);
    for (let i = 0; i < length; i++) frame[size + 4 + i] = payload[i] ^ mask[i % 4];
    this.socket.write(frame, (error) => {
      if (error) this.fail();
      else done?.();
    });
  }
  private frames() {
    while (this.input.length >= 2) {
      const first = this.input[0];
      const second = this.input[1];
      const opcode = first & 15;
      const final = (first & 128) !== 0;
      if ((first & 112) !== 0 || (second & 128) !== 0) throw new Error('Invalid server frame');
      let length = second & 127;
      let at = 2;
      if (length === 126) {
        if (this.input.length < 4) return;
        length = this.input.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (this.input.length < 10) return;
        if (this.input.readUInt32BE(2) !== 0) throw new Error('Frame limit');
        length = this.input.readUInt32BE(6);
        at = 10;
      }
      if (length > SOCKET_LIMIT || (opcode >= 8 && (!final || length > 125)))
        throw new Error('Frame limit');
      if (this.input.length < at + length) return;
      const payload = Buffer.from(this.input.subarray(at, at + length));
      this.input = this.input.subarray(at + length);
      if (opcode === 8) {
        if (length === 1) throw new Error('Invalid close');
        const code = length ? payload.readUInt16BE(0) : 1005;
        if (length && !validClose(code)) throw new Error('Invalid close code');
        this.closeCode = code;
        this.closeReason = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
        this.closeReceived = true;
        if (this.state === 1) {
          this.state = 2;
          this.frame(8, payload, () => this.socket.end());
        } else this.socket.end();
        return;
      }
      if (opcode === 9) {
        this.frame(10, payload);
        continue;
      }
      if (opcode === 10) continue;
      if (opcode !== 0 && opcode !== 1 && opcode !== 2) throw new Error('Invalid opcode');
      if (opcode === 0 ? !this.fragmentOpcode : this.fragmentOpcode !== 0)
        throw new Error('Invalid continuation');
      if (opcode !== 0) this.fragmentOpcode = opcode;
      this.fragmentSize += length;
      if (this.fragmentSize > SOCKET_LIMIT || this.fragments.length >= 1024)
        throw new Error('Message limit');
      this.fragments.push(payload);
      if (final) {
        const bytes = Buffer.concat(this.fragments);
        const type = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentSize = 0;
        this.fragmentOpcode = 0;
        const data =
          type === 1
            ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            : this.binaryType === 'arraybuffer'
              ? new Uint8Array(bytes).buffer
              : new Blob([new Uint8Array(bytes)]);
        // As in a browser WebSocket, a message received once close() has started
        // is dropped: only an open socket dispatches messages.
        if (this.state === 1)
          this.emitEvent(new MessageEvent('message', { data, origin: new URL(this.url).origin }));
      }
    }
  }
  send(value: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.state === 0) throw new DOMException('Socket is connecting', 'InvalidStateError');
    if (this.state !== 1) return;
    const data =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Blob
          ? value
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value);
    const size = data instanceof Blob ? data.size : data.byteLength;
    if (
      size + 14 > SOCKET_LIMIT ||
      this.bufferedAmount + size + 14 > SOCKET_LIMIT ||
      this.queuedPackets >= 1024
    ) {
      this.fail();
      return;
    }
    const copy = data instanceof Blob ? data : new Uint8Array(data);
    this.queued += size + 14;
    this.queuedPackets++;
    this.sends = this.sends
      .then(async () => {
        const bytes = copy instanceof Blob ? new Uint8Array(await copy.arrayBuffer()) : copy;
        this.queued -= size + 14;
        this.queuedPackets--;
        if (!this.socket.destroyed && !this.closeReceived)
          this.frame(typeof value === 'string' ? 1 : 2, bytes);
      })
      .catch(() => this.fail());
  }
  close(code?: number, reason = '') {
    if (
      code !== undefined &&
      code !== 1000 &&
      !(code >= 3000 && code <= 4999 && Number.isInteger(code))
    )
      throw new DOMException('Invalid close code', 'InvalidAccessError');
    const bytes = new TextEncoder().encode(reason);
    if (bytes.length > 123) throw new DOMException('Close reason too long', 'SyntaxError');
    if (this.state >= 2) return;
    if (this.state === 0) {
      this.fail();
      return;
    }
    this.state = 2;
    const payload =
      code === undefined
        ? Buffer.alloc(0)
        : Buffer.concat([Buffer.from([code >> 8, code & 255]), Buffer.from(bytes)]);
    // A busy server reads the close frame when its event loop turns, so the wait for
    // its answer starts only then; the deadline bounds a server that has read the
    // close frame and never answers, not one that is busy.
    this.sends = this.sends.then(() => {
      if (!this.socket.destroyed)
        this.frame(8, payload, () => {
          if (!this.socket.destroyed) this.timer = setTimeout(() => this.socket.destroy(), 5000);
        });
    });
  }
  dispose() {
    this.socket.destroy();
  }
}
function validClose(code: number) {
  return (
    (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999)
  );
}
/**
 * Replaces `WebSocket` so sockets that `route` claims go to the page's service
 * worker as `socket` messages; every other socket stays native.
 */
export function installPreviewWebSocket(route: (url: URL) => SocketRoute | undefined): void {
  const native = globalThis.WebSocket;
  globalThis.WebSocket = new Proxy(native, {
    construct(target, args) {
      const url = new URL(String(args[0]), location.href);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      const routed =
        url.host === location.host && ['ws:', 'wss:'].includes(url.protocol)
          ? route(url)
          : undefined;
      if (!routed) return Reflect.construct(target, args);
      if (url.hash) throw new DOMException('WebSocket URL has a fragment', 'SyntaxError');
      const requested =
        args[1] === undefined ? [] : typeof args[1] === 'string' ? [args[1]] : args[1];
      if (
        !Array.isArray(requested) ||
        requested.some(
          (p: unknown) => typeof p !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p),
        ) ||
        new Set(requested).size !== requested.length
      )
        throw new DOMException('Invalid subprotocol', 'SyntaxError');
      return new PreviewWebSocket(url.href, requested, routed);
    },
  });
  addEventListener('pagehide', () => {
    for (const socket of active) socket.dispose();
  });
}
