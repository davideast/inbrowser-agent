import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without type declarations
import { writeNotices } from '../../scripts/notices.mjs';

const req = createRequire(import.meta.url);
const bufferEntry = req.resolve('buffer/');

describe('writeNotices', () => {
  it('includes node@22.18.0 license once when vendor/node-v22.18.0 inputs are bundled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'notices-unit-'));
    try {
      const outPath = path.join(dir, 'THIRD_PARTY_NOTICES.txt');
      await writeNotices(
        {
          'src/builtins/assert.ts': {},
          'vendor/node-v22.18.0/lib/assert.js': {},
          'vendor/node-v22.18.0/lib/internal/assert/assertion_error.js': {},
          [bufferEntry]: {},
        },
        outPath,
      );
      const content = await readFile(outPath, 'utf8');
      expect(content).toContain('=== buffer@');
      expect(content).toContain('=== node@22.18.0 (MIT) ===');
      expect(content).toContain('Node.js is licensed for use as follows:');
      expect(content).toContain('Copyright Node.js contributors. All rights reserved.');
      expect(content.match(/=== node@22\.18\.0 \(MIT\) ===/g)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits node@22.18.0 license when no vendor/node-v22.18.0 files are in inputs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'notices-unit-'));
    try {
      const outPath = path.join(dir, 'THIRD_PARTY_NOTICES.txt');
      await writeNotices(
        {
          'src/index.ts': {},
          [bufferEntry]: {},
        },
        outPath,
      );
      const content = await readFile(outPath, 'utf8');
      expect(content).toContain('=== buffer@');
      expect(content).not.toContain('node@22.18.0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
