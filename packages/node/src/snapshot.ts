import { fault, record } from './protocol';

export type SnapshotEntry =
  | { path: string; type: 'directory'; mode: number }
  | { path: string; type: 'file'; mode: number; data: Uint8Array }
  | { path: string; type: 'symlink'; target: string };
export interface FilesystemSnapshot {
  version: 1;
  entries: SnapshotEntry[];
}
export const SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const SNAPSHOT_ENTRIES = 100000;

export function parseSnapshot(
  value: unknown,
  // resource-policy.ts imports this module for its defaults, so the bounds
  // arrive as parameters rather than through the realm accessor.
  maxEntries = SNAPSHOT_ENTRIES,
  maxBytes = SNAPSHOT_BYTES,
): FilesystemSnapshot {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    Object.keys(value).some((key) => key !== 'version' && key !== 'entries')
  )
    throw fault('EINVAL', 'Invalid filesystem snapshot');
  if (value.entries.length > maxEntries)
    throw fault('E2BIG', 'Snapshot has too many entries', {
      limit: maxEntries,
      actual: value.entries.length,
    });
  let bytes = 0;
  const entries: SnapshotEntry[] = [];
  const paths = new Map<string, SnapshotEntry>();
  for (const entry of value.entries) {
    if (
      !record(entry) ||
      typeof entry.path !== 'string' ||
      !entry.path.startsWith('/') ||
      entry.path.includes('\0')
    )
      throw fault('EINVAL', 'Invalid snapshot path');
    const components = entry.path === '/' ? [] : entry.path.slice(1).split('/');
    if (components.some((name) => !name || name === '.' || name === '..'))
      throw fault('EINVAL', 'Snapshot paths must be canonical');
    const pathBytes = new TextEncoder().encode(entry.path).length;
    if (components.length > 256 || pathBytes > 4096)
      throw fault('E2BIG', 'Snapshot path exceeds limit');
    bytes += pathBytes;
    if (paths.has(entry.path)) throw fault('EINVAL', 'Duplicate snapshot path');
    let result: SnapshotEntry;
    if (entry.type === 'symlink') {
      if (
        typeof entry.target !== 'string' ||
        !entry.target ||
        entry.target.includes('\0') ||
        Object.keys(entry).some((key) => !['path', 'type', 'target'].includes(key))
      )
        throw fault('EINVAL', 'Invalid snapshot symlink');
      const length = new TextEncoder().encode(entry.target).length;
      if (length > 8192) throw fault('E2BIG', 'Snapshot symlink target exceeds limit');
      bytes += length;
      result = { path: entry.path, type: 'symlink', target: entry.target };
    } else {
      if (
        (entry.type !== 'file' && entry.type !== 'directory') ||
        typeof entry.mode !== 'number' ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o7777 ||
        Object.keys(entry).some(
          (key) =>
            !['path', 'type', 'mode', ...(entry.type === 'file' ? ['data'] : [])].includes(key),
        )
      )
        throw fault('EINVAL', 'Invalid snapshot entry');
      if (entry.type === 'file') {
        if (!(entry.data instanceof Uint8Array))
          throw fault('EINVAL', 'Invalid snapshot file bytes');
        bytes += entry.data.byteLength;
        result = { path: entry.path, type: 'file', mode: entry.mode, data: entry.data };
      } else result = { path: entry.path, type: 'directory', mode: entry.mode };
    }
    if (bytes > maxBytes) throw fault('E2BIG', 'Snapshot exceeds 128 MiB');
    entries.push(result);
    paths.set(result.path, result);
  }
  if (paths.get('/')?.type !== 'directory')
    throw fault('EINVAL', 'Snapshot must contain its root directory');
  for (const entry of entries) {
    if (entry.path === '/') continue;
    const parent = entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
    if (paths.get(parent)?.type !== 'directory')
      throw fault('EINVAL', 'Snapshot entry parent must be a directory');
  }
  return { version: 1, entries };
}
