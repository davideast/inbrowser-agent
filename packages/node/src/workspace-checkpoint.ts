import { fault, record } from './protocol';
import { resourceLimits } from './resource-policy';

/** The realm's snapshot bounds, for the shared parser. */
function snapshotBounds(): [number, number] {
  const limits = resourceLimits().snapshot;
  return [limits.entries, limits.bytes];
}
import { type FilesystemSnapshot, parseSnapshot } from './snapshot';

export interface StartupConfiguration {
  command: 'node' | 'sh';
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface CheckpointReceipt {
  revision: number;
  writtenBlobs: number;
  reusedBlobs: number;
}
export interface WorkspaceManifest {
  version: 1;
  revision: number;
  startup: StartupConfiguration | null;
  snapshot: FilesystemSnapshot;
  hashes: Record<string, string>;
}
export function checkpointKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    new TextEncoder().encode(value).length > 256
  )
    throw fault('EINVAL', 'Checkpoint name must contain 1–256 UTF-8 bytes without NUL');
  return value;
}
export function parseStartup(value: unknown): StartupConfiguration | null {
  if (value === null) return null;
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['command', 'args', 'cwd', 'env'].includes(key)) ||
    (value.command !== 'node' && value.command !== 'sh') ||
    !Array.isArray(value.args) ||
    !value.args.length ||
    Array.from(value.args).some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0')) ||
    typeof value.cwd !== 'string' ||
    !value.cwd.startsWith('/') ||
    value.cwd.includes('\0') ||
    !record(value.env) ||
    Array.isArray(value.env) ||
    Object.values(value.env).some((item) => typeof item !== 'string')
  )
    throw fault('EINVAL', 'Invalid checkpoint startup configuration');
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    resourceLimits().snapshot.startupConfigBytes
  )
    throw fault('E2BIG', 'Startup configuration exceeds 64 KiB');
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.env)) {
    if (typeof item !== 'string') throw fault('EINVAL', 'Invalid startup environment');
    Object.defineProperty(env, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { command: value.command, args: [...value.args], cwd: value.cwd, env };
}
export async function contentHash(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
export async function prepareCheckpoint(
  snapshot: FilesystemSnapshot,
  startup: StartupConfiguration | null,
  signal: AbortSignal,
) {
  const hashes: Record<string, string> = {};
  const blobs = new Map<string, Uint8Array>();
  const entries = [];
  for (const entry of parseSnapshot(snapshot, ...snapshotBounds()).entries) {
    signal.throwIfAborted();
    if (entry.type !== 'file') {
      entries.push(entry);
      continue;
    }
    const bytes = new Uint8Array(entry.data);
    const hash = await contentHash(bytes);
    hashes[entry.path] = hash;
    blobs.set(hash, bytes);
    entries.push({ ...entry, data: new Uint8Array() });
  }
  signal.throwIfAborted();
  return {
    manifest: {
      version: 1 as const,
      revision: 1,
      startup,
      snapshot: { version: 1 as const, entries },
      hashes,
    },
    blobs,
  };
}
export function parseManifest(value: unknown): WorkspaceManifest {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== 'number' ||
    value.revision < 1 ||
    !record(value.hashes) ||
    Array.isArray(value.hashes)
  )
    throw fault('EINVAL', 'Invalid workspace manifest');
  const snapshot = parseSnapshot(value.snapshot, ...snapshotBounds());
  const hashes: Record<string, string> = {};
  for (const entry of snapshot.entries) {
    if (entry.type !== 'file') continue;
    const hash = value.hashes[entry.path];
    if (entry.data.length !== 0 || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
      throw fault('EINTEGRITY', 'Invalid workspace content reference');
    hashes[entry.path] = hash;
  }
  if (Object.keys(value.hashes).length !== Object.keys(hashes).length)
    throw fault('EINTEGRITY', 'Unexpected workspace content reference');
  return {
    version: 1,
    revision: value.revision,
    startup: parseStartup(value.startup),
    snapshot,
    hashes,
  };
}
