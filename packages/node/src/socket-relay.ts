import { SOCKET_LIMIT, VERSION, record } from './protocol';
import { resourceLimits } from './resource-policy';

// Host-owned relays remain reachable when a guest Worker is forcibly terminated.
export class SocketRelay {
  private closed = false;
  private lastSeen = Date.now();
  private waiting = [false, false];
  private timer: ReturnType<typeof setInterval>;
  constructor(
    readonly pid: number,
    private client: MessagePort,
    private guest: MessagePort,
    private removed: () => void,
  ) {
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSeen > resourceLimits().timers.previewSocketIdleMs) this.close();
      // The 5 s poll interval is a fixed sampling rate, not a resource bound.
    }, 5000);
    const ports = [client, guest];
    ports.forEach((port, index) => {
      port.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (!record(message) || message.version !== VERSION) return this.close();
        if (index === 0 && message.type === 'ping') {
          this.lastSeen = Date.now();
          client.postMessage({ version: VERSION, type: 'pong' });
          return;
        }
        if (message.type === 'bytes') {
          if (
            this.waiting[index] ||
            !(message.bytes instanceof Uint8Array) ||
            message.bytes.length > SOCKET_LIMIT ||
            !Number.isSafeInteger(message.id)
          )
            return this.close();
          this.waiting[index] = true;
        } else if (message.type === 'ack') {
          if (!this.waiting[1 - index]) return this.close();
          this.waiting[1 - index] = false;
        } else if (!['end', 'close', 'error'].includes(String(message.type))) return this.close();
        ports[1 - index].postMessage(message);
        if (message.type === 'close' || message.type === 'error') this.close(false);
      };
      port.onmessageerror = () => this.close();
    });
  }
  close(notify = true) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const port of [this.client, this.guest]) {
      if (notify) port.postMessage({ version: VERSION, type: 'error' });
      port.close();
    }
    this.removed();
  }
}
