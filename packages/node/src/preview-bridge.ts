import {
  PREVIEW_BRIDGE_CLOSE_MS,
  PREVIEW_BRIDGE_PATH,
  PREVIEW_BRIDGE_PORT_ISSUES,
  bridgeMessage,
  readBridgeMessage,
} from './preview-bridge-protocol';
import { PreviewCookieJar } from './preview-cookies';
import { previewOriginFor } from './preview-origin';
import type { PreviewHeadHook } from './preview-relay';
import type { PreviewHeaders } from './preview-stream';
import { VERSION, fault, record } from './protocol';
import type { ResourcePolicy } from './resource-policy';

// Host side of per-origin preview (design §5(a), §7.2 "preview bridge host
// module"). One hidden bridge iframe per previewed port, on that port's own
// origin. The bridge registers the origin's service worker and asks for a
// port; the host answers with one end of a MessageChannel bound to exactly
// this container and port. The worker sends every request on that origin over
// it in the existing streamed transport (src/preview-fetch.ts), and the host
// relays it as it relays prefix-mode requests (src/preview-relay.ts).
//
// Trust: a message counts only when its source is the iframe this module
// created and its origin is that iframe's preview origin. A port is a
// capability for one (container, port); requests naming anything else are
// refused. Reissues are bounded by PREVIEW_BRIDGE_PORT_ISSUES.

interface BridgeHost {
  readonly containerId: string;
  readonly policy: ResourcePolicy;
  /**
   * Relays one `http` message and its exchange port, as for the root worker;
   * `onHead` rewrites the guest's response head before the preview worker sees it.
   */
  forward(message: Record<string, unknown>, port: MessagePort, onHead?: PreviewHeadHook): void;
  /** Relays one page WebSocket from `origin` into the guest's upgrade handler. */
  socket(message: Record<string, unknown>, port: MessagePort, origin: string): void;
  /** Relays one preview client MessagePort from `origin` to `onPreviewClient` listeners. */
  previewClient(message: Record<string, unknown>, port: MessagePort, origin: string): void;
  /** Returns the configured clientScript for `port`, if active. */
  clientScript(port: number): string | undefined;
}

