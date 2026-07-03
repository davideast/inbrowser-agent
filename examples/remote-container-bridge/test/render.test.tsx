import { afterEach, describe, expect, test } from 'bun:test';
import {
  type BridgeEnvelope,
  REMOTE_PROTOCOL_TYPES,
  type RemoteBridgeEvent,
} from '@inbrowser/sandbox/remote';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { RemoteContainerBridgeApp } from '../src/client/App.js';

describe('remote container bridge UI', () => {
  let root: Root | undefined;
  let sockets: FakeBridgeWebSocket[] = [];

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = undefined;
    sockets = [];
    document.body.innerHTML = '';
  });

  test('keeps the demo focused on one click that streams container output', async () => {
    installDom(() => sockets);
    const container = document.createElement('div');
    document.body.append(container);

    root = createRoot(container);
    await act(async () => {
      root?.render(<RemoteContainerBridgeApp />);
    });

    await waitForText('Run container');
    expect(document.body.textContent).toContain('Container stream');
    expect(document.body.textContent).toContain('Waiting for output.');
    expect(document.body.textContent).not.toContain('Expose port');
    expect(document.body.textContent).not.toContain('Create session');
    expect(document.body.textContent).not.toContain('Diagnostic');

    await clickButton('Run container');
    await waitForText('container-stream-1');
    await waitForText('container-stream-3');
    await waitForText('[exit 0] container session closed');

    const terminalText = document.querySelector('.remote-terminal')?.textContent ?? '';
    expect(terminalText).toContain('container-stream-1');
    expect(terminalText).toContain('container-stream-2');
    expect(terminalText).toContain('container-stream-3');
    expect(document.body.textContent).toContain('Run again');
    expect(sockets[0]?.closed).toBe(true);

    await clickButton('Details');
    await waitForText('Diagnostic');
    expect(document.body.textContent).toContain('Timeline');
  });
});

function installDom(sockets: () => FakeBridgeWebSocket[]): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:5184/',
    pretendToBeVisual: true,
  });

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLPreElement: dom.window.HTMLPreElement,
    fetch: fakeFetch,
    WebSocket: createFakeWebSocketClass(sockets),
  });
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), 'http://127.0.0.1:5184/');
  if (url.pathname === '/bridge-config') {
    return Response.json({
      provider: 'fake',
      token: 'test-token',
      bridgeUrl: '/bridge',
      statusUrl: '/status',
      root: '/work',
    });
  }
  if (url.pathname === '/status') {
    return Response.json({
      provider: 'fake',
      authenticated: true,
      status: {
        providerKind: 'fake',
        state: 'ready',
        runtimeAvailable: true,
        systemReady: true,
        image: 'fake',
        imagePresent: true,
        message: 'fake provider ready',
        checkedAt: Date.now(),
      },
    });
  }
  return new Response('not found', { status: 404 });
}

function createFakeWebSocketClass(sockets: () => FakeBridgeWebSocket[]): typeof WebSocket {
  return class TestWebSocket extends FakeBridgeWebSocket {
    constructor(url: string | URL) {
      super(String(url));
      sockets().push(this);
    }
  } as unknown as typeof WebSocket;
}

class FakeBridgeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeBridgeWebSocket.CONNECTING;
  closed = false;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      this.readyState = FakeBridgeWebSocket.OPEN;
      this.dispatch('open', {});
    }, 0);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as BridgeEnvelope;
    if (envelope.type === REMOTE_PROTOCOL_TYPES.sessionCreate) {
      this.respond(envelope, {
        root: '/work',
        capabilities: { fs: true, shell: true, persistentStorage: false },
      });
      return;
    }
    if (envelope.type === REMOTE_PROTOCOL_TYPES.runStart) {
      this.emitBridgeEvent(envelope, {
        type: 'artifact',
        artifact: outputArtifact(envelope, 'container-stream-1\n'),
      });
      this.emitBridgeEvent(envelope, {
        type: 'artifact',
        artifact: outputArtifact(envelope, 'container-stream-2\n'),
      });
      this.emitBridgeEvent(envelope, {
        type: 'artifact',
        artifact: outputArtifact(envelope, 'container-stream-3\n'),
      });
      this.respond(envelope, {
        command: 'for i in 1 2 3; do echo container-stream-$i; sleep 1; done',
        cwd: '/work',
        exitCode: 0,
        stdout: 'container-stream-1\ncontainer-stream-2\ncontainer-stream-3\n',
        stderr: '',
        durationMs: 30,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    }
  }

  close(): void {
    if (this.readyState === FakeBridgeWebSocket.CLOSED) return;
    this.readyState = FakeBridgeWebSocket.CLOSED;
    this.closed = true;
    this.dispatch('close', {});
  }

  private respond(request: BridgeEnvelope, payload: unknown): void {
    this.dispatchMessage({
      id: `response-${request.id}`,
      sessionId: request.sessionId,
      kind: 'response',
      type: request.type,
      replyTo: request.id,
      sentAt: Date.now(),
      peer: 'host',
      payload,
    } satisfies BridgeEnvelope);
  }

  private emitBridgeEvent(request: BridgeEnvelope, payload: RemoteBridgeEvent): void {
    this.dispatchMessage({
      id: `event-${request.id}-${Math.random().toString(36).slice(2)}`,
      sessionId: request.sessionId,
      kind: 'event',
      type: REMOTE_PROTOCOL_TYPES.event,
      sentAt: Date.now(),
      peer: 'host',
      payload,
    } satisfies BridgeEnvelope);
  }

  private dispatchMessage(envelope: BridgeEnvelope): void {
    setTimeout(() => {
      this.dispatch('message', { data: JSON.stringify(envelope) });
    }, 0);
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function outputArtifact(envelope: BridgeEnvelope, chunk: string) {
  return {
    id: `artifact-${envelope.id}-${chunk.trim()}`,
    kind: 'run.output',
    timestamp: Date.now(),
    path: '/work',
    requestId: envelope.id,
    stream: 'stdout',
    chunk,
  };
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => {
    (button as HTMLButtonElement).click();
  });
}

async function waitForText(text: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 3_000) {
    if (document.body.textContent?.includes(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`Timed out waiting for text: ${text}\n\n${document.body.textContent ?? ''}`);
}
