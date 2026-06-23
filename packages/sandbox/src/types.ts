export type JsonSchema = Record<string, unknown>;

export interface SandboxStats {
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface SandboxDirent {
  name: string;
  path: string;
  type: 'file' | 'directory';
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface SandboxFileSystemPromises {
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<SandboxDirent[]>;
  stat(path: string): Promise<SandboxStats>;
  lstat(path: string): Promise<SandboxStats>;
  unlink(path: string): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface SandboxSnapshotEntry {
  path: string;
  type: 'file' | 'directory';
  content?: string;
}

export interface SandboxSnapshot {
  root: string;
  entries: SandboxSnapshotEntry[];
  createdAt: number;
}

export interface SandboxFileEvent {
  type: 'write' | 'delete' | 'rename' | 'mkdir';
  path: string;
  targetPath?: string;
  timestamp: number;
}

export interface SandboxFileSystem {
  readonly root: string;
  readonly promises: SandboxFileSystemPromises;
  watch?(callback: (event: SandboxFileEvent) => void): () => void;
  snapshot(root?: string): Promise<SandboxSnapshot>;
  restore(snapshot: SandboxSnapshot, options?: { clearRoot?: boolean }): Promise<void>;
}

export interface SandboxRunOptions {
  cwd?: string;
  signal?: AbortSignal;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  durationMs?: number;
}

export interface SandboxRuntime {
  run(command: string, options?: SandboxRunOptions): Promise<SandboxRunResult>;
}

export interface RuntimeCapabilities {
  readonly fs: boolean;
  readonly shell: boolean;
  readonly git: boolean;
  readonly preview: boolean;
  readonly packages: boolean;
  readonly persistentStorage: boolean;
  readonly syncFs: boolean;
}

export type SandboxEvent =
  | { type: 'file'; sandboxId: string; event: SandboxFileEvent; timestamp: number }
  | { type: 'run:start'; sandboxId: string; command: string; cwd: string; timestamp: number }
  | {
      type: 'run:finish';
      sandboxId: string;
      command: string;
      result: SandboxRunResult;
      timestamp: number;
    }
  | { type: 'tool:start'; sandboxId: string; name: string; args: unknown; timestamp: number }
  | {
      type: 'tool:finish';
      sandboxId: string;
      name: string;
      result: SandboxToolResult;
      timestamp: number;
    }
  | { type: 'checkpoint'; sandboxId: string; checkpoint: SandboxCheckpoint; timestamp: number }
  | { type: 'error'; sandboxId: string; message: string; cause?: unknown; timestamp: number }
  | { type: 'destroyed'; sandboxId: string; timestamp: number };

type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'sandboxId' | 'timestamp'> : never;

export type SandboxEventInput = WithoutEnvelope<SandboxEvent> & { timestamp?: number };

export interface SandboxGitService {
  init(): Promise<void>;
  currentBranch(): Promise<string | null>;
  status(): Promise<unknown[]>;
  stageAll(): Promise<void>;
  commit(options: { message: string; authorName: string; authorEmail: string }): Promise<string>;
  log(options?: { depth?: number }): Promise<unknown[]>;
}

export interface SandboxPreviewService {
  compile(source?: string): Promise<unknown>;
}

export interface SandboxPackageService {
  install(spec: { name: string; version?: string }): Promise<unknown>;
  importMap?(): Promise<Record<string, string>>;
}

export interface SandboxServices {
  git?: SandboxGitService;
  preview?: SandboxPreviewService;
  packages?: SandboxPackageService;
}

export interface Sandbox {
  readonly id: string;
  readonly cwd: string;
  readonly fs: SandboxFileSystem;
  readonly runtime: SandboxRuntime;
  readonly capabilities: RuntimeCapabilities;
  readonly services: SandboxServices;
  on(callback: (event: SandboxEvent) => void): () => void;
  emit(event: SandboxEventInput): void;
  destroy(): void;
}

export interface CreateSandboxOptions {
  id?: string;
  cwd?: string;
  fs: SandboxFileSystem;
  runtime: SandboxRuntime;
  capabilities?: Partial<RuntimeCapabilities>;
  services?: SandboxServices;
}

export interface SandboxToolResult<D = unknown> {
  ok: boolean;
  summary: string;
  data?: D;
}

export interface SandboxTool<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  pure?: boolean;
  execute(args: A, ctx: { sandbox: Sandbox; signal: AbortSignal }): Promise<SandboxToolResult<D>>;
}

export interface SandboxToolset {
  readonly tools: readonly SandboxTool[];
  get(name: string): SandboxTool | undefined;
  run(
    name: string,
    args: unknown,
    sandbox: Sandbox,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxToolResult>;
}

export interface SandboxCheckpoint {
  id: string;
  label?: string;
  snapshot: SandboxSnapshot;
  createdAt: number;
}

export interface CheckpointManager {
  create(label?: string): Promise<SandboxCheckpoint>;
  restore(id: string): Promise<void>;
  list(): SandboxCheckpoint[];
  get(id: string): SandboxCheckpoint | undefined;
}