class Bridge {
  readonly frame: HTMLIFrameElement;
  private channel?: MessagePort;
  private issued = 0;
  private closed = false;
  private ready = false;
  private failure?: Error;
  private readonly waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private unregistered?: () => void;
  // Decision 4: the runtime jar is the source of truth for this preview origin's
  // cookies. It lives here, in the host page, so it outlives a stopped preview
  // worker and HttpOnly values never enter a realm on the preview origin.
  private readonly cookies: PreviewCookieJar;
  // Whether the bridge, framed like the preview, could use document cookies; the
  // worker mirrors guest cookies into the page-visible store only then.
  private cookieMirror = false;
  constructor(
    readonly origin: string,
    readonly port: number,
    private readonly host: BridgeHost,
  ) {
    this.cookies = new PreviewCookieJar(origin);
    this.frame = document.createElement('iframe');
    this.frame.hidden = true;
    this.frame.tabIndex = -1;
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.src = origin + PREVIEW_BRIDGE_PATH + '?host=' + encodeURIComponent(location.origin);
    (document.body ?? document.documentElement).append(this.frame);
  }
  /** Resolves once the preview worker holds a port; rejects at `deadline`. */
  whenReady(deadline: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(
        () => {
          this.waiters.delete(waiter);
          reject(
            fault(
              'ETIMEDOUT',
              `Preview bridge ${this.origin}${PREVIEW_BRIDGE_PATH} did not become ready; serve the runtime's preview-origin files there with the preview headers`,
            ),
          );
        },
        Math.max(0, deadline - Date.now()),
      );
      this.waiters.add(waiter);
    });
  }
  private settle(error?: Error) {
    if (error) this.failure ??= error;
    else this.ready = true;
    for (const waiter of this.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    this.waiters.clear();
  }
  /** A window message whose source and origin are this bridge's. */
  fromBridge(value: unknown) {
    const message = readBridgeMessage(value);
    if (!message || this.closed) return;
    if (!message.versionMatch) {
      this.settle(
        fault('EPROTO', 'Incompatible preview bridge version; serve matching preview-origin files'),
      );
      return;
    }
    if (message.type === 'need-port') {
      this.cookieMirror = message.data.documentCookies === true;
      this.issue();
    }
    if (message.type === 'failed')
      this.settle(
        fault(
          'EASSET',
          `Preview bridge ${this.origin} could not register its service worker: ${String(message.data.message)}`,
        ),
      );
    if (message.type === 'closed') this.unregistered?.();
  }
  private issue() {
    if (this.closed || this.issued >= PREVIEW_BRIDGE_PORT_ISSUES) return;
    const target = this.frame.contentWindow;
    if (!target) return;
    this.issued++;
    this.channel?.close();
    const channel = new MessageChannel();
    this.channel = channel.port1;
    channel.port1.onmessage = (event: MessageEvent<unknown>) =>
      this.fromWorker(channel.port1, event);
    target.postMessage(
      bridgeMessage('port', {
        containerId: this.host.containerId,
        port: this.port,
        resources: this.host.policy,
        cookieMirror: this.cookieMirror,
      }),
      this.origin,
      [channel.port2],
    );
  }
  private fromWorker(channel: MessagePort, event: MessageEvent<unknown>) {
    const data = event.data;
    const reply = event.ports[0];
    if (this.closed || channel !== this.channel || !record(data)) {
      reply?.close();
      return;
    }
    // Exchange requests use the frame protocol of src/preview-fetch.ts.
    if (data.type === 'http' && data.version === VERSION && reply) {
      if (data.containerId === this.host.containerId && data.port === this.port)
        this.forwardHttp(data, reply);
      else reply.close();
      return;
    }
    if (data.type === 'socket' && data.version === VERSION && reply) {
      if (data.containerId === this.host.containerId && data.port === this.port)
        this.host.socket(data, reply, this.origin);
      else {
        reply.postMessage({ version: VERSION, type: 'error' });
        reply.close();
      }
      return;
    }
    if (data.type === 'preview-client' && data.version === VERSION && reply) {
      if (data.containerId === this.host.containerId && data.port === this.port)
        this.host.previewClient(data, reply, this.origin);
      else reply.close();
      return;
    }
    if (data.type === 'client-script' && data.version === VERSION && reply) {
      if (data.containerId === this.host.containerId && data.port === this.port)
        reply.postMessage({ source: this.host.clientScript(this.port) });
      else reply.postMessage({});
      reply.close();
      return;
    }
    const message = readBridgeMessage(data);
    if (!message) {
      reply?.close();
      return;
    }
    if (message.type === 'alive' && reply) {
      reply.postMessage(bridgeMessage('alive'));
      reply.close();
      return;
    }
    if (message.type === 'ready')
      this.settle(
        message.versionMatch
          ? undefined
          : fault(
              'EPROTO',
              'Incompatible preview worker version; serve matching preview-origin files',
            ),
      );
    if (message.type === 'refused')
      this.settle(
        fault('EPROTO', 'Incompatible preview worker version; serve matching preview-origin files'),
      );
    reply?.close();
  }
  /**
   * Adds the jar's Cookie header to one request and moves the guest's
   * Set-Cookie from its response head into the jar. The worker reports the
   * request's SameSite context and the cookies page script can see.
   */
  private forwardHttp(data: Record<string, unknown>, reply: MessagePort) {
    if (typeof data.url !== 'string' || typeof data.method !== 'string' || !record(data.headers)) {
      reply.close();
      return;
    }
    const path = data.url.split('?')[0];
    const { cookie: page, ...headers } = data.headers;
    const cookie = this.cookies.cookieHeader(
      {
        path,
        crossSite: data.crossSite === true,
        navigation: data.navigation === true,
        method: data.method,
      },
      typeof page === 'string' ? page : undefined,
    );
    // The SameSite context is for the jar only; the guest sees an ordinary request.
    const message = { ...data };
    delete message.crossSite;
    delete message.navigation;
    this.host.forward(
      { ...message, headers: cookie === undefined ? headers : { ...headers, cookie } },
      reply,
      (head) => {
        const values: string[] = [];
        const kept: PreviewHeaders = {};
        for (const [name, value] of Object.entries(head))
          if (name.toLowerCase() === 'set-cookie') values.push(...[value].flat());
          else kept[name] = value;
        if (!values.length) return { headers: head };
        return { headers: kept, cookies: this.cookies.store(values, path) };
      },
    );
  }
  /** Tells the worker the host is gone, asks the bridge to unregister it, then removes the frame. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.settle(fault('EPIPE', 'Container closed'));
    try {
      this.channel?.postMessage(bridgeMessage('closed'));
    } catch {
      // A closed channel needs no notice.
    }
    this.channel?.close();
    this.channel = undefined;
    const target = this.frame.contentWindow;
    if (this.ready && target)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, PREVIEW_BRIDGE_CLOSE_MS);
        this.unregistered = () => {
          clearTimeout(timer);
          resolve();
        };
        target.postMessage(bridgeMessage('close'), this.origin);
      });
    this.frame.remove();
  }
}

/** Every per-origin preview bridge of one container. */
export class PreviewBridges {
  private readonly bridges = new Map<number, Bridge>();
  private listening = false;
  constructor(
    private readonly template: string,
    private readonly host: BridgeHost,
  ) {}
  private readonly onMessage = (event: MessageEvent<unknown>) => {
    for (const bridge of this.bridges.values())
      if (event.source === bridge.frame.contentWindow && event.origin === bridge.origin) {
        bridge.fromBridge(event.data);
        return;
      }
  };
  /** The URL of `port`'s preview origin, once its worker can reach the host. */
  async open(port: number, deadline: number): Promise<string> {
    const origin = previewOriginFor(this.template, this.host.containerId, port);
    if (origin === location.origin) throw fault('EINVAL', 'Preview origin equals the host origin');
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('message', this.onMessage);
    }
    let bridge = this.bridges.get(port);
    if (!bridge) {
      bridge = new Bridge(origin, port, this.host);
      this.bridges.set(port, bridge);
    }
    try {
      await bridge.whenReady(deadline);
    } catch (error) {
      if (this.bridges.get(port) === bridge) this.bridges.delete(port);
      await bridge.close();
      throw error;
    }
    return origin + '/';
  }
  async close(): Promise<void> {
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.all(bridges.map((bridge) => bridge.close()));
    if (this.listening) window.removeEventListener('message', this.onMessage);
    this.listening = false;
  }
}
