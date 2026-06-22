import type { Plugin } from 'esbuild-wasm';
import { cdnImportPlugin } from './cdn-plugin.js';
import { getEsbuild } from './esbuild.js';
import { hostModulesPlugin } from './host-modules-plugin.js';
import type {
  CompileWorkspaceEntryOptions,
  PreviewCompileResult,
  PreviewModuleScope,
} from './types.js';
import { vfsLoadPlugin } from './vfs-plugin.js';

const DEFAULT_GLOBAL_NAME = '__inbrowserCompiledPreview__';
const DEFAULT_PREVIEW_GLOBAL = '__inbrowserPreviewScope__';
const REQUIRE_GLOBAL = '__inbrowserPreviewRequire__';

export async function compileWorkspaceEntry(
  options: CompileWorkspaceEntryOptions,
): Promise<PreviewCompileResult> {
  const globalName = options.globalName ?? DEFAULT_GLOBAL_NAME;
  const previewGlobalName = options.previewGlobalName ?? DEFAULT_PREVIEW_GLOBAL;
  const importMap = options.importMap ?? {};
  const hostModules = options.hostModules ?? {};

  let esbuild: Awaited<ReturnType<typeof getEsbuild>>;
  try {
    esbuild = await getEsbuild(options.esbuildOptions);
  } catch (err) {
    return failure(`esbuild-wasm init failed: ${messageFor(err)}`);
  }

  const entryPlugin: Plugin | null =
    options.source === undefined
      ? null
      : {
          name: 'inbrowser-entry-source',
          setup(build) {
            build.onResolve({ filter: /^inbrowser-entry$/ }, () => ({
              path: options.entry,
              namespace: 'inbrowser-entry',
            }));
            build.onLoad({ filter: /.*/, namespace: 'inbrowser-entry' }, () => ({
              contents: options.source,
              loader: 'tsx',
            }));
          },
        };

  const hasCdnImports = Object.keys(importMap).length > 0;
  try {
    const result = await esbuild.build({
      entryPoints: [entryPlugin ? 'inbrowser-entry' : options.entry],
      bundle: true,
      write: false,
      format: 'iife',
      globalName,
      jsx: options.jsx ?? 'automatic',
      jsxImportSource: options.jsxImportSource ?? 'react',
      logLevel: 'silent',
      plugins: [
        ...(entryPlugin ? [entryPlugin] : []),
        hostModulesPlugin(hostModules, previewGlobalName),
        cdnImportPlugin(importMap),
        vfsLoadPlugin(options.fs),
      ],
      ...(hasCdnImports
        ? { banner: { js: `const require = globalThis[${JSON.stringify(REQUIRE_GLOBAL)}];` } }
        : {}),
    });
    const code = result.outputFiles?.[0]?.text;
    if (!code) return failure('esbuild produced no output');
    const cdnModules = hasCdnImports
      ? await preloadCdnModules(importMap)
      : new Map<string, unknown>();
    return {
      ok: true,
      code,
      evaluate(scope: PreviewModuleScope) {
        const globalRecord = globalThis as Record<string, unknown>;
        globalRecord[previewGlobalName] = scope;
        if (hasCdnImports) {
          globalRecord[REQUIRE_GLOBAL] = (name: string) => {
            const mod = cdnModules.get(name);
            if (!mod) throw new Error(`Installed package '${name}' was not loaded.`);
            return mod;
          };
        }
        delete globalRecord[globalName];
        // biome-ignore lint/security/noGlobalEval: Evaluates the esbuild output for the user-owned preview workspace.
        (globalThis.eval as (src: string) => unknown)(code);
        return (globalRecord[globalName] as { default?: unknown } | undefined)?.default ?? null;
      },
    };
  } catch (err) {
    return { ok: false, diagnostics: diagnosticsFor(err) };
  }
}

async function preloadCdnModules(importMap: Record<string, string>): Promise<Map<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(importMap).map(
      async ([name, url]) => [name, await import(/* @vite-ignore */ url)] as const,
    ),
  );
  return new Map(entries);
}

function failure(message: string): PreviewCompileResult {
  return { ok: false, diagnostics: [{ message }] };
}

function diagnosticsFor(err: unknown) {
  if (typeof err === 'object' && err && 'errors' in err) {
    const errors = (
      err as { errors?: Array<{ text?: string; location?: { line?: number; column?: number } }> }
    ).errors;
    if (errors?.length) {
      return errors.map((error) => ({
        message: error.text ?? 'Build failed',
        line: error.location?.line,
        column: error.location?.column,
      }));
    }
  }
  return [{ message: messageFor(err) }];
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
