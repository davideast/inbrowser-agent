import type {
  RuntimeCapabilities,
  SandboxArtifact,
  SandboxCheckpoint,
  SandboxCheckpointRestoreOptions,
  SandboxDirent,
  SandboxEventInput,
  SandboxExposedPort,
  SandboxFileEvent,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxSnapshot,
  SandboxStats,
  SandboxTool,
} from '../types.js';

export type BridgePeerRole = 'browser' | 'host';
export type BridgeEnvelopeKind = 'request' | 'response' | 'event' | 'ack' | 'error';

export interface BridgeEnvelope<T = unknown> {
  id: string;
  sessionId: string;
  kind: BridgeEnvelopeKind;
  type: string;
  sentAt: number;
  seq?: number;
  replyTo?: string;
  peer?: BridgePeerRole;
  payload: T;
}

export type BridgeAuth =
  | { type: 'bearer'; token: string }
  | { type: 'session'; token: string }
  | { type: 'custom'; value: unknown };

export interface BridgeConnectOptions {
  sessionId: string;
  role: BridgePeerRole;
  auth?: BridgeAuth;
  resumeFromSeq?: number;
  signal?: AbortSignal;
}

export interface BridgeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BridgeConnection {
  readonly sessionId: string;
  readonly role: BridgePeerRole;
  send(envelope: BridgeEnvelope): Promise<void>;
  request<TResponse = unknown>(
    envelope: Omit<BridgeEnvelope, 'kind' | 'sentAt'> & {
      kind?: 'request';
      sentAt?: number;
    },
    options?: BridgeRequestOptions,
  ): Promise<BridgeEnvelope<TResponse>>;
  subscribe(callback: (envelope: BridgeEnvelope) => void): () => void;
  close(reason?: string): Promise<void>;
}

export interface BridgeTransportProvider {
  readonly kind: string;
  connect(options: BridgeConnectOptions): Promise<BridgeConnection>;
}

export interface RemoteSandboxOptions {
  id: string;
  root?: string;
  transport: BridgeTransportProvider;
  auth?: BridgeAuth;
  resumeFromSeq?: number;
  capabilities?: Partial<RuntimeCapabilities>;
  tools?: readonly SandboxTool[];
  requestTimeoutMs?: number;
}

export interface RemoteSessionCreateRequest {
  root: string;
  capabilities?: Partial<RuntimeCapabilities>;
}

export interface RemoteSessionCreateResponse {
  root: string;
  capabilities?: Partial<RuntimeCapabilities>;
}

export interface RemoteFsReadRequest {
  path: string;
  encoding?: 'utf8';
}

export interface RemoteFsReadResponse {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface RemoteFsWriteRequest {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface RemoteFsListRequest {
  path: string;
  withFileTypes?: boolean;
}

export interface RemoteFsListResponse {
  entries: string[] | SandboxDirent[];
}

export interface RemoteFsStatRequest {
  path: string;
}

export interface RemoteFsStatResponse extends Omit<SandboxStats, 'isFile' | 'isDirectory'> {}

export interface RemoteFsDeleteRequest {
  path: string;
  recursive?: boolean;
}

export interface RemoteFsRenameRequest {
  from: string;
  to: string;
}

export interface RemoteFsSnapshotRequest {
  root?: string;
}

export interface RemoteFsSnapshotResponse {
  snapshot: SandboxSnapshot;
}

export interface RemoteFsRestoreRequest {
  snapshot: SandboxSnapshot;
  clearRoot?: boolean;
}

export interface RemoteRunRequest {
  command: string;
  options?: Omit<SandboxRunOptions, 'signal'>;
}

export interface RemoteRunResponse extends SandboxRunResult {}

export interface RemoteRunOutputArtifact extends SandboxArtifact {
  kind: 'run.output';
  requestId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface RemoteCheckpointCreateRequest {
  input?: string | Record<string, unknown>;
}

export interface RemoteCheckpointCreateResponse {
  checkpoint: SandboxCheckpoint;
}

export interface RemoteCheckpointRestoreRequest {
  id: string;
  options?: SandboxCheckpointRestoreOptions;
}

export interface RemotePortExposeRequest {
  port: number;
  host?: string;
}

export interface RemotePortExposeResponse extends SandboxExposedPort {}

export type RemoteHostStatusState = 'idle' | 'starting' | 'ready' | 'error';

export interface RemoteHostDiagnostic {
  providerKind: string;
  state: RemoteHostStatusState;
  runtimeAvailable: boolean;
  systemReady: boolean;
  image?: string;
  imagePresent?: boolean;
  message?: string;
  checkedAt: number;
  details?: Record<string, unknown>;
}

export interface RemoteHostStatusRequest {
  includeDiagnostics?: boolean;
}

export interface RemoteHostStatusResponse {
  provider: string;
  status: RemoteHostDiagnostic;
  authenticated: boolean;
}

export type RemoteBridgeEvent =
  | { type: 'sandbox'; event: SandboxEventInput }
  | { type: 'file'; event: SandboxFileEvent }
  | { type: 'artifact'; artifact: SandboxArtifact }
  | { type: 'port'; port: RemotePortExposeResponse };

export const REMOTE_PROTOCOL_TYPES = {
  sessionCreate: 'session.create',
  hostStatus: 'host.status',
  fsRead: 'fs.read',
  fsWrite: 'fs.write',
  fsMkdir: 'fs.mkdir',
  fsList: 'fs.list',
  fsStat: 'fs.stat',
  fsLstat: 'fs.lstat',
  fsDelete: 'fs.delete',
  fsRename: 'fs.rename',
  fsSnapshot: 'fs.snapshot',
  fsRestore: 'fs.restore',
  runStart: 'run.start',
  runCancel: 'run.cancel',
  stdinWrite: 'stdin.write',
  checkpointCreate: 'checkpoint.create',
  checkpointRestore: 'checkpoint.restore',
  portExpose: 'port.expose',
  portClose: 'port.close',
  event: 'event',
  artifact: 'artifact',
} as const;
