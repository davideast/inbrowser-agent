import type { FileStat } from './file-stat';
import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

export interface PackageCache {
  version: 1;
  files: Record<string, Uint8Array>;
}
interface CacheFilesystem {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<string | Uint8Array>;
}
const contentPattern = /^content-v2\/sha512\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{124})$/;
const indexPattern = /^index-v5\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{60})$/;

export function packageCachePath(options: unknown): string {
  if (
    !record(options) ||
    Object.keys(options).some((key) => key !== 'path') ||
    typeof options.path !== 'string' ||
    !options.path.startsWith('/') ||
    options.path.includes('\\') ||
    options.path.includes('\0') ||
    options.path
      .split('/')
      .slice(1)
      .some((part) => !part || part === '.' || part === '..')
  )
    throw fault('EINVAL', 'Package cache path must be an absolute canonical directory');
  return options.path + '/_cacache';
}
async function digest(algorithm: string, bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function contentPath(integrity: unknown): string {
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity))
    throw fault('ENOSYS', 'Package cache requires a single SHA-512 integrity value');
  const raw = atob(integrity.slice(7));
  const hash = [...raw].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return 'content-v2/sha512/' + hash.slice(0, 2) + '/' + hash.slice(2, 4) + '/' + hash.slice(4);
}

/** Validate immutable npm cacache content-v2/index-v5 before storage or publication. */
export async function validatePackageCache(
  value: unknown,
  signal: AbortSignal,
): Promise<PackageCache> {
  if (!record(value) || value.version !== 1 || !record(value.files) || Array.isArray(value.files))
    throw fault('EINVAL', 'Invalid package cache record');
  const files: Record<string, Uint8Array> = {};
  const entries = Object.entries(value.files);
  if (entries.length > resourceLimits().snapshot.packageCacheFiles)
    throw fault('E2BIG', 'Package cache has too many files');
  let total = 0;
  for (const [filename, bytes] of entries) {
    signal.throwIfAborted();
    if (
      !(bytes instanceof Uint8Array) ||
      !(contentPattern.test(filename) || indexPattern.test(filename))
    )
      throw fault('EINVAL', 'Unsupported package cache file');
    total += bytes.byteLength;
    if (total > resourceLimits().snapshot.packageCacheBytes)
      throw fault('E2BIG', 'Package cache exceeds 128 MiB');
    files[filename] = new Uint8Array(bytes);
    const content = contentPattern.exec(filename);
    if (content && (await digest('SHA-512', bytes)) !== content.slice(1).join(''))
      throw fault('EINTEGRITY', 'Package cache content digest mismatch');
  }
  const encoder = new TextEncoder();
  for (const [filename, bytes] of Object.entries(files)) {
    const index = indexPattern.exec(filename);
    if (!index) continue;
    const latest = new Map<string, Record<string, unknown>>();
    for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n')) {
      signal.throwIfAborted();
      if (!line) continue;
      const tab = line.indexOf('\t');
      const json = line.slice(tab + 1);
      if (tab !== 40 || (await digest('SHA-1', encoder.encode(json))) !== line.slice(0, tab))
        throw fault('EINTEGRITY', 'Package cache index checksum mismatch');
      const entry: unknown = JSON.parse(json);
      if (
        !record(entry) ||
        typeof entry.key !== 'string' ||
        (await digest('SHA-256', encoder.encode(entry.key))) !== index.slice(1).join('')
      )
        throw fault('EINTEGRITY', 'Package cache index key mismatch');
      latest.set(entry.key, entry);
    }
    for (const entry of latest.values()) {
      if (entry.integrity === null) continue;
      const bytes = files[contentPath(entry.integrity)];
      if (!bytes || typeof entry.size !== 'number' || entry.size !== bytes.byteLength)
        throw fault(
          'EINTEGRITY',
          'Package cache index references missing or incomplete content: expected ' +
            String(entry.size) +
            ' bytes, found ' +
            String(bytes?.byteLength) +
            ' at ' +
            contentPath(entry.integrity),
        );
    }
  }
  signal.throwIfAborted();
  return { version: 1, files };
}

export async function capturePackageCache(
  fs: CacheFilesystem,
  root: string,
  signal: AbortSignal,
): Promise<PackageCache> {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  let count = 0;
  async function walk(relative: string) {
    signal.throwIfAborted();
    const filename = root + '/' + relative;
    const stat = await fs.lstat(filename);
    if (++count > resourceLimits().snapshot.packageCacheFiles)
      throw fault('E2BIG', 'Package cache has too many entries');
    if (stat.type === 'directory') {
      for (const name of await fs.readdir(filename)) await walk(relative + '/' + name);
    } else if (stat.type === 'file') {
      total += stat.size;
      if (total > resourceLimits().snapshot.packageCacheBytes)
        throw fault('E2BIG', 'Package cache exceeds 128 MiB');
      const bytes = await fs.readFile(filename);
      if (typeof bytes === 'string') throw fault('EPROTO', 'Package cache read must be binary');
      files[relative] = bytes;
    } else throw fault('ENOSYS', 'Package cache cannot contain symbolic links');
  }
  // Only committed content and its index are persisted. npm tmp files and logs are excluded.
  const names = await fs.readdir(root);
  for (const directory of ['content-v2', 'index-v5']) {
    if (names.includes(directory)) await walk(directory);
  }
  return validatePackageCache({ version: 1, files }, signal);
}
