/**
 * Smoke test for the generative golden-task fixtures.
 *
 * Loads each per-skill subdirectory under
 * `packages/agent/fixtures/generative/` via the node-only loader and
 * asserts:
 *   - each subdirectory's fixtures all validate against the schema,
 *   - every fixture's `skill` matches its parent directory,
 *   - every fixture's `id` starts with `<skill>/`,
 *   - the per-skill counts and the aggregate count are in the expected
 *     range (2-3 per skill, 8-12 total).
 *
 * This guards against fixture-format drift and against fixtures being
 * filed under the wrong skill directory.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { loadFixtures } from '../../src/node.js';

const ROOT = join(import.meta.dir, '..', '..', 'fixtures', 'generative');

const SKILL_DIRS = [
  'pyric-agents',
  'playground-prompts',
  'rtdb-game-rules',
  'firestore-game-rules',
] as const;

describe('generative golden-task fixtures', () => {
  for (const skill of SKILL_DIRS) {
    test(`${skill}/ validates and is internally consistent`, () => {
      const fixtures = loadFixtures(join(ROOT, skill));
      expect(fixtures.length).toBeGreaterThanOrEqual(2);
      expect(fixtures.length).toBeLessThanOrEqual(3);
      for (const fixture of fixtures) {
        expect(fixture.skill).toBe(skill);
        expect(fixture.id.startsWith(`${skill}/`)).toBe(true);
      }
    });
  }

  test('aggregate count is in the expected range (8-12)', () => {
    let total = 0;
    for (const skill of SKILL_DIRS) {
      total += loadFixtures(join(ROOT, skill)).length;
    }
    expect(total).toBeGreaterThanOrEqual(8);
    expect(total).toBeLessThanOrEqual(12);
  });
});
