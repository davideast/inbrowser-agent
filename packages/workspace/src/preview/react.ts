import type { WorkspaceFileSystem } from '../fs/index.js';
import { compileWorkspaceEntry } from './compile.js';
import type { PreviewCompileResult, PreviewHostModule, PreviewModuleScope } from './types.js';

export interface ReactPreviewRuntimeOptions {
  fs: WorkspaceFileSystem;
  entry: string;
  react: Record<string, unknown>;
  jsxRuntime: Record<string, unknown>;
  jsxDevRuntime?: Record<string, unknown>;
  extraHostModules?: Record<string, PreviewHostModule>;
  importMap?: Record<string, string>;
  esbuildOptions?: {
    wasmURL?: string;
    worker?: boolean;
  };
}

export interface ReactPreviewRuntime {
  compile(source?: string): Promise<PreviewCompileResult>;
  scope(extra?: PreviewModuleScope): PreviewModuleScope;
}

const REACT_EXPORTS = [
  'default',
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'useRef',
  'useReducer',
  'useContext',
  'createContext',
  'Fragment',
  'StrictMode',
  'Children',
  'cloneElement',
  'createElement',
  'isValidElement',
  'memo',
  'forwardRef',
] as const;

export function createReactPreviewRuntime(
  options: ReactPreviewRuntimeOptions,
): ReactPreviewRuntime {
  const hostModules: Record<string, PreviewHostModule> = {
    react: { module: options.react, exports: REACT_EXPORTS },
    'react/jsx-runtime': { module: options.jsxRuntime, exports: ['jsx', 'jsxs', 'Fragment'] },
    'react/jsx-dev-runtime': {
      module: options.jsxDevRuntime ?? options.jsxRuntime,
      exports: ['jsxDEV', 'Fragment'],
    },
    ...(options.extraHostModules ?? {}),
  };
  return {
    compile(source) {
      return compileWorkspaceEntry({
        fs: options.fs,
        entry: options.entry,
        source,
        hostModules,
        importMap: options.importMap,
        esbuildOptions: options.esbuildOptions,
      });
    },
    scope(extra = {}) {
      const base = Object.fromEntries(
        Object.entries(hostModules).map(([specifier, module]) => [specifier, module.module]),
      );
      return { ...base, ...extra };
    },
  };
}
