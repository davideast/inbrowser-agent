import type { CookieMirrorOp } from './preview-cookies';
import { type PreviewFrame, type PreviewHeaders, WindowMeter, readFrame } from './preview-stream';
import { VERSION, errorRecord, fault, reviveError } from './protocol';

/**
 * Origin mode: rewrites a guest response head before it reaches the preview
 * worker. The bridge uses it to move Set-Cookie into its cookie jar.
 */
export type PreviewHeadHook = (headers: PreviewHeaders) => {
  headers: PreviewHeaders;
  cookies?: CookieMirrorOp[];
};
import type { ResourcePolicy } from './resource-policy';

/** What `BrowserContainer.previewStreams()` reports. */
export interface PreviewStreams {
  /** Preview exchanges the host is currently relaying. */
  open: number;
  /** Most response body bytes any exchange had posted by the guest and not yet read by the browser. */
  peakResponseInFlightBytes: number;
  /** Most request body bytes any exchange had posted by the service worker and not yet read by the guest. */
  peakRequestInFlightBytes: number;
  /** The most recent transport failure: a budget overflow, a protocol violation or a lost peer. */
  lastFailure?: Error;
}

/**
 * Host-owned relay for one streamed preview exchange. It forwards frames
 * between the service worker and the guest without buffering any, and it stays
 * reachable when either end disappears: a terminated guest Worker or a stopped
 * service worker would otherwise leave the other side waiting forever.
 *
 * The relay does not trust either peer. It meters both directions against the
 * container's windows and total budgets and ends the exchange on the first
 * frame that exceeds one.
 */
class PreviewRelay {
  private closed = false;
  private headSeen = false;
  private requestEnded: boolean;
  private requestBytes = 0;
  private responseBytes = 0;
  private readonly request: WindowMeter;
  private readonly response: WindowMeter;
  private headTimer?: ReturnType<typeof setTimeout>;
  lastSeen = Date.now();
  constructor(
    readonly pid: number,
    private readonly client: MessagePort,
    private readonly guest: MessagePort,
    private readonly policy: ResourcePolicy,
    private readonly previewSocket: boolean,
    bodyLength: number | null,
    private readonly owner: {
      failed(error: Error): void;
      removed(relay: PreviewRelay): void;
    },
    private readonly onHead?: PreviewHeadHook,
    private readonly previewClient = false,
  ) {
    this.requestEnded = bodyLength === 0;
    this.request = new WindowMeter(policy.preview.requestWindowBytes);
    this.response = new WindowMeter(policy.preview.responseWindowBytes);
    client.onmessage = (event: MessageEvent<unknown>) => this.fromClient(readFrame(event.data));
    guest.onmessage = (event: MessageEvent<unknown>) => this.fromGuest(readFrame(event.data));
    client.onmessageerror = () => this.fromClient(undefined);
    guest.onmessageerror = () => this.fromGuest(undefined);
    this.awaitHead();
  }
  get peaks(): [request: number, response: number] {
    return [this.request.peak, this.response.peak];
  }
  /** Restarts the wait for a response head; request progress counts as guest activity. */
  private awaitHead() {
    clearTimeout(this.headTimer);
    if (this.headSeen || this.closed) return;
    this.headTimer = setTimeout(
      () => this.fail(503, 'Guest unavailable'),
      this.policy.timers.previewHostRequestMs,
    );
  }
  private forward(port: MessagePort, frame: PreviewFrame) {
    port.postMessage(
      { version: VERSION, ...frame },
      frame.type === 'data' ? [frame.bytes.buffer] : [],
    );
  }
  private fromClient(frame: PreviewFrame | undefined) {
    if (this.closed) return;
    this.lastSeen = Date.now();
    if (frame?.type === 'ping') return;
    if (frame?.type === 'data' && !this.requestEnded && this.request.add(frame.bytes.length)) {
      const limit = this.policy.preview.requestBodyBytes;
      this.requestBytes += frame.bytes.length;
      if (this.requestBytes > limit) {
        this.fail(
          413,
          'Request exceeds 1 MiB',
          fault('E2BIG', 'Preview request body exceeds its budget', {
            limit,
            actual: this.requestBytes,
          }),
        );
        return;
      }
      this.forward(this.guest, frame);
      this.awaitHead();
      return;
    }
    if (frame?.type === 'end' && !this.requestEnded) {
      this.requestEnded = true;
      this.forward(this.guest, frame);
      this.awaitHead();
      return;
    }
    if (frame?.type === 'credit' && this.response.remove(frame.bytes)) {
      this.forward(this.guest, frame);
      return;
    }
    // The browser went away, or the service worker reported its own failure
    // (an overflowing request, a timed-out head, an unusable reply).
    if (frame?.type === 'abort') {
      if (frame.error) this.owner.failed(reviveError({ ...frame.error }));
      this.forward(this.guest, { type: 'abort' });
      this.close();
      return;
    }
    this.fail(502, 'Invalid guest reply', fault('EPROTO', 'Invalid preview request frame'));
  }
  private fromGuest(frame: PreviewFrame | undefined) {
    if (this.closed) return;
    if (frame?.type === 'head' && !this.headSeen) {
      this.headSeen = true;
      clearTimeout(this.headTimer);
      let head: PreviewFrame = frame;
      if (this.onHead) {
        try {
          const { headers, cookies } = this.onHead(frame.headers);
          head = { ...frame, headers, ...(cookies?.length ? { cookies } : {}) };
        } catch {
          this.headSeen = false;
          this.fail(502, 'Invalid guest reply', fault('EPROTO', 'Invalid preview response head'));
          return;
        }
      }
      this.forward(this.client, {
        ...head,
        ...(this.previewSocket ? { previewSocket: true } : {}),
        ...(this.previewClient ? { previewClient: true } : {}),
      });
      return;
    }
    if (frame?.type === 'data' && this.headSeen && this.response.add(frame.bytes.length)) {
      const limit = this.policy.preview.responseBytes;
      this.responseBytes += frame.bytes.length;
      if (this.responseBytes > limit) {
        this.fail(
          502,
          'Invalid guest reply',
          fault('E2BIG', 'Preview response exceeds its budget', {
            limit,
            actual: this.responseBytes,
          }),
        );
        return;
      }
      this.forward(this.client, frame);
      return;
    }
    if (frame?.type === 'credit' && this.request.remove(frame.bytes)) {
      this.forward(this.client, frame);
      this.awaitHead();
      return;
    }
    if (frame?.type === 'end' && this.headSeen) {
      // The response is complete; whatever of the request is unread is dropped.
      this.forward(this.client, frame);
      this.close();
      return;
    }
    if (frame?.type === 'abort') {
      if (frame.error) this.owner.failed(reviveError({ ...frame.error }));
      this.forward(this.client, frame);
      this.close();
      return;
    }
    this.fail(502, 'Invalid guest reply', fault('EPROTO', 'Invalid preview response frame'));
  }
  /**
   * Ends the exchange from the host. Before the head the browser gets a
   * complete error response; after it the status is already delivered, so the
   * body stream is errored instead.
   */
  fail(status: number, text: string, error?: Error) {
    if (this.closed) return;
    if (error) this.owner.failed(error);
    if (this.headSeen)
      this.forward(this.client, { type: 'abort', ...(error ? { error: errorRecord(error) } : {}) });
    else {
      this.forward(this.client, { type: 'head', status, headers: {} });
      this.forward(this.client, { type: 'data', bytes: new TextEncoder().encode(text) });
      this.forward(this.client, { type: 'end' });
    }
    this.forward(this.guest, { type: 'abort' });
    this.close();
  }
  private close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.headTimer);
    for (const port of [this.client, this.guest]) {
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
    }
    this.owner.removed(this);
  }
}

