import { describe, expect, it } from 'vitest';
import {
  type ContainerPreviewOptions,
  DRIVER_CHANNEL,
  type ObservationSnapshot,
  PROTOCOL_VERSION,
  type PreviewCapableContainer,
  buildContainerPreviewClientScript,
  connectContainerPreview,
  connectSandboxPreview,
  isDriverBindPort,
  isDriverHello,
  isDriverRpcRequest,
} from '../../src/index.js';

/**
 * Exact structural mirrors of `@inbrowser/node`'s `PreviewOptions`,
 * `BrowserContainer`, and `SandboxContainer` under `exactOptionalPropertyTypes: true`.
 */
interface InbrowserNodePreviewOptions {
  requestPath?: 'strip' | 'preserve';
  webSocket?: boolean;
  clientScript?: string;
}

interface BrowserContainerLike {
  readonly id: `${string}-${string}-${string}-${string}-${string}`;
  preview(port: number, options?: InbrowserNodePreviewOptions): Promise<string>;
  onPreviewClient(port: number, listener: (clientPort: MessagePort) => void): () => void;
  teardown(): Promise<void>;
}

interface SandboxContainerLike {
  readonly id: string;
  readonly origin: string;
  preview(port: number, options?: InbrowserNodePreviewOptions): Promise<string>;
  onPreviewClient(port: number, listener: (clientPort: MessagePort) => void): () => void;
  dispose(): Promise<void>;
}

describe('buildContainerPreviewClientScript & PreviewCapableContainer contract', () => {
  it('accepts BrowserContainer and SandboxContainer shapes structurally without casts', () => {
    const browserContainer: BrowserContainerLike = {
      id: 'ct-alpha-beta-gamma-delta',
      async preview(port) {
        return `http://127.0.0.1:4173/__preview__/${String(port)}/`;
      },
      onPreviewClient() {
        return () => {};
      },
      async teardown() {},
    };

    const sandboxContainer: SandboxContainerLike = {
      id: 'sb-1',
      origin: 'http://sandbox.localhost:4742',
      async preview(port) {
        return `http://sb-1-${String(port)}.localhost:4743/`;
      },
      onPreviewClient() {
        return () => {};
      },
      async dispose() {},
    };

    const assignableBrowser: PreviewCapableContainer = browserContainer;
    const assignableSandbox: PreviewCapableContainer = sandboxContainer;

    expect(typeof assignableBrowser.preview).toBe('function');
    expect(typeof assignableSandbox.onPreviewClient).toBe('function');
  });

  it('embeds the minified preload IIFE (< 64 KiB), deletes globalThis.__inbrowserPreviewPort, and transfers it via a valid DriverBindPortMessage', () => {
    const script = buildContainerPreviewClientScript('globalThis.__extraHookRan = true;');
    const byteLength = new TextEncoder().encode(script).byteLength;

    expect(script.length).toBeGreaterThan(1_000);
    expect(byteLength).toBeLessThan(64 * 1024);

    const postedMessages: Array<{
      readonly message: unknown;
      readonly targetOrigin: string;
      readonly transfer: readonly unknown[];
    }> = [];

    const fakeWindow = Object.assign(new EventTarget(), {
      postMessage(message: unknown, targetOrigin: string, transfer?: readonly unknown[]): void {
        postedMessages.push({
          message,
          targetOrigin,
          transfer: transfer ?? [],
        });
      },
    });

    const channel = new MessageChannel();
    try {
      Reflect.set(globalThis, '__inbrowserPreviewPort', channel.port1);
      Reflect.deleteProperty(globalThis, '__extraHookRan');

      const runner = new Function('window', script);
      runner(fakeWindow);

      expect('__inbrowserPreviewPort' in globalThis).toBe(false);
      expect(Reflect.get(globalThis, '__extraHookRan')).toBe(true);
      expect(postedMessages).toHaveLength(1);

      const firstPost = postedMessages[0];
      expect(firstPost).toBeDefined();
      expect(isDriverBindPort(firstPost?.message)).toBe(true);
      expect(firstPost?.targetOrigin).toBe('*');
      expect(firstPost?.transfer).toEqual([channel.port1]);
    } finally {
      Reflect.deleteProperty(globalThis, '__inbrowserPreviewPort');
      Reflect.deleteProperty(globalThis, '__extraHookRan');
      channel.port1.close();
      channel.port2.close();
    }
  });
});

