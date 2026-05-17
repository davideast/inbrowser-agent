import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures } from '../../src/node.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(HERE, '..', '..', 'fixtures', 'diagnostic');

const EXPECTED_COUNTS = {
  'firestore-rules-audit': 3,
  'firebase-project-audit': 2,
  'rtdb-data-modeling': 2,
  'firebase-security-rules': 2,
  'firebase-client-sdk': 3,
} as const;

const EXPECTED_TOTAL = Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0);

describe('golden-tasks-diagnostic fixtures', () => {
  test('every skill directory loads cleanly and reports the expected count', () => {
    let total = 0;
    for (const [skill, expected] of Object.entries(EXPECTED_COUNTS)) {
      const dir = join(FIXTURES_ROOT, skill);
      const fixtures = loadFixtures(dir);
      expect(fixtures.length).toBe(expected);
      for (const fixture of fixtures) {
        expect(fixture.skill).toBe(skill as typeof fixture.skill);
        expect(fixture.id.startsWith(`${skill}/`)).toBe(true);
      }
      total += fixtures.length;
    }
    expect(total).toBe(EXPECTED_TOTAL);
  });

  test('every fixture id is unique across the directory', () => {
    const ids = new Set<string>();
    for (const skill of Object.keys(EXPECTED_COUNTS)) {
      for (const fixture of loadFixtures(join(FIXTURES_ROOT, skill))) {
        expect(ids.has(fixture.id)).toBe(false);
        ids.add(fixture.id);
      }
    }
    expect(ids.size).toBe(EXPECTED_TOTAL);
  });

  test('no unexpected skill directories appear under diagnostic/', () => {
    const entries = readdirSync(FIXTURES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const expected = Object.keys(EXPECTED_COUNTS).sort();
    expect(entries).toEqual(expected);
  });
});
