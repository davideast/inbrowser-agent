import type {
  SandboxDirent,
  SandboxFileEvent,
  SandboxSnapshot,
  SandboxStats,
} from '../../types.js';
import type {
  BridgeTransportProvider,
  RemoteHostDiagnostic,
  RemoteHostStatusResponse,
  RemotePortExposeResponse,
  RemoteRunResponse,
} from '../types.js';

export type ContainerHostDiagnostic = RemoteHostDiagnostic;

export interface BridgeHostServerOptions {
  provider: ContainerSandboxProvider;
  port?: number;
  hostname?: string;
  token?: string;
  root?: string;
  uiUrl?: string;
  allowedOrigins?: readonly string[];
  cleanupStaleSessions?: boolean;
}

export interface BridgeHostServer {
  readonly host: string;
  readonly port: number;
  readonly bridgeToken: string;
  readonly bridgeOrigin: string;
  readonly bridgeUrl: string;
  readonly statusUrl: string;
  closeSessions(): Promise<void>;
  hostStatus(): Promise<RemoteHostStatusResponse>;
  stop(): Promise<void>;
}

export interface HostCommandRunner {
  run(args: readonly string[], options?: HostCommandRunOptions): Promise<HostCommandResult>;
}

export interface HostCommandRunOptions {
  signal?: AbortSignal;
  onOutput?: (output: ContainerProcessOutput) => void;
  rejectOnFailure?: boolean;
  maxBufferedOutputChars?: number;
}

export interface HostCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface DetectionResult {
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ProviderDetectionContext {
  image: string;
  containerBin?: string;
  commandRunner?: HostCommandRunner;
}

export interface ResolvedContainerProviderOptions {
  image: string;
  containerBin?: string;
  namePrefix: string;
  maxBufferedOutputChars?: number;
  commandRunner?: HostCommandRunner;
}

export interface ContainerProviderFactory {
  readonly kind: string;
  readonly priority: number;
  detect(context: ProviderDetectionContext): Promise<DetectionResult>;
  create(options: ResolvedContainerProviderOptions): ContainerSandboxProvider;
}

export interface BridgeHostAdapter {
  readonly kind: string;
  start(options: BridgeHostServerOptions): Promise<BridgeHostServer>;
}

export interface BridgeHostAdapterFactory {
  readonly kind: 'node' | 'bun' | string;
  readonly priority: number;
  detect(): Promise<DetectionResult>;
  create(): BridgeHostAdapter;
}

export interface StartRemoteContainerBridgeOptions {
  image: string;
  provider?: 'auto' | string | ContainerSandboxProvider;
  host?: 'auto' | 'node' | 'bun' | BridgeHostAdapter;
  port?: number;
  hostname?: string;
  uiUrl?: string;
  allowedOrigins?: readonly string[];
  token?: string;
  root?: string;
  namePrefix?: string;
  containerBin?: string;
  maxBufferedOutputChars?: number;
  cleanupStaleSessions?: boolean;
  commandRunner?: HostCommandRunner;
  providers?: readonly ContainerProviderFactory[];
  hosts?: readonly BridgeHostAdapterFactory[];
}

export interface RemoteContainerBridgeClientConfig {
  provider: string;
  host: string;
  bridgeUrl: string;
  statusUrl: string;
  token: string;
  root: string;
}

export interface RemoteContainerBridge {
  readonly provider: string;
  readonly host: string;
  readonly origin: string;
  readonly bridgeUrl: string;
  readonly statusUrl: string;
  readonly token: string;
  readonly root: string;
  clientConfig(): RemoteContainerBridgeClientConfig;
  createWebSocketProvider(): BridgeTransportProvider;
  status(): Promise<RemoteHostStatusResponse>;
  closeSessions(): Promise<void>;
  stop(): Promise<void>;
}

export interface ContainerExposedPort extends RemotePortExposeResponse {
  targetUrl?: string;
}

export interface ContainerSandboxProvider {
  readonly kind: string;
  ensureReady(): Promise<void>;
  diagnose?(): Promise<ContainerHostDiagnostic>;
  cleanupStaleSessions?(): Promise<void>;
  createSession(options: ContainerSessionOptions): Promise<ContainerSession>;
}

export interface ContainerSessionOptions {
  id: string;
  root: string;
}

export interface ContainerSession {
  readonly id: string;
  readonly root: string;
  run(command: string, options?: ContainerRunOptions): Promise<RemoteRunResponse>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | SandboxDirent[]>;
  stat(path: string): Promise<SandboxStats>;
  lstat(path: string): Promise<SandboxStats>;
  unlink(path: string): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  snapshot(root?: string): Promise<SandboxSnapshot>;
  restore(snapshot: SandboxSnapshot, options?: { clearRoot?: boolean }): Promise<void>;
  watch(callback: (event: SandboxFileEvent) => void): () => void;
  exposePort(port: number, options?: { host?: string }): Promise<ContainerExposedPort>;
  dispose(): Promise<void>;
}

export interface ContainerProcessOutput {
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface ContainerRunOptions {
  cwd?: string;
  signal?: AbortSignal;
  onOutput?: (output: ContainerProcessOutput) => void;
}
