import type { Plugin } from 'esbuild-wasm';

export function cdnImportPlugin(importMap: Record<string, string>): Plugin {
  const names = new Set(Object.keys(importMap));
  return {
    name: 'inbrowser-cdn-imports',
    setup(build) {
      build.onResolve({ filter: /^[^.]/ }, (args) => {
        if (!names.has(args.path)) return null;
        return { path: args.path, external: true };
      });
    },
  };
}
