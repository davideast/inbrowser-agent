import { fault, record } from './protocol';

export interface FileStat {
  type: 'file' | 'directory' | 'symlink';
  mode: number;
  size: number;
}

export function fileStat(value: unknown): FileStat {
  if (
    !record(value) ||
    typeof value.mode !== 'number' ||
    !Number.isSafeInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0xffffffff ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  )
    throw fault('EPROTO', 'Invalid file metadata');
  const kind = value.mode & 0o170000;
  const type =
    kind === 0o100000
      ? 'file'
      : kind === 0o040000
        ? 'directory'
        : kind === 0o120000
          ? 'symlink'
          : undefined;
  if (!type) throw fault('ENOSYS', 'Unsupported filesystem entry type');
  return { type, mode: value.mode, size: value.size };
}