function attachSimulatedPreloadPeer(
  guestPort: MessagePort,
  url: string,
  title: string,
): () => void {
  let revCounter = 1;
  const onMessage = (event: MessageEvent<unknown>): void => {
    const data: unknown = event.data;
    if (isDriverHello(data)) {
      if (data.minRev !== undefined && data.minRev >= revCounter) {
        revCounter = data.minRev + 1;
      }
      guestPort.postMessage({
        channel: DRIVER_CHANNEL,
        kind: 'hello_ack',
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          protocolVersion: PROTOCOL_VERSION,
          allowEval: data.allowEval,
          captureModes: ['silent'],
          trustedInput: false,
        },
      });
      return;
    }
    if (isDriverRpcRequest(data) && data.method === 'observe') {
      const snapshot: ObservationSnapshot = {
        rev: revCounter,
        url,
        title,
        viewport: { width: 800, height: 600 },
        diagnostics: {
          compileOverlay: null,
          consoleErrors: [],
          pageErrors: [],
          networkFailures: [],
        },
        elements: [{ role: 'heading', name: title }],
      };
      revCounter += 1;
      guestPort.postMessage({
        channel: DRIVER_CHANNEL,
        kind: 'rpc_response',
        protocolVersion: PROTOCOL_VERSION,
        id: data.id,
        ok: true,
        result: snapshot,
      });
    }
  };
  guestPort.addEventListener('message', onMessage);
  guestPort.start();
  return () => {
    guestPort.removeEventListener('message', onMessage);
    guestPort.close();
  };
}

