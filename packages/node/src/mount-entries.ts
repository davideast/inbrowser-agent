import { fault, record } from './protocol';

/**
 * One `mount()` entry: bare contents (string or bytes), or contents with an
 * explicit permission mode. The field names follow snapshot file entries
 * (`data`, `mode`), and `mode` takes the permission bits Node's `chmod` takes.
 */
export type MountEntry = string | Uint8Array | { data: string | Uint8Array; mode?: number };

export interface ParsedMountEntry {
  path: string;
  data: string | Uint8Array;
  mode?: number;
}

/**
 * Validates a permission mode like `fs.chmod` and rejects file-type bits. Like
 * copyFileMode, the errors carry Node's classes and codes (the kernel's own
 * revalidation crosses the RPC as a plain Error with the same code).
 */
export function parseMountMode(value: unknown): number {
  if (typeof value !== 'number')
    throw Object.assign(new TypeError('The "mode" argument must be of type number'), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
  if (!Number.isInteger(value) || value < 0 || value > 0o7777)
    throw Object.assign(
      new RangeError(
        'The value of "mode" is out of range. It must be an integer >= 0 && <= 4095 (0o7777)',
      ),
      { code: 'ERR_OUT_OF_RANGE' },
    );
  return value;
}

/**
 * Validates every entry before any is written, so one invalid entry fails the
 * whole mount. Invalid paths and contents keep mount's existing EINVAL.
 */
export function parseMountEntries(files: unknown): ParsedMountEntry[] {
  if (!record(files) || files instanceof Uint8Array) throw fault('EINVAL', 'Invalid mounted files');
  const parsed: ParsedMountEntry[] = [];
  for (const [path, entry] of Object.entries(files)) {
    if (!path.startsWith('/')) throw fault('EINVAL', 'Invalid mounted file');
    if (typeof entry === 'string' || entry instanceof Uint8Array) {
      parsed.push({ path, data: entry });
      continue;
    }
    if (
      !record(entry) ||
      Array.isArray(entry) ||
      !(typeof entry.data === 'string' || entry.data instanceof Uint8Array) ||
      Object.keys(entry).some((key) => key !== 'data' && key !== 'mode')
    )
      throw fault('EINVAL', 'Invalid mounted file');
    parsed.push(
      entry.mode === undefined
        ? { path, data: entry.data }
        : { path, data: entry.data, mode: parseMountMode(entry.mode) },
    );
  }
  return parsed;
}
