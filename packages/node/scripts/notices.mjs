import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const req = createRequire(import.meta.url);

function resolvePackageDir(rawRoot, pkgName) {
  const candidates = [
    path.isAbsolute(rawRoot) ? rawRoot : path.resolve(pkgRoot, rawRoot),
    path.resolve(process.cwd(), rawRoot),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  try {
    return path.dirname(req.resolve(`${pkgName}/package.json`));
  } catch {
    return candidates[0];
  }
}

export async function writeNotices(
  inputs,
  outputPath = path.join(pkgRoot, 'dist/THIRD_PARTY_NOTICES.txt'),
) {
  const rootsByPkg = new Map();
  let hasUpstreamNode = false;
  for (const filename of Object.keys(inputs)) {
    const normalized = filename.replaceAll('\\', '/');
    if (
      normalized.startsWith('vendor/node-v22.18.0/') ||
      normalized.includes('/vendor/node-v22.18.0/')
    ) {
      hasUpstreamNode = true;
      continue;
    }
    const parts = normalized.split('/');
    const index = parts.lastIndexOf('node_modules');
    if (index < 0) continue;
    const span = parts[index + 1]?.startsWith('@') ? 3 : 2;
    const rawRoot = parts.slice(0, index + span).join('/');
    const pkgName = parts.slice(index + 1, index + span).join('/');
    const resolvedDir = resolvePackageDir(rawRoot, pkgName);
    rootsByPkg.set(resolvedDir, resolvedDir);
  }
  const notices = ['Third-party packages included in @inbrowser/node browser bundles.'];
  if (hasUpstreamNode) {
    notices.push('\n=== node@22.18.0 (MIT) ===');
    notices.push(await readFile(path.join(pkgRoot, 'vendor/node-v22.18.0/LICENSE'), 'utf8'));
  }
  const entries = [];
  for (const root of rootsByPkg.values()) {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    entries.push({ pkg, root });
  }
  entries.sort((a, b) =>
    `${a.pkg.name}@${a.pkg.version}`.localeCompare(`${b.pkg.name}@${b.pkg.version}`),
  );
  for (const { pkg, root } of entries) {
    notices.push(`\n=== ${pkg.name}@${pkg.version} (${pkg.license || 'See upstream license'}) ===`);
    const files = (await readdir(root)).filter((name) =>
      /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name),
    );
    if (!files.length) throw new Error(`No license file found for bundled dependency ${pkg.name}`);
    for (const file of files.sort()) {
      notices.push(await readFile(path.join(root, file), 'utf8'));
    }
  }
  await writeFile(outputPath, notices.join('\n\n'));
}
