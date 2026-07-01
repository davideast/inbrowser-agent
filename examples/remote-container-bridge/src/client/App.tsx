import { SessionShell } from '@inbrowser/example-shared/session-shell';
import type {
  DemoAction,
  DemoController,
  DemoPanel,
  DemoTimelineItem,
} from '@inbrowser/example-shared/session-types';
import {
  type BridgeEnvelope,
  REMOTE_PROTOCOL_TYPES,
  type RemoteBridgeEvent,
  type RemoteHostStatusResponse,
  type RemoteRunResponse,
  type RemoteSessionCreateResponse,
} from '@inbrowser/sandbox/remote';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_SESSION_ID = 'demo-container-session';
const DEFAULT_COMMAND = 'for i in 1 2 3; do echo container-stream-$i; sleep 1; done';

interface BridgeConfig {
  provider: string;
  token: string;
  bridgeUrl: string;
  statusUrl: string;
  root: string;
}

interface TerminalChunk {
  id: string;
  stream: 'stdin' | 'stdout' | 'stderr' | 'system';
  text: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

type ConnectionState =
  | 'idle'
  | 'loading'
  | 'connecting'
  | 'connected'
  | 'running'
  | 'complete'
  | 'error';

export function RemoteContainerBridgeApp() {
  const localItemSequence = useRef(0);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const socketRef = useRef<WebSocket | null>(null);
  const sequenceRef = useRef(0);
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [hostStatus, setHostStatus] = useState<RemoteHostStatusResponse | null>(null);
  const [timeline, setTimeline] = useState<DemoTimelineItem[]>([]);
  const [terminal, setTerminal] = useState<TerminalChunk[]>([]);
  const [activeViewId, setActiveViewId] = useState('stream');
  const [connectionState, setConnectionState] = useState<ConnectionState>('loading');
  const [sessionRoot, setSessionRoot] = useState('/work');
  const [exitCode, setExitCode] = useState<string>('pending');
  const [error, setError] = useState<string | undefined>();

  const appendTimelineItem = useCallback(
    (item: Omit<DemoTimelineItem, 'id' | 'timestamp'> & { timestamp?: number }) => {
      setTimeline((items) => [
        ...items,
        {
          ...item,
          id: `remote-${Date.now()}-${localItemSequence.current++}`,
          timestamp: item.timestamp ?? Date.now(),
        },
      ]);
    },
    [],
  );

  const appendTerminal = useCallback((stream: TerminalChunk['stream'], text: string) => {
    setTerminal((chunks) => [
      ...chunks,
      { id: `chunk-${Date.now()}-${sequenceRef.current++}`, stream, text },
    ]);
  }, []);

  const refreshStatus = useCallback(
    async (source = config) => {
      if (!source) return null;
      const payload = await fetchBridgeStatus(source);
      setHostStatus(payload);
      setConnectionState((state) =>
        state === 'loading' || state === 'idle' ? statusToConnectionState(payload) : state,
      );
      return payload;
    },
    [config],
  );

  useEffect(() => {
    let disposed = false;
    async function loadConfig() {
      try {
        const response = await fetch('/bridge-config');
        if (!response.ok) throw new Error(`Config request failed (${response.status})`);
        const payload = (await response.json()) as BridgeConfig;
        if (disposed) return;
        setConfig(payload);
        setSessionRoot(payload.root);
        appendTimelineItem({
          kind: 'note',
          title: 'bridge config loaded',
          body: `${payload.provider} provider is reachable through the Vite bridge proxy.`,
          status: 'ok',
        });
        const status = await fetchBridgeStatus(payload);
        setHostStatus(status);
        setConnectionState(statusToConnectionState(status));
      } catch (err) {
        if (disposed) return;
        const message = errorMessage(err);
        setError(message);
        setConnectionState('error');
        appendTimelineItem({
          kind: 'error',
          title: 'bridge config failed',
          body: message,
          status: 'failed',
        });
      }
    }
    void loadConfig();
    return () => {
      disposed = true;
      closeSocket(socketRef.current, pendingRef.current);
    };
  }, [appendTimelineItem]);

  const handleBridgeEvent = useCallback(
    (event: RemoteBridgeEvent) => {
      if (event.type === 'artifact') {
        const artifact = event.artifact as {
          kind?: string;
          stream?: 'stdout' | 'stderr';
          chunk?: string;
        };
        if (artifact.kind === 'run.output' && artifact.chunk) {
          appendTerminal(artifact.stream ?? 'stdout', artifact.chunk);
        }
        return;
      }
      if (event.type === 'port') {
        appendTimelineItem({
          kind: 'preview',
          title: `port ${event.port.port} exposed`,
          body: event.port.url ?? 'The bridge host returned port metadata.',
          status: event.port.url ? 'ok' : 'info',
        });
        return;
      }
      if (event.type === 'file') {
        appendTimelineItem({
          kind: 'file',
          title: `${event.event.type} ${event.event.path}`,
          body: event.event.targetPath,
          status: 'info',
        });
        return;
      }
      appendTimelineItem({
        kind: 'note',
        title: `sandbox event: ${event.event.type}`,
        detail: JSON.stringify(event.event, null, 2),
        status: 'info',
      });
    },
    [appendTerminal, appendTimelineItem],
  );

  const request = useCallback(async <T,>(type: string, payload: unknown): Promise<T> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Bridge socket is not connected.');
    }
    const id = `remote-ui-${Date.now().toString(36)}-${sequenceRef.current++}`;
    const envelope = {
      id,
      sessionId: DEFAULT_SESSION_ID,
      kind: 'request',
      type,
      sentAt: Date.now(),
      peer: 'browser',
      payload,
    } satisfies BridgeEnvelope;
    socket.send(JSON.stringify(envelope));
    return new Promise<T>((resolve, reject) => {
      pendingRef.current.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }, []);

  const connect = useCallback(async () => {
    if (!config) throw new Error('Bridge config has not loaded.');
    closeSocket(socketRef.current, pendingRef.current);
    setConnectionState('connecting');
    setError(undefined);

    const socket = new WebSocket(createBridgeWebSocketUrl(config, DEFAULT_SESSION_ID));
    socketRef.current = socket;
    socket.addEventListener('message', (event) => {
      const envelope = JSON.parse(String(event.data)) as BridgeEnvelope;
      if ((envelope.kind === 'response' || envelope.kind === 'error') && envelope.replyTo) {
        const pending = pendingRef.current.get(envelope.replyTo);
        if (!pending) return;
        pendingRef.current.delete(envelope.replyTo);
        if (envelope.kind === 'error') {
          pending.reject(new Error(String((envelope.payload as { message?: string }).message)));
        } else {
          pending.resolve(envelope.payload);
        }
        return;
      }
      if (envelope.kind === 'event') handleBridgeEvent(envelope.payload as RemoteBridgeEvent);
    });
    socket.addEventListener('close', () => {
      if (socketRef.current === socket) socketRef.current = null;
      rejectPending(pendingRef.current, new Error('Bridge socket closed.'));
      setConnectionState((state) => {
        if (state === 'running') return 'error';
        if (state === 'connected' || state === 'connecting') return 'idle';
        return state;
      });
    });
    await waitForOpen(socket);
    const session = await request<RemoteSessionCreateResponse>(
      REMOTE_PROTOCOL_TYPES.sessionCreate,
      {
        root: config.root,
      },
    );
    setSessionRoot(session.root);
    setConnectionState('connected');
    appendTimelineItem({
      kind: 'run',
      title: 'container session ready',
      body: `${DEFAULT_SESSION_ID} mounted at ${session.root}.`,
      status: 'ok',
    });
    await refreshStatus(config);
    return session;
  }, [appendTimelineItem, config, handleBridgeEvent, refreshStatus, request]);

  const ensureConnected = useCallback(async () => {
    if (socketRef.current?.readyState === WebSocket.OPEN) return;
    await connect();
  }, [connect]);

  const runCommand = useCallback(async () => {
    setError(undefined);
    setExitCode('pending');
    setConnectionState('connecting');
    setTerminal([]);
    try {
      await ensureConnected();
      setConnectionState('running');
      appendTerminal('stdin', `$ ${DEFAULT_COMMAND}\n`);
      appendTimelineItem({
        kind: 'operator',
        title: 'command started',
        body: DEFAULT_COMMAND,
        status: 'pending',
      });
      const result = await request<RemoteRunResponse>(REMOTE_PROTOCOL_TYPES.runStart, {
        command: DEFAULT_COMMAND,
        options: { cwd: sessionRoot },
      });
      setExitCode(String(result.exitCode));
      setConnectionState(result.exitCode === 0 ? 'complete' : 'error');
      appendTerminal('system', `\n[exit ${result.exitCode}] container session closed\n`);
      appendTimelineItem({
        kind: 'run',
        title: result.exitCode === 0 ? 'command completed' : 'command failed',
        body: `${result.durationMs ?? 0}ms in ${result.cwd}`,
        detail: JSON.stringify(
          {
            exitCode: result.exitCode,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
          },
          null,
          2,
        ),
        status: result.exitCode === 0 ? 'ok' : 'failed',
      });
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      setConnectionState('error');
      appendTerminal('stderr', `\n${message}\n`);
      appendTimelineItem({
        kind: 'error',
        title: 'command failed',
        body: message,
        status: 'failed',
      });
    } finally {
      closeSocket(socketRef.current, pendingRef.current);
      socketRef.current = null;
      void refreshStatus(config);
    }
  }, [
    appendTerminal,
    appendTimelineItem,
    config,
    ensureConnected,
    refreshStatus,
    request,
    sessionRoot,
  ]);

  const runDisabled =
    !config ||
    connectionState === 'loading' ||
    connectionState === 'connecting' ||
    connectionState === 'running';

  const actions = useMemo<DemoAction[]>(
    () => [
      {
        id: 'run',
        icon: '▶',
        label: runButtonLabel(connectionState),
        description: 'Run the sample command in a real container.',
        consequence: 'Stdout streams into the terminal while the process is still active.',
        primary: true,
        disabled: runDisabled,
        run: () => void runCommand(),
      },
    ],
    [connectionState, runCommand, runDisabled],
  );

  const panels = useMemo<DemoPanel[]>(
    () => [
      {
        id: 'stream',
        label: 'Stream',
        title: 'Container stream',
        render: () => (
          <StreamPanel
            command={DEFAULT_COMMAND}
            connectionState={connectionState}
            disabled={runDisabled}
            error={error}
            exitCode={exitCode}
            provider={config?.provider ?? hostStatus?.provider}
            status={hostStatus}
            terminal={terminal}
            onRun={runCommand}
          />
        ),
      },
      {
        id: 'details',
        label: 'Details',
        title: 'Bridge details',
        render: () => (
          <DetailsPanel
            config={config}
            error={error}
            exitCode={exitCode}
            sessionRoot={sessionRoot}
            status={hostStatus}
            timeline={timeline}
          />
        ),
      },
    ],
    [
      config,
      connectionState,
      error,
      exitCode,
      hostStatus,
      runCommand,
      runDisabled,
      sessionRoot,
      terminal,
      timeline,
    ],
  );

  const controller = useMemo<DemoController>(
    () => ({
      title: 'Remote container stream',
      eyebrow: '@inbrowser/sandbox/remote',
      status: error ?? statusLabel(connectionState, hostStatus),
      timeline,
      panels,
      activeViewId,
      views: [
        { id: 'stream', label: 'Stream' },
        { id: 'details', label: 'Details' },
      ],
      actions,
      onSelectView: setActiveViewId,
    }),
    [actions, activeViewId, connectionState, error, hostStatus, panels, timeline],
  );

  return <SessionShell controller={controller} />;
}

function StreamPanel({
  command,
  connectionState,
  disabled,
  error,
  exitCode,
  provider,
  status,
  terminal,
  onRun,
}: {
  command: string;
  connectionState: ConnectionState;
  disabled: boolean;
  error?: string;
  exitCode: string;
  provider?: string;
  status: RemoteHostStatusResponse | null;
  terminal: readonly TerminalChunk[];
  onRun(): void;
}) {
  return (
    <section className="remote-runner" aria-label="Remote container stream">
      <div className="remote-runner-header">
        <div className="remote-runner-title">
          <span>{provider ?? 'loading provider'}</span>
          <h1>Container stream</h1>
          <p>{statusText(connectionState, status, error)}</p>
        </div>
        <button
          type="button"
          className="remote-run-button"
          data-running={
            connectionState === 'connecting' || connectionState === 'running' || undefined
          }
          disabled={disabled}
          onClick={onRun}
        >
          <span aria-hidden="true">▶</span>
          <strong>{runButtonLabel(connectionState)}</strong>
        </button>
      </div>

      <dl className="remote-status-strip" aria-label="Container run state">
        <div data-tone={stateTone(connectionState)}>
          <dt>State</dt>
          <dd>{stateLabel(connectionState)}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>{status?.status.runtimeAvailable ? 'available' : 'pending'}</dd>
        </div>
        <div data-tone={exitCodeTone(exitCode)}>
          <dt>Exit</dt>
          <dd>{exitCode}</dd>
        </div>
      </dl>

      <div className="remote-command-line" aria-label="Container command">
        <span>$</span>
        <code>{command}</code>
      </div>

      {error ? (
        <div className="remote-error" role="alert">
          {error}
        </div>
      ) : null}

      <TerminalPanel chunks={terminal} />
    </section>
  );
}

function TerminalPanel({ chunks }: { chunks: readonly TerminalChunk[] }) {
  return (
    <pre className="remote-terminal" aria-label="Container output">
      {chunks.length === 0 ? (
        <span data-stream="system">Waiting for output.</span>
      ) : (
        chunks.map((chunk) => (
          <span key={chunk.id} data-stream={chunk.stream}>
            {chunk.text}
          </span>
        ))
      )}
    </pre>
  );
}

function DetailsPanel({
  config,
  status,
  error,
  timeline,
  sessionRoot,
  exitCode,
}: {
  config: BridgeConfig | null;
  status: RemoteHostStatusResponse | null;
  error?: string;
  timeline: readonly DemoTimelineItem[];
  sessionRoot: string;
  exitCode: string;
}) {
  return (
    <div className="remote-details">
      <dl className="remote-detail-grid">
        <div>
          <dt>Provider</dt>
          <dd>{status?.provider ?? config?.provider ?? 'loading'}</dd>
        </div>
        <div>
          <dt>Host</dt>
          <dd>{status?.status.state ?? 'unknown'}</dd>
        </div>
        <div>
          <dt>Root</dt>
          <dd>{sessionRoot}</dd>
        </div>
        <div>
          <dt>Exit</dt>
          <dd>{exitCode}</dd>
        </div>
      </dl>

      <section className="remote-detail-section">
        <h2>Diagnostic</h2>
        <pre>{JSON.stringify({ config, status, error }, null, 2)}</pre>
      </section>

      <section className="remote-detail-section">
        <h2>Timeline</h2>
        <TimelineList items={timeline} />
      </section>
    </div>
  );
}

function TimelineList({ items }: { items: readonly DemoTimelineItem[] }) {
  if (items.length === 0) {
    return <div className="remote-empty">No events yet.</div>;
  }
  return (
    <ol className="remote-timeline">
      {items.map((item) => (
        <li key={item.id} data-status={item.status}>
          <span>{item.kind}</span>
          <strong>{item.title}</strong>
          {item.body ? <p>{item.body}</p> : null}
          {item.detail ? <pre>{item.detail}</pre> : null}
        </li>
      ))}
    </ol>
  );
}

function createBridgeWebSocketUrl(config: BridgeConfig, sessionId: string): string {
  const url = new URL(config.bridgeUrl, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('role', 'browser');
  url.searchParams.set('token', config.token);
  return url.toString();
}

async function fetchBridgeStatus(config: BridgeConfig): Promise<RemoteHostStatusResponse> {
  const url = new URL(config.statusUrl, location.href);
  url.searchParams.set('token', config.token);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Status request failed (${response.status})`);
  return (await response.json()) as RemoteHostStatusResponse;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Bridge socket failed to connect.'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

function closeSocket(socket: WebSocket | null, pending: Map<string, PendingRequest>) {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    socket.close(1000, 'demo closing');
  }
  rejectPending(pending, new Error('Bridge socket closed.'));
}

function rejectPending(pending: Map<string, PendingRequest>, error: Error) {
  for (const item of pending.values()) item.reject(error);
  pending.clear();
}

function statusToConnectionState(status: RemoteHostStatusResponse): ConnectionState {
  if (status.status.state === 'error') return 'error';
  if (status.status.state === 'starting') return 'connecting';
  return 'idle';
}

function statusLabel(state: ConnectionState, status: RemoteHostStatusResponse | null): string {
  if (state === 'complete') return 'stream complete';
  if (state === 'running') return 'streaming output';
  if (state === 'connected') return 'session connected';
  if (state === 'connecting') return 'starting container';
  if (state === 'loading') return 'loading bridge config';
  if (state === 'error') return status?.status.message ?? 'error';
  return status?.status.message ?? 'idle';
}

function statusText(
  state: ConnectionState,
  status: RemoteHostStatusResponse | null,
  error?: string,
): string {
  if (error) return error;
  if (state === 'complete') return 'The command completed and the session was closed.';
  if (state === 'running') return 'Streaming stdout from the container.';
  if (state === 'connecting') return 'Starting the provider and opening the bridge.';
  return status?.status.message ?? 'Ready.';
}

function runButtonLabel(state: ConnectionState): string {
  if (state === 'loading') return 'Loading';
  if (state === 'connecting') return 'Starting';
  if (state === 'running') return 'Streaming';
  if (state === 'complete') return 'Run again';
  return 'Run container';
}

function stateLabel(state: ConnectionState): string {
  if (state === 'complete') return 'complete';
  if (state === 'running') return 'streaming';
  if (state === 'connected') return 'connected';
  if (state === 'connecting') return 'starting';
  if (state === 'loading') return 'loading';
  if (state === 'error') return 'error';
  return 'ready';
}

function stateTone(state: ConnectionState): string {
  if (state === 'complete' || state === 'connected') return 'good';
  if (state === 'connecting' || state === 'running') return 'warn';
  if (state === 'error') return 'bad';
  return 'neutral';
}

function exitCodeTone(exitCode: string): string {
  if (exitCode === '0') return 'good';
  if (exitCode === 'pending') return 'neutral';
  return 'bad';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
