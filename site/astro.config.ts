import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { buildRouteMap } from './src/content/graph';
import { rehypeStripFirstH1 } from './src/lib/rehype-strip-first-h1';
import { rehypeTuiFrames } from './src/lib/rehype-tui-frames';
import { remarkRewriteLinks } from './src/lib/remark-rewrite-links';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(projectDir, '..');
const routeMap = buildRouteMap();

// https://astro.build/config
export default defineConfig({
  // Custom domain (served at the root via GitHub Pages). Drives canonical /
  // absolute URLs; `base` stays `/`, so no link rewrites are needed.
  site: 'https://inbrowser.io',

  // Fully static: the chat runs entirely in the browser (BYOK / on-device), so
  // there are no server routes and no adapter. Deep-links (/c/<id>) fall back to
  // the static 404 shell, which renders the same ChatApp.
  output: 'static',
  integrations: [react()],

  // One chat everywhere: the home is the chat, so /chat redirects to it.
  redirects: { '/chat': '/' },

  markdown: {
    remarkPlugins: [[remarkRewriteLinks, { routeMap, repoRoot }]],
    rehypePlugins: [rehypeStripFirstH1, rehypeTuiFrames],
    shikiConfig: {
      theme: 'css-variables',
    },
  },

  vite: {
    // Allow the dev server to be reached through a Cloudflare quick tunnel or a
    // Tailscale serve proxy (otherwise Vite blocks the unknown Host header).
    server: {
      allowedHosts: ['.trycloudflare.com', '.ts.net'],
    },
    // Cast: duplicate vite versions in the dep tree make @tailwindcss/vite's
    // Plugin type mismatch Astro's expected PluginOption. Runtime is fine.
    plugins: [tailwindcss() as never],
    // The on-device engine lazy-loads @huggingface/transformers (so the cloud
    // path never statically bundles ONNX/WASM). That dynamic import runs inside
    // the model worker, which then code-splits — unsupported by the default
    // `iife` worker format — so emit ES-module workers. The worker is already
    // spawned with `{ type: 'module' }`. (The Node-only providers in the root
    // barrel stay out of the browser build via their own lazy/non-literal
    // imports, so no `external` workaround is needed here.)
    worker: {
      format: 'es',
    },
  },
});
