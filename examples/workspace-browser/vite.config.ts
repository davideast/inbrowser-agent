import { createReadStream, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

const workspaceEntry = fileURLToPath(import.meta.resolve('@inbrowser/workspace'));
const workspaceRoot = resolve(dirname(workspaceEntry), '..');
const workspaceSourceEntry = fileURLToPath(
  new URL('../../packages/workspace/src/index.ts', import.meta.url),
);
const esbuildWasmPath = join(workspaceRoot, 'node_modules/esbuild-wasm/esbuild.wasm');

function esbuildWasmAsset(): Plugin {
  return {
    name: 'workspace-browser-esbuild-wasm',
    configureServer(server) {
      server.middlewares.use('/esbuild.wasm', (_request, response) => {
        response.setHeader('content-type', 'application/wasm');
        createReadStream(esbuildWasmPath).pipe(response);
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'esbuild.wasm',
        source: readFileSync(esbuildWasmPath),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), esbuildWasmAsset()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['davids-macbook-pro-2.tail8926aa.ts.net'],
  },
  resolve: {
    alias: [
      {
        find: /^@inbrowser\/workspace$/,
        replacement: workspaceSourceEntry,
      },
      {
        find: 'node:zlib',
        replacement: fileURLToPath(new URL('./src/node-zlib-shim.ts', import.meta.url)),
      },
    ],
  },
  optimizeDeps: {
    exclude: ['@inbrowser/workspace', '@inbrowser/example-shared'],
  },
});
