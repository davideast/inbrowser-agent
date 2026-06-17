import path from 'node:path';
import { fileURLToPath } from 'node:url';
import node from '@astrojs/node';
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
  // Static by default; the /api/ask route opts into on-demand rendering
  // (export const prerender = false) and runs on the Node adapter.
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],

  markdown: {
    remarkPlugins: [[remarkRewriteLinks, { routeMap, repoRoot }]],
    rehypePlugins: [rehypeStripFirstH1, rehypeTuiFrames],
    shikiConfig: {
      theme: 'css-variables',
    },
  },

  vite: {
    // Allow the dev server to be reached through a Cloudflare quick tunnel
    // (otherwise Vite blocks the unknown *.trycloudflare.com Host header).
    server: {
      allowedHosts: ['.trycloudflare.com'],
    },
    // Cast: duplicate vite versions in the dep tree make @tailwindcss/vite's
    // Plugin type mismatch Astro's expected PluginOption. Runtime is fine.
    plugins: [tailwindcss() as never],
  },
});
