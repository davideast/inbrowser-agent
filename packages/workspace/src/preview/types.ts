import type * as esbuild from 'esbuild-wasm';
import type { WorkspaceFileSystem } from '../fs/index.js';

export interface PreviewDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

export interface PreviewCompileFailure {
  ok: false;
  diagnostics: PreviewDiagnostic[];
}

export interface PreviewCompileSuccess {
  ok: true;
  code: string;
  evaluate(scope: PreviewModuleScope): unknown;
}

export type PreviewCompileResult = PreviewCompileSuccess | PreviewCompileFailure;

export type PreviewModuleScope = Record<string, Record<string, unknown>>;

export interface PreviewHostModule {
  exports: readonly string[];
  module: Record<string, unknown>;
}

export interface CompileWorkspaceEntryOptions {
  fs: WorkspaceFileSystem;
  entry: string;
  source?: string;
  hostModules?: Record<string, PreviewHostModule>;
  importMap?: Record<string, string>;
  globalName?: string;
  previewGlobalName?: string;
  jsx?: esbuild.JSX;
  jsxImportSource?: string;
  esbuildOptions?: {
    wasmURL?: string;
    worker?: boolean;
  };
}