/** Every streamed preview exchange of one container. */
export class PreviewRelays {
  private readonly relays = new Set<PreviewRelay>();
  private sweep?: ReturnType<typeof setInterval>;
  private peakRequest = 0;
  private peakResponse = 0;
  private lastFailure?: Error;
  constructor(private readonly policy: ResourcePolicy) {}
  open(
    pid: number,
    client: MessagePort,
    guest: MessagePort,
    previewSocket: boolean,
    bodyLength: number | null,
    onHead?: PreviewHeadHook,
    previewClient = false,
  ): void {
    const relay = new PreviewRelay(
      pid,
      client,
      guest,
      this.policy,
      previewSocket,
      bodyLength,
      {
        failed: (error) => {
          this.lastFailure = error;
        },
        removed: (relay) => {
          this.measure(relay);
          this.relays.delete(relay);
          if (!this.relays.size) {
            clearInterval(this.sweep);
            this.sweep = undefined;
          }
        },
      },
      onHead,
      previewClient,
    );
    this.relays.add(relay);
    // One sweep for all exchanges. A service worker the browser stopped sends
    // no abort, so its silence is the only signal that the reader is gone.
    const idle = this.policy.timers.previewStreamIdleMs;
    this.sweep ??= setInterval(
      () => {
        for (const relay of this.relays)
          if (Date.now() - relay.lastSeen > idle)
            relay.fail(
              503,
              'Guest unavailable',
              fault('ETIMEDOUT', 'Preview stream reader stopped responding'),
            );
      },
      Math.max(1, Math.min(5000, Math.floor(idle / 3))),
    );
  }
  /** The owning process is gone: no frame will ever arrive from it. */
  closeProcess(pid: number, text: string): void {
    for (const relay of this.relays) if (relay.pid === pid) relay.fail(503, text);
  }
  closeAll(text: string): void {
    for (const relay of this.relays) relay.fail(503, text);
  }
  private measure(relay: PreviewRelay) {
    const [request, response] = relay.peaks;
    if (request > this.peakRequest) this.peakRequest = request;
    if (response > this.peakResponse) this.peakResponse = response;
  }
  stats(): PreviewStreams {
    for (const relay of this.relays) this.measure(relay);
    return {
      open: this.relays.size,
      peakResponseInFlightBytes: this.peakResponse,
      peakRequestInFlightBytes: this.peakRequest,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    };
  }
}
