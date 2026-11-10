import { describe, expect, it } from 'vitest';
import { MODULE_SOURCE_LIMIT, MODULE_TOTAL_LIMIT } from '../../src/module-limits';

describe('module-limits', () => {
  it('bounds a single compiled module to 32 MiB', () => {
    expect(MODULE_SOURCE_LIMIT).toBe(32 * 1024 * 1024);
  });

  it('bounds the aggregate compiled module budget to 128 MiB', () => {
    expect(MODULE_TOTAL_LIMIT).toBe(128 * 1024 * 1024);
  });

  it('keeps the aggregate limit a multiple of the per-module limit', () => {
    expect(MODULE_TOTAL_LIMIT % MODULE_SOURCE_LIMIT).toBe(0);
    expect(MODULE_TOTAL_LIMIT).toBeGreaterThan(MODULE_SOURCE_LIMIT);
  });
});
