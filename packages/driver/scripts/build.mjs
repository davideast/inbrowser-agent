import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

export const PRELOAD_MAX_BYTES = 45_056;
export const PRELOAD_MAX_GZIP_BYTES = 16_384;

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = path.join(pkgRoot, 'dist');
const req = createRequire(import.meta.url);

function assertPreloadBundleInputs(inputs) {
  for (const inputPath of Object.keys(inputs)) {
    const normalized = inputPath.replaceAll('\\', '/');
    const allowed =
      normalized.startsWith('src/preload/') ||
      normalized === 'src/types.ts' ||
      normalized === 'src/protocol.ts';
    if (!allowed) {
      throw new Error(
        `Preload bundle pulled in forbidden dependency '${normalized}'; only src/preload/**, src/types.ts, and src/protocol.ts are permitted.`,
      );
    }
  }
}

function assertCoreBundleInputs(inputs) {
  for (const inputPath of Object.keys(inputs)) {
    const normalized = inputPath.replaceAll('\\', '/');
    if (normalized.includes('puppeteer') || normalized.startsWith('src/puppeteer/')) {
      throw new Error(
        `Browser-safe core/tools bundle pulled in forbidden puppeteer input '${normalized}'.`,
      );
    }
  }
}

async function assertPackageExportTargets() {
  const pkg = JSON.parse(await readFile(path.join(pkgRoot, 'package.json'), 'utf8'));
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target === 'object' && target !== null) {
      for (const [condition, relPath] of Object.entries(target)) {
        if (typeof relPath === 'string' && !existsSync(path.resolve(pkgRoot, relPath))) {
          throw new Error(
            `package.json exports['${subpath}']['${condition}'] points to missing file '${relPath}'`,
          );
        }
      }
    }
  }
}

export async function buildBundles() {
  await mkdir(distDir, { recursive: true });

  const preloadResult = await build({
    absWorkingDir: pkgRoot,
    entryPoints: ['src/preload/entry.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    metafile: true,
    write: false,
  });

  assertPreloadBundleInputs(preloadResult.metafile.inputs);

  const preloadFile = preloadResult.outputFiles[0];
  if (!preloadFile) {
    throw new Error('esbuild produced no output for src/preload/entry.ts');
  }

  const preloadText = preloadFile.text;
  const preloadByteLength = Buffer.byteLength(preloadText, 'utf8');
  if (preloadByteLength > PRELOAD_MAX_BYTES) {
    throw new Error(
      `Preload IIFE exceeded hard budget: ${preloadByteLength} bytes > ${PRELOAD_MAX_BYTES} bytes`,
    );
  }
  const preloadGzipByteLength = gzipSync(preloadText).byteLength;
  if (preloadGzipByteLength > PRELOAD_MAX_GZIP_BYTES) {
    throw new Error(
      `Preload IIFE exceeded gzip budget: ${preloadGzipByteLength} bytes > ${PRELOAD_MAX_GZIP_BYTES} bytes`,
    );
  }

  const builtPreloadIife = path.join(distDir, 'preload.iife.js');
  const builtPreloadModule = path.join(distDir, 'preload.js');
  await writeFile(builtPreloadIife, preloadText, 'utf8');
  const preloadModuleSource =
    `export const DRIVER_PRELOAD_SOURCE = ${JSON.stringify(preloadText)};\n` +
    `export const DRIVER_PRELOAD_BYTE_LENGTH = ${preloadByteLength};\n`;
  await writeFile(builtPreloadModule, preloadModuleSource, 'utf8');

  const preloadExportFile = path.join(pkgRoot, 'src', 'preload', 'export.ts');
  const preloadExportAliasPlugin = {
    name: 'preload-export-alias',
    setup(buildCtx) {
      buildCtx.onResolve({ filter: /preload\/export\.js$/ }, (args) => {
        const candidate = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
        if (candidate === preloadExportFile) {
          return { path: builtPreloadModule };
        }
        return null;
      });
    },
  };

  const [coreResult] = await Promise.all([
    build({
      absWorkingDir: pkgRoot,
      entryPoints: {
        index: 'src/index.ts',
        tools: 'src/tools/index.ts',
      },
      outdir: 'dist',
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      sourcemap: true,
      metafile: true,
      plugins: [preloadExportAliasPlugin],
    }),
    build({
      absWorkingDir: pkgRoot,
      entryPoints: {
        puppeteer: 'src/puppeteer/index.ts',
      },
      outdir: 'dist',
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      sourcemap: true,
      external: ['puppeteer-core', 'puppeteer-core/*'],
    }),
  ]);

  assertCoreBundleInputs(coreResult.metafile.inputs);
  await Promise.all([
    copyFile(path.join(pkgRoot, 'LICENSE'), path.join(distDir, 'LICENSE')),
    copyFile(
      path.join(pkgRoot, 'THIRD_PARTY_NOTICES.txt'),
      path.join(distDir, 'THIRD_PARTY_NOTICES.txt'),
    ),
  ]);
  return { preloadByteLength, preloadGzipByteLength };
}

export async function buildAll() {
  await rm(distDir, { recursive: true, force: true });
  const { preloadByteLength, preloadGzipByteLength } = await buildBundles();
  const tscCli = req.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tscCli, '-p', 'tsconfig.build.json'], {
    cwd: pkgRoot,
    stdio: 'inherit',
  });
  await assertPackageExportTargets();
  console.log(
    `Built @inbrowser/driver (preload IIFE: ${preloadByteLength} / ${PRELOAD_MAX_BYTES} bytes, gzip: ${preloadGzipByteLength} / ${PRELOAD_MAX_GZIP_BYTES} bytes)`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  if (process.argv.includes('--bundles-only')) {
    await buildBundles();
  } else {
    await buildAll();
  }
}
