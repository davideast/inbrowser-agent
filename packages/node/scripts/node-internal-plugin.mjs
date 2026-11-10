import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPkgRoot = fileURLToPath(new URL('..', import.meta.url));

export const HOST_BUNDLE_ALIAS = {
  buffer: 'buffer/',
  stream: 'readable-stream/lib/stream.js',
  events: 'events/',
  path: 'path-browserify',
  assert: 'assert/',
};

export const PROCESS_BUNDLE_ALIAS = {
  buffer: 'buffer/',
  stream: 'readable-stream/lib/stream.js',
  path: 'path-browserify',
  assert: 'assert/',
};

export function createNodeInternalPlugin(projectRoot = defaultPkgRoot) {
  const upstreamNodeLibRoot = path.resolve(projectRoot, 'vendor/node-v22.18.0/lib');
  const nodeInternalRoot = path.resolve(projectRoot, 'src/node-internal');

  return {
    name: 'node-internal-nodelib',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^internal\// }, (args) => {
        if (args.path === 'internal/bootstrap/node-bridge') {
          return { path: path.join(nodeInternalRoot, 'node-bridge.ts') };
        }
        if (args.path.startsWith('internal/nodelib/')) {
          const subpath = args.path.slice('internal/nodelib/'.length);
          const direct = path.join(upstreamNodeLibRoot, `${subpath}.js`);
          if (existsSync(direct)) return { path: direct };
          return { path: path.join(upstreamNodeLibRoot, 'internal', `${subpath}.js`) };
        }
        const subpath = args.path.slice('internal/'.length);
        const localShim = path.join(nodeInternalRoot, `${subpath}.ts`);
        if (existsSync(localShim)) {
          return { path: localShim };
        }
        const upstreamInternal = path.join(upstreamNodeLibRoot, 'internal', `${subpath}.js`);
        if (existsSync(upstreamInternal)) {
          return { path: upstreamInternal };
        }
        return undefined;
      });

      pluginBuild.onResolve(
        { filter: /^(assert|buffer|async_hooks|string_decoder|timers|readline\/promises)$/ },
        (args) => {
          const normalizedImporter = args.importer.replaceAll('\\', '/');
          const normalizedUpstream = upstreamNodeLibRoot.replaceAll('\\', '/');
          if (!normalizedImporter.startsWith(`${normalizedUpstream}/`)) {
            return undefined;
          }
          if (args.path === 'assert') {
            return { path: path.join(upstreamNodeLibRoot, 'assert.js') };
          }
          if (args.path === 'buffer') {
            return { path: path.join(nodeInternalRoot, 'buffer.ts') };
          }
          if (args.path === 'async_hooks') {
            return { path: path.join(nodeInternalRoot, 'async_hooks.ts') };
          }
          if (args.path === 'string_decoder') {
            return { path: path.join(upstreamNodeLibRoot, 'string_decoder.js') };
          }
          if (args.path === 'timers') {
            return { path: path.join(nodeInternalRoot, 'timers.ts') };
          }
          if (args.path === 'readline/promises') {
            return { path: path.join(upstreamNodeLibRoot, 'readline', 'promises.js') };
          }
          return undefined;
        },
      );

      pluginBuild.onResolve({ filter: /^events$/ }, (args) => {
        if (args.namespace === 'node-events-cjs') return undefined;
        return { path: 'events', namespace: 'node-events-cjs' };
      });

      pluginBuild.onLoad({ filter: /^events$/, namespace: 'node-events-cjs' }, () => ({
        contents: "module.exports = require('internal/events-entry').EventEmitter;",
        loader: 'js',
        resolveDir: nodeInternalRoot,
      }));

      pluginBuild.onLoad(
        { filter: /vendor[\\/]node-v22\.18\.0[\\/]lib[\\/].*\.js$/ },
        async (args) => {
          const raw = await readFile(args.path, 'utf8');
          const contents = raw.replace(
            /^((?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*'use strict';)/,
            "$1 const { primordials, internalBinding, process } = require('internal/bootstrap/node-bridge');",
          );
          return { contents, loader: 'js' };
        },
      );
    },
  };
}
