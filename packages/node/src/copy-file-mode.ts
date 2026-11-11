export function copyFileMode(value: unknown): number {
  const mode = value ?? 0;
  if (typeof mode !== 'number')
    throw Object.assign(new TypeError('copyFile mode must be a number'), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
  // Node's binding truncates finite fractional flags before checking the range.
  const flags = Math.trunc(mode);
  if (!Number.isFinite(flags) || flags < 0 || flags > 7)
    throw Object.assign(new RangeError('copyFile mode must contain supported flag bits'), {
      code: 'ERR_OUT_OF_RANGE',
    });
  return flags;
}
