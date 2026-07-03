import type {
  SandboxDirent,
  SandboxFileEvent,
  SandboxSnapshot,
  SandboxStats,
} from '@inbrowser/sandbox';
import type {
  RemoteHostDiagnostic,
  RemotePortExposeResponse,
  RemoteRunResponse,
} from '@inbrowser/sandbox/remote';

export type ContainerHostDiagnostic = RemoteHostDiagnostic;

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
