import path from 'path-browserify';
import { boundedBytes, packageFiles } from './package-archive';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

interface InstallFilesystem {
  readFile(path: string, encoding: 'utf8'): Promise<string | Uint8Array>;
  mount(files: Record<string, Uint8Array>): Promise<void>;
  link(target: string, filename: string): Promise<void>;
  chmod(filename: string, mode: number): Promise<void>;
}

function json(value: string | Uint8Array): Record<string, unknown> {
  if (typeof value !== 'string') throw fault('EINVAL', 'Expected a UTF-8 manifest');
  const parsed: unknown = JSON.parse(value);
  if (!record(parsed) || Array.isArray(parsed)) throw fault('EINVAL', 'Expected a manifest object');
  return parsed;
}

function noLifecycle(manifest: Record<string, unknown>) {
  const scripts = manifest.scripts;
  if (
    record(scripts) &&
    ['preinstall', 'install', 'postinstall', 'prepare'].some((name) => Object.hasOwn(scripts, name))
  )
    throw fault('ENOSYS', 'Installation lifecycle scripts are not supported');
}

/** Install an existing registry lock; resolution and script execution belong to later gates. */
export async function installLocked(
  fs: InstallFilesystem,
  cwd: string,
  signal: AbortSignal,
  omitOptional = false,
): Promise<void> {
  if (
    typeof cwd !== 'string' ||
    !cwd.startsWith('/') ||
    cwd.includes('\\') ||
    cwd.includes('\0') ||
    (cwd !== '/' &&
      cwd
        .split('/')
        .slice(1)
        .some((part) => !part || part === '.' || part === '..'))
  )
    throw fault('EINVAL', 'Install cwd must be an absolute canonical directory');
  const base = cwd === '/' ? '' : cwd;
  const manifest = json(await fs.readFile(base + '/package.json', 'utf8'));
  const lock = json(await fs.readFile(base + '/package-lock.json', 'utf8'));
  if (lock.lockfileVersion !== 3 || !record(lock.packages) || !record(lock.packages['']))
    throw fault('ENOSYS', 'Installation requires a version 3 package lock');
  noLifecycle(manifest);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const requested = manifest[field] ?? {};
    const locked = lock.packages[''][field] ?? {};
    if (
      !record(requested) ||
      !record(locked) ||
      Object.keys(requested).length !== Object.keys(locked).length ||
      Object.entries(requested).some(
        ([name, value]) => typeof value !== 'string' || locked[name] !== value,
      )
    )
      throw fault('EINVAL', 'Package manifest and lockfile are out of sync');
  }
  const entries = Object.entries(lock.packages)
    .filter(([name]) => name !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > resourceLimits().install.lockedPackages)
    throw fault('E2BIG', 'Too many locked packages');
  const staged: Record<string, Uint8Array> = {};
  const links = new Map<string, string>();
  let total = 0;
  for (const [location, entry] of entries) {
    signal.throwIfAborted();
    if (
      !/^(?:node_modules\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+)(?:\/node_modules\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+)*$/.test(
        location,
      ) ||
      location.split('/').some((part) => part === '.' || part === '..')
    )
      throw fault('EINVAL', 'Invalid locked package path');
    if (
      !record(entry) ||
      typeof entry.version !== 'string' ||
      typeof entry.resolved !== 'string' ||
      typeof entry.integrity !== 'string'
    )
      throw fault('EINVAL', 'Locked package requires version, registry URL and integrity');
    if (omitOptional && entry.optional === true) continue;
    if (entry.link || entry.hasInstallScript || entry.os || entry.cpu)
      throw fault('ENOSYS', 'Unsupported linked, platform-specific or scripted package');
    const url = new URL(entry.resolved);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'registry.npmjs.org' ||
      url.port ||
      url.username ||
      url.password
    )
      throw fault('ENOSYS', 'Only public npm registry tarballs are currently supported');
    const integrity = entry.integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
    if (!integrity) throw fault('ENOSYS', 'A SHA-512 registry integrity value is required');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(fault('ETIMEDOUT', 'Package download timed out')),
      resourceLimits().timers.downloadMs,
    );
    let compressed: Uint8Array;
    try {
      const lifetime = AbortSignal.any([signal, controller.signal]);
      const response = await fetch(url, {
        credentials: 'omit',
        redirect: 'error',
        signal: lifetime,
      });
      if (!response.ok || !response.body)
        throw fault('EIO', `Package download failed: ${response.status}`);
      compressed = await boundedBytes(response.body, lifetime);
    } finally {
      clearTimeout(timer);
    }
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-512', new Uint8Array(compressed)),
    );
    if (btoa(String.fromCharCode(...digest)) !== integrity[1])
      throw fault('EINTEGRITY', `Package integrity mismatch: ${location}`);
    const files = await packageFiles(compressed, signal);
    if (!files['package.json']) throw fault('EINVAL', 'Package archive has no manifest');
    const pkg = json(new TextDecoder().decode(files['package.json']));
    if (pkg.version !== entry.version)
      throw fault('EINVAL', 'Archive version disagrees with lockfile');
    noLifecycle(pkg);
    const bins =
      typeof pkg.bin === 'string' && typeof pkg.name === 'string'
        ? { [pkg.name.split('/').at(-1) ?? '']: pkg.bin }
        : // Lock metadata can supply bins absent from the packed manifest (for
          // example, an npm alias override). Targets must still be published files.
          (pkg.bin ?? entry.bin ?? {});
    if (!record(bins)) throw fault('EINVAL', 'Invalid package bin map');
    const lockedBins = entry.bin ?? {};
    if (!record(lockedBins) || Object.keys(bins).length !== Object.keys(lockedBins).length)
      throw fault('EINVAL', 'Package bins disagree with lockfile');
    for (const [name, target] of Object.entries(bins)) {
      if (
        !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name) ||
        typeof target !== 'string' ||
        typeof lockedBins[name] !== 'string' ||
        path.normalize(lockedBins[name]) !== path.normalize(target)
      )
        throw fault('EINVAL', 'Invalid locked package bin');
      const relative = path.normalize(target);
      if (
        path.isAbsolute(relative) ||
        relative.startsWith('../') ||
        relative === '..' ||
        target.includes('\\') ||
        target.includes('\0') ||
        !Object.hasOwn(files, relative)
      )
        throw fault('EINVAL', 'Package bin target must be a published file');
      const modules = location.slice(
        0,
        location.lastIndexOf('node_modules/') + 'node_modules/'.length,
      );
      const filename = base + '/' + modules + '.bin/' + name;
      if (links.has(filename))
        throw fault('ENOSYS', 'Conflicting package bin names are not yet supported');
      links.set(
        filename,
        path.relative(path.dirname(filename), base + '/' + location + '/' + relative),
      );
    }
    for (const [name, bytes] of Object.entries(files)) {
      total += bytes.length;
      if (total > resourceLimits().install.packageBytes)
        throw fault('E2BIG', 'Installed package files exceed 256 MiB');
      staged[base + '/' + location + '/' + name] = bytes;
    }
  }
  signal.throwIfAborted();
  await fs.mount(staged);
  for (const [filename, target] of links) {
    signal.throwIfAborted();
    // npm makes every bin target executable (bin-links), and the shell now honors
    // the owner execute bit, so a linked bin must carry it.
    await fs.chmod(path.resolve(path.dirname(filename), target), 0o755);
    await fs.link(target, filename);
  }
}