describe('connectContainerPreview & connectSandboxPreview orchestration', () => {
  it('subscribes onPreviewClient before container.preview, navigates iframe when requested, and completes 1-RTT handshake', async () => {
    const callOrder: string[] = [];
    let capturedOptions: ContainerPreviewOptions | undefined;
    const listeners = new Set<(port: MessagePort) => void>();
    const dispatchClientPort = (port: MessagePort): void => {
      for (const fn of listeners) {
        fn(port);
      }
    };

    const container: PreviewCapableContainer = {
      onPreviewClient(port, listener) {
        callOrder.push(`onPreviewClient:${String(port)}`);
        listeners.add(listener);
        return () => {
          callOrder.push('unsubscribe');
          listeners.delete(listener);
        };
      },
      async preview(port, options) {
        callOrder.push(`preview:${String(port)}`);
        capturedOptions = options;
        return `http://sb-1-${String(port)}.localhost:4743/`;
      },
    };

    const channel = new MessageChannel();
    const detachGuest = attachSimulatedPreloadPeer(
      channel.port1,
      'http://sb-1-3000.localhost:4743/',
      'Initial Preview',
    );

    let iframeSrc = 'about:blank';
    let loadListenersAdded = 0;
    const fakeIframe = {
      get src(): string {
        return iframeSrc;
      },
      set src(next: string) {
        callOrder.push(`iframe.src:${next}`);
        iframeSrc = next;
        dispatchClientPort(channel.port2);
      },
      addEventListener(type: string): void {
        if (type === 'load') loadListenersAdded += 1;
      },
      removeEventListener(): void {},
    } as unknown as HTMLIFrameElement; // Invariant: minimal HTMLIFrameElement test double for Node orchestration test

    try {
      const connected = await connectContainerPreview(container, 3000, {
        iframe: fakeIframe,
        allowEval: true,
        previewOptions: {
          requestPath: 'preserve',
          webSocket: true,
          extraClientScript: '/* custom hook */',
        },
      });

      expect(callOrder).toEqual([
        'onPreviewClient:3000',
        'preview:3000',
        'iframe.src:http://sb-1-3000.localhost:4743/',
      ]);
      expect(loadListenersAdded).toBe(0);
      expect(capturedOptions?.requestPath).toBe('preserve');
      expect(capturedOptions?.webSocket).toBe(true);
      expect(capturedOptions?.clientScript).toContain('/* custom hook */');
      expect(connected.previewUrl).toBe('http://sb-1-3000.localhost:4743/');
      expect(connected.driver.capabilities.allowEval).toBe(true);

      const snap = await connected.driver.observe();
      expect(snap.title).toBe('Initial Preview');

      connected.driver.dispose();
      expect(callOrder).toContain('unsubscribe');
    } finally {
      detachGuest();
    }

    // Also verify navigateIframe: false and connectSandboxPreview alias
    const manualChannel = new MessageChannel();
    const detachManualGuest = attachSimulatedPreloadPeer(
      manualChannel.port1,
      'http://sb-1-3000.localhost:4743/manual',
      'Manual Navigation',
    );
    let manualIframeSrc = 'about:blank';
    const manualIframe = {
      get src(): string {
        return manualIframeSrc;
      },
      set src(next: string) {
        manualIframeSrc = next;
      },
      addEventListener(): void {},
      removeEventListener(): void {},
    } as unknown as HTMLIFrameElement; // Invariant: minimal HTMLIFrameElement test double for navigateIframe: false check

    try {
      const connectPromise = connectSandboxPreview(container, 3000, {
        iframe: manualIframe,
        navigateIframe: false,
      });
      await Promise.resolve();
      expect(manualIframeSrc).toBe('about:blank');
      dispatchClientPort(manualChannel.port2);
      const manualConnected = await connectPromise;
      const manualSnap = await manualConnected.driver.observe();
      expect(manualSnap.title).toBe('Manual Navigation');
      manualConnected.driver.dispose();
    } finally {
      detachManualGuest();
    }
  });

  it('rebinds seamlessly on subsequent onPreviewClient MessagePorts and cleans up listeners + unclaimed ports on abort, timeout, or preview failure', async () => {
    const listeners = new Set<(port: MessagePort) => void>();
    let unsubscribeCalls = 0;

    const dispatchClientPort = (port: MessagePort): void => {
      for (const fn of listeners) {
        fn(port);
      }
    };

    // 1. Replacement MessagePort rebind across simulated full-page navigation
    const navContainer: PreviewCapableContainer = {
      onPreviewClient(_port, listener) {
        listeners.add(listener);
        return () => {
          unsubscribeCalls += 1;
          listeners.delete(listener);
        };
      },
      async preview(port) {
        return `http://sb-1-${String(port)}.localhost:4743/`;
      },
    };

    const page1Channel = new MessageChannel();
    const page2Channel = new MessageChannel();
    const detachPage1 = attachSimulatedPreloadPeer(
      page1Channel.port1,
      'http://sb-1-3000.localhost:4743/',
      'Page One',
    );
    const detachPage2 = attachSimulatedPreloadPeer(
      page2Channel.port1,
      'http://sb-1-3000.localhost:4743/page2',
      'Page Two',
    );

    try {
      const pendingConnect = connectContainerPreview(navContainer, 3000);
      await Promise.resolve();
      dispatchClientPort(page1Channel.port2);
      const { driver } = await pendingConnect;

      const firstSnap = await driver.observe();
      expect(firstSnap.title).toBe('Page One');
      expect(firstSnap.rev).toBe(1);

      // Deliver replacement port for /page2
      dispatchClientPort(page2Channel.port2);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const secondSnap = await driver.observe();
      expect(secondSnap.title).toBe('Page Two');
      expect(secondSnap.rev).toBeGreaterThan(firstSnap.rev);

      driver.dispose();
      expect(listeners.size).toBe(0);
      expect(unsubscribeCalls).toBe(1);
    } finally {
      detachPage1();
      detachPage2();
    }

    // 2. AbortSignal cancels even while container.preview() is pending and closes queued ports
    let hungUnsubscribed = 0;
    let queuedPortClosed = 0;
    const hungListeners = new Set<(port: MessagePort) => void>();
    const hungContainer: PreviewCapableContainer = {
      onPreviewClient(_port, listener) {
        hungListeners.add(listener);
        return () => {
          hungUnsubscribed += 1;
          hungListeners.delete(listener);
        };
      },
      preview() {
        return new Promise<string>(() => {});
      },
    };

    const abortController = new AbortController();
    const earlyChannel = new MessageChannel();
    const origClose = earlyChannel.port2.close.bind(earlyChannel.port2);
    earlyChannel.port2.close = (): void => {
      queuedPortClosed += 1;
      origClose();
    };

    try {
      const hungPromise = connectContainerPreview(hungContainer, 3000, {
        signal: abortController.signal,
        handshakeTimeoutMs: 500,
      });
      for (const fn of hungListeners) {
        fn(earlyChannel.port2);
      }
      abortController.abort(new Error('cancelled during preview'));

      await expect(hungPromise).rejects.toMatchObject({
        code: 'DRIVER_TIMEOUT',
      });
      expect(hungUnsubscribed).toBe(1);
      expect(queuedPortClosed).toBe(1);
    } finally {
      earlyChannel.port1.close();
      origClose();
    }

    // 3. Handshake timeout when no MessagePort arrives unsubscribes cleanly
    let timeoutUnsubscribed = 0;
    const silentContainer: PreviewCapableContainer = {
      onPreviewClient() {
        return () => {
          timeoutUnsubscribed += 1;
        };
      },
      async preview(port) {
        return `http://sb-1-${String(port)}.localhost:4743/`;
      },
    };

    await expect(
      connectContainerPreview(silentContainer, 3000, { handshakeTimeoutMs: 40 }),
    ).rejects.toMatchObject({
      code: 'DRIVER_TIMEOUT',
    });
    expect(timeoutUnsubscribed).toBe(1);

    // 4. container.preview() rejection unsubscribes and closes any queued ports
    let rejectUnsubscribed = 0;
    let rejectQueuedPortClosed = 0;
    const rejectListeners = new Set<(port: MessagePort) => void>();
    const rejectingContainer: PreviewCapableContainer = {
      onPreviewClient(_port, listener) {
        rejectListeners.add(listener);
        return () => {
          rejectUnsubscribed += 1;
          rejectListeners.delete(listener);
        };
      },
      async preview() {
        await Promise.resolve();
        throw new Error('ECONNREFUSED: port 3000 not listening');
      },
    };

    const rejectChannel = new MessageChannel();
    const origRejectClose = rejectChannel.port2.close.bind(rejectChannel.port2);
    rejectChannel.port2.close = (): void => {
      rejectQueuedPortClosed += 1;
      origRejectClose();
    };

    try {
      const rejectPromise = connectContainerPreview(rejectingContainer, 3000);
      for (const fn of rejectListeners) {
        fn(rejectChannel.port2);
      }
      await expect(rejectPromise).rejects.toThrow('ECONNREFUSED');
      expect(rejectUnsubscribed).toBe(1);
      expect(rejectQueuedPortClosed).toBe(1);
    } finally {
      rejectChannel.port1.close();
      origRejectClose();
    }
  });
});
