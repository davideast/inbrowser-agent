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
  export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    env?: Record<string, string>;
    stdoutKind?: 'text' | 'bytes';
    stdoutEncoding?: 'binary';
  }
  export interface CommandContext {
    cwd: string;
    env: Record<string, string>;
    stdin: string;
  }
  export interface Command {
    name: string;
  }
  export function defineCommand(
    name: string,
    execute: (args: string[], ctx: CommandContext) => Promise<ExecResult>,
  ): Command;
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
