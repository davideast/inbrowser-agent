import { fault } from './protocol';

export const DEFAULT_UNZIP_LIMIT = 32 * 1024 * 1024;

/** Separate cumulative input and output byte bounds for each Unzip decoder. */
export function validateUnzipLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_UNZIP_LIMIT;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 256 * 1024 * 1024
  )
    throw fault('EINVAL', 'Unzip limit must be an integer from 1 byte to 256 MiB');
  return value;
}
