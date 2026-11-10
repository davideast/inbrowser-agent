import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  HOST_BUNDLE_ALIAS,
  PROCESS_BUNDLE_ALIAS,
  createNodeInternalPlugin,
} from './node-internal-plugin.mjs';
import { writeNotices } from './notices.mjs';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = path.join(pkgRoot, 'dist');
const req = createRequire(import.meta.url);
const nodeInternalPlugin = createNodeInternalPlugin(pkgRoot);

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const sharedBundleOptions = {
  absWorkingDir: pkgRoot,
  metafile: true,
  inject: ['src/browser-globals.ts'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  define: { 'process.env.NODE_DEBUG': 'false', 'process.env.NODE_ENV': '"development"' },
};

const [hostResult, processResult] = await Promise.all([
  build({
    ...sharedBundleOptions,
    entryPoints: {
      runtime: 'src/index.ts',
      kernel: 'src/kernel.ts',
      'context-compiler-worker': 'src/context-compiler-worker.ts',
      sw: 'src/sw.ts',
      'service-worker': 'src/service-worker.ts',
    },
    alias: HOST_BUNDLE_ALIAS,
  }),
  build({
    ...sharedBundleOptions,
    entryPoints: {
      process: 'src/process.ts',
    },
    minifyWhitespace: true,
    legalComments: 'none',
    plugins: [nodeInternalPlugin],
    alias: PROCESS_BUNDLE_ALIAS,
  }),
]);

await copyFile(
  req.resolve('esbuild-wasm/esbuild.wasm'),
  path.join(distDir, 'context-esbuild.wasm'),
);
await copyFile(
  req.resolve('wasm-brotli/wasm_brotli_browser_bg.wasm'),
  path.join(distDir, 'zlib-brotli.wasm'),
);
await copyFile(
  req.resolve('node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm'),
  path.join(distDir, 'sqlite.wasm'),
);

const zstdJsBundle = await readFile(req.resolve('@oneidentity/zstd-js/wasm/index.js'), 'utf8');
const zstdDataUrlMatch = /data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/.exec(
  zstdJsBundle,
);
if (!zstdDataUrlMatch?.[1]) {
  throw new Error('Unable to extract Zstandard WebAssembly payload from @oneidentity/zstd-js');
}
await writeFile(path.join(distDir, 'zlib-zstd.wasm'), Buffer.from(zstdDataUrlMatch[1], 'base64'));

const preview = await build({
  absWorkingDir: pkgRoot,
  entryPoints: ['src/preview-socket.ts'],
  inject: ['src/browser-globals.ts'],
  outfile: 'dist/preview-socket.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  metafile: true,
  alias: { buffer: 'buffer/', stream: 'readable-stream/lib/stream.js', events: 'events/' },
  define: { 'process.env.NODE_DEBUG': 'false' },
});

// Per-origin preview: the files an embedder serves on every preview origin
// (docs/guide/README.md). The bridge script is inlined so the bridge stays one document.
await mkdir(path.join(distDir, 'preview-origin/__inbrowser__'), { recursive: true });
const originSocket = await build({
  absWorkingDir: pkgRoot,
  entryPoints: ['src/preview-origin-socket.ts'],
  inject: ['src/browser-globals.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  metafile: true,
  write: false,
  alias: { buffer: 'buffer/', stream: 'readable-stream/lib/stream.js', events: 'events/' },
  define: { 'process.env.NODE_DEBUG': 'false' },
});
const previewWorker = await build({
  absWorkingDir: pkgRoot,
  entryPoints: ['src/preview-origin-sw.ts'],
  inject: ['src/browser-globals.ts'],
  outfile: 'dist/preview-origin/__inbrowser_preview_sw.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  metafile: true,
  define: {
    'process.env.NODE_DEBUG': 'false',
    __PREVIEW_SOCKET_SOURCE__: JSON.stringify(originSocket.outputFiles[0].text),
  },
});
const bridge = await build({
  absWorkingDir: pkgRoot,
  entryPoints: ['src/preview-bridge-frame.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  metafile: true,
  write: false,
});
await writeFile(
  path.join(distDir, 'preview-origin/__inbrowser__/bridge.html'),
  `<!doctype html><meta charset="utf-8"><title>Preview bridge</title><script>${bridge.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>\n`,
);
await copyFile(
  path.join(pkgRoot, 'assets/preview-origin-unavailable.html'),
  path.join(distDir, 'preview-origin/__inbrowser__/unavailable.html'),
);

const noticeInputs = Object.fromEntries(
  Object.entries({
    ...hostResult.metafile.inputs,
    ...processResult.metafile.inputs,
    ...preview.metafile.inputs,
    ...originSocket.metafile.inputs,
    ...previewWorker.metafile.inputs,
    ...bridge.metafile.inputs,
  }).filter(([key]) => !key.startsWith('(disabled):')),
);
await writeNotices(noticeInputs, path.join(distDir, 'THIRD_PARTY_NOTICES.txt'));
await copyFile(path.join(pkgRoot, 'LICENSE'), path.join(distDir, 'LICENSE'));

await rm(path.join(distDir, 'types'), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [req.resolve('typescript/bin/tsc'), '-p', path.join(pkgRoot, 'tsconfig.build.json')],
  { cwd: pkgRoot, stdio: 'inherit' },
);
await rm(path.join(distDir, 'tsconfig.build.tsbuildinfo'), { force: true });
