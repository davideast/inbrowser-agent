import { fault } from './protocol';

export const DEFAULT_DESCRIPTOR_READ_LIMIT = 32 * 1024 * 1024;

/** Bounds each guest descriptor read; kernel messages remain capped at 64 KiB. */
export function validateDescriptorReadLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_DESCRIPTOR_READ_LIMIT;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 64 * 1024 * 1024
  )
    throw fault('EINVAL', 'Descriptor read limit must be an integer from 1 byte to 64 MiB');
  return value;
}
