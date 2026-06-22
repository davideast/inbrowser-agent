import type { Loader, Plugin } from 'esbuild-wasm';
import type { WorkspaceFileSystem } from '../fs/index.js';
import { dirname, joinPath, normalizePath } from '../fs/index.js';

const LOADERS: Record<string, Loader> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.css': 'css',
};

export function vfsLoadPlugin(fs: WorkspaceFileSystem): Plugin {
  return {
    name: 'inbrowser-vfs-load',
    setup(build) {
      build.onResolve({ filter: /^(\.\/|\.\.\/|\/)/ }, async (args) => {
        const base = args.path.startsWith('/')
          ? args.path
          : joinPath(dirname(args.importer || '/'), args.path);
        const resolved = await resolveFile(fs, base);
        return resolved ? { path: resolved, namespace: 'inbrowser-vfs' } : null;
      });
      build.onLoad({ filter: /.*/, namespace: 'inbrowser-vfs' }, async (args) => {
        const contents = await fs.promises.readFile(args.path, 'utf8');
        return { contents, loader: loaderFor(args.path) };
      });
    },
  };
}

async function resolveFile(fs: WorkspaceFileSystem, path: string): Promise<string | null> {
  const normalized = normalizePath(path);
  const candidates = [
    normalized,
    `${normalized}.tsx`,
    `${normalized}.ts`,
    `${normalized}.jsx`,
    `${normalized}.js`,
    `${normalized}.json`,
    joinPath(normalized, 'index.tsx'),
    joinPath(normalized, 'index.ts'),
    joinPath(normalized, 'index.jsx'),
    joinPath(normalized, 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Keep searching candidates.
    }
  }
  return null;
}

function loaderFor(path: string): Loader {
  const match = path.match(/\.[^.]+$/);
  return (match ? LOADERS[match[0]] : undefined) ?? 'text';
}
