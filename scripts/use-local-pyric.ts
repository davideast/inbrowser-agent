#!/usr/bin/env bun
/** Pack the built local checkout, as pyric-surface-lab does, into an ignored
 * installation. Never write machine-specific dependency paths to manifests. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const repo = process.env.PYRIC_REPO;
if (!repo)
  throw new Error('Set PYRIC_REPO to the local Pyric checkout; run bun run build there first.');
const out = resolve('.pyric/local');
await mkdir(out, { recursive: true });
const tarballs: string[] = [];
for (const name of ['pyric', 'pyric-admin', 'create-pyric', 'cli']) {
  const cwd = resolve(repo, 'packages', name);
  const command = Bun.spawn(
    ['npm', 'pack', '--silent', '--ignore-scripts', '--pack-destination', out],
    {
      cwd,
      env: { ...process.env, npm_config_cache: resolve('.pyric/npm-cache') },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  const tarball = (await new Response(command.stdout).text()).trim();
  if ((await command.exited) !== 0) throw new Error(`Could not pack ${name}`);
  const file = join(out, tarball);
  const temp = await mkdtemp(join(tmpdir(), 'inbrowser-pyric-pack-'));
  const extract = Bun.spawn(['tar', '-xzf', file, '-C', temp], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await extract.exited) !== 0) throw new Error('Cannot extract tarball');
  const manifestPath = join(temp, 'package/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [dep, value] of Object.entries(manifest[section] ?? {})) {
      if (typeof value !== 'string' || !value.startsWith('workspace:')) continue;
      const folder = dep === '@pyric/cli' ? 'cli' : dep.replace('@pyric/', '');
      const target = JSON.parse(
        await readFile(resolve(repo, 'packages', folder, 'package.json'), 'utf8'),
      );
      manifest[section][dep] = target.version;
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const repack = Bun.spawn(['tar', '-czf', file, '-C', temp, 'package'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await repack.exited) !== 0) throw new Error('Cannot repack tarball');
  tarballs.push(file);
  await rm(temp, { recursive: true, force: true });
}
await writeFile(join(out, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const install = Bun.spawn(
  ['npm', 'install', '--prefix', out, '--no-audit', '--no-fund', ...tarballs],
  {
    env: { ...process.env, npm_config_cache: resolve('.pyric/npm-cache') },
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
if ((await install.exited) !== 0) throw new Error('Local Pyric installation failed');
console.log(
  `PYRIC_LOCAL_MODULES=${join(out, 'node_modules')} bun run --cwd packages/sandbox test:firebase:pyric`,
);
