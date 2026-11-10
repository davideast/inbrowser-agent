import { fault } from './protocol';

export const DEFAULT_HTTP_RESPONSE_LIMIT = 8 * 1024 * 1024;

/** Limits decoded bytes buffered by each outbound Fetch response. */
export function validateHttpResponseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_HTTP_RESPONSE_LIMIT;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 64 * 1024 * 1024
  )
    throw fault('EINVAL', 'HTTP response limit must be an integer from 1 byte to 64 MiB');
  return value;
}
