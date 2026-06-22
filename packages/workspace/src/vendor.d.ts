declare module 'esbuild-wasm' {
  export type Loader = 'js' | 'jsx' | 'ts' | 'tsx' | 'json' | 'css' | 'text';
  export type JSX = 'transform' | 'preserve' | 'automatic';
  export interface OnResolveArgs {
    path: string;
    importer: string;
  }
  export interface OnLoadArgs {
    path: string;
  }
  export interface PluginBuild {
    onResolve(options: { filter: RegExp }, callback: (args: OnResolveArgs) => unknown): void;
    onLoad(
      options: { filter: RegExp; namespace?: string },
      callback: (args: OnLoadArgs) => unknown,
    ): void;
  }
  export interface Plugin {
    name: string;
    setup(build: PluginBuild): void;
  }
  export interface BuildOptions {
    entryPoints: string[];
    bundle?: boolean;
    write?: boolean;
    format?: 'iife' | 'esm' | 'cjs';
    globalName?: string;
    jsx?: JSX;
    jsxImportSource?: string;
    logLevel?: 'silent' | 'info' | 'warning' | 'error';
    plugins?: Plugin[];
    banner?: { js?: string };
  }
  export interface BuildResult {
    outputFiles?: Array<{ text: string }>;
  }
  export function initialize(options: { wasmURL?: string; worker?: boolean }): Promise<void>;
  export function build(options: BuildOptions): Promise<BuildResult>;
}

declare module 'just-bash' {
  export type FileContent = string | Uint8Array;
  export type BufferEncoding = string;
  export interface FsStat {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtime: Date;
    ctime: Date;
    mode: number;
  }
  export interface MkdirOptions {
    recursive?: boolean;
  }
  export interface RmOptions {
    recursive?: boolean;
    force?: boolean;
  }
  export interface CpOptions {
    recursive?: boolean;
  }
  export interface IFileSystem {}
  export class InMemoryFs implements IFileSystem {}
  export class MountableFs implements IFileSystem {
    constructor(options: {
      base: IFileSystem;
      mounts: Array<{ mountPoint: string; filesystem: IFileSystem }>;
    });
  }
  export class Bash {
    constructor(options: { fs: IFileSystem; cwd?: string });
    exec(
      command: string,
      options?: { cwd?: string; signal?: AbortSignal },
    ): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      env?: { PWD?: string };
    }>;
    registerCommand(command: unknown): void;
  }
}

declare module 'isomorphic-git' {
  export interface CommitObject {
    message: string;
    author: {
      name: string;
      email: string;
      timestamp: number;
    };
  }
  export interface LogEntry {
    oid: string;
    commit: CommitObject;
  }
  export function init(options: {
    fs: unknown;
    dir: string;
    defaultBranch?: string;
  }): Promise<void>;
  export function currentBranch(options: { fs: unknown; dir: string; fullname?: boolean }): Promise<
    string | null
  >;
  export function statusMatrix(options: { fs: unknown; dir: string }): Promise<
    Array<[string, number, number, number]>
  >;
  export function remove(options: { fs: unknown; dir: string; filepath: string }): Promise<void>;
  export function add(options: { fs: unknown; dir: string; filepath: string }): Promise<void>;
  export function commit(options: {
    fs: unknown;
    dir: string;
    message: string;
    author: { name: string; email: string };
  }): Promise<string>;
  export function branch(options: {
    fs: unknown;
    dir: string;
    ref: string;
    checkout?: boolean;
  }): Promise<void>;
  export function checkout(options: {
    fs: unknown;
    dir: string;
    ref: string;
    checkout?: boolean;
    force?: boolean;
    noCheckout?: boolean;
  }): Promise<void>;
  export function log(options: { fs: unknown; dir: string; depth?: number }): Promise<LogEntry[]>;
  export function listFiles(options: { fs: unknown; dir: string; ref?: string }): Promise<string[]>;
}
