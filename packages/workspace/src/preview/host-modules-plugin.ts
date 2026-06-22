import type { Plugin } from 'esbuild-wasm';
import type { PreviewHostModule } from './types.js';

export function hostModulesPlugin(
  modules: Record<string, PreviewHostModule>,
  previewGlobalName: string,
): Plugin {
  const names = new Set(Object.keys(modules));
  return {
    name: 'inbrowser-host-modules',
    setup(build) {
      build.onResolve({ filter: /^[^.]/ }, (args) => {
        if (!names.has(args.path)) return null;
        return { path: args.path, namespace: 'inbrowser-host-module' };
      });
      build.onLoad({ filter: /.*/, namespace: 'inbrowser-host-module' }, (args) => {
        const module = modules[args.path];
        if (!module) return null;
        return {
          loader: 'js',
          contents: synthesizeHostModule(args.path, module.exports, previewGlobalName),
        };
      });
    },
  };
}

function synthesizeHostModule(
  specifier: string,
  exports: readonly string[],
  previewGlobalName: string,
): string {
  const head = `const __m = globalThis[${JSON.stringify(previewGlobalName)}]?.[${JSON.stringify(specifier)}];`;
  const guard = `if (!__m) throw new Error("preview scope missing module: ${specifier}");`;
  const named = exports
    .filter((name) => name !== 'default')
    .map((name) => `export const ${name} = __m[${JSON.stringify(name)}];`);
  const defaultLine = exports.includes('default') ? 'export default __m.default ?? __m;' : '';
  return [head, guard, ...named, defaultLine].filter(Boolean).join('\n');
}
