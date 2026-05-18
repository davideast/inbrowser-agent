import { describe, expect, test } from 'bun:test';
import {
  SKILL_CATALOG,
  SKILL_NAMES,
  createSpecRegistry,
  getSkillEntry,
  listSkillNames,
  registerAllSpecs,
} from '../src/index.js';

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SKILL_NAME_SET: ReadonlySet<string> = new Set(SKILL_NAMES);

function buildRegistry() {
  const registry = createSpecRegistry();
  registerAllSpecs(registry);
  return registry;
}

describe('SKILL_CATALOG shape', () => {
  test('covers every value in SKILL_NAMES exactly once', () => {
    const catalogNames = SKILL_CATALOG.map((entry) => entry.name);
    expect(new Set(catalogNames).size).toBe(catalogNames.length);
    expect(new Set(catalogNames)).toEqual(new Set(SKILL_NAMES));
  });

  test('every entry name is a member of SKILL_NAMES', () => {
    for (const entry of SKILL_CATALOG) {
      expect(SKILL_NAME_SET.has(entry.name)).toBe(true);
    }
  });

  test('every entry has a non-empty description', () => {
    for (const entry of SKILL_CATALOG) {
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test('every entry has at least three trigger hints', () => {
    for (const entry of SKILL_CATALOG) {
      expect(entry.triggerHints.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('every trigger hint is a non-empty lowercase string', () => {
    for (const entry of SKILL_CATALOG) {
      for (const hint of entry.triggerHints) {
        expect(typeof hint).toBe('string');
        expect(hint.length).toBeGreaterThan(0);
        expect(hint).toBe(hint.toLowerCase());
      }
    }
  });

  test('trigger hints are unique within an entry', () => {
    for (const entry of SKILL_CATALOG) {
      const hints = [...entry.triggerHints];
      expect(new Set(hints).size).toBe(hints.length);
    }
  });

  test('every entry has between 4 and 9 steps', () => {
    for (const entry of SKILL_CATALOG) {
      expect(entry.steps.length).toBeGreaterThanOrEqual(4);
      expect(entry.steps.length).toBeLessThanOrEqual(9);
    }
  });

  test('every step has a kebab-case id unique within its plan', () => {
    for (const entry of SKILL_CATALOG) {
      const ids = entry.steps.map((step) => step.id);
      for (const id of ids) {
        expect(KEBAB_CASE.test(id)).toBe(true);
      }
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test('every step has a non-empty description', () => {
    for (const entry of SKILL_CATALOG) {
      for (const step of entry.steps) {
        expect(typeof step.description).toBe('string');
        expect(step.description.length).toBeGreaterThan(0);
      }
    }
  });

  test('every verifier name resolves against the full registered spec set', () => {
    const registry = buildRegistry();
    for (const entry of SKILL_CATALOG) {
      for (const step of entry.steps) {
        if (!step.verifier) continue;
        expect(registry.has(step.verifier.name)).toBe(true);
      }
    }
  });
});

describe('skill-catalog helpers', () => {
  test('getSkillEntry returns the entry for every known name', () => {
    for (const name of SKILL_NAMES) {
      const entry = getSkillEntry(name);
      expect(entry).toBeDefined();
      expect(entry?.name).toBe(name);
    }
  });

  test('getSkillEntry returns undefined for an unknown name', () => {
    expect(getSkillEntry('not-a-skill' as never)).toBeUndefined();
  });

  test('listSkillNames returns names in catalog order', () => {
    const expected = SKILL_CATALOG.map((entry) => entry.name);
    expect(listSkillNames()).toEqual(expected);
  });

  test('listSkillNames covers SKILL_NAMES exactly', () => {
    expect(new Set(listSkillNames())).toEqual(new Set(SKILL_NAMES));
  });
});
