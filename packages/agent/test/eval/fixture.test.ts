import { describe, expect, test } from 'bun:test';
import {
  EMPTY_WORKSPACE,
  SKILL_NAMES,
  applyWorkspaceOverrides,
  parseFixture,
  validateFixture,
} from '../../src/index.js';

const validFixture = {
  id: 'firestore-rules-audit/seed-open-write-01',
  skill: 'firestore-rules-audit',
  description: 'Detects open-write vulnerability on /users',
  prompt: 'Audit my Firestore rules for security issues.',
  initialState: {
    rules: "rules_version='2';\nservice cloud.firestore {}",
  },
  successSpec: {
    name: 'firestore-rules-audit/names-planted-vulnerability',
    args: { vulnerability: 'open-write-users' },
  },
};

describe('validateFixture', () => {
  test('accepts a valid fixture with all fields', () => {
    const result = validateFixture(validFixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fixture.id).toBe(validFixture.id);
      expect(result.fixture.skill).toBe('firestore-rules-audit');
    }
  });

  test('accepts a minimal fixture without optional fields', () => {
    const minimal = {
      id: 'firestore-rules-audit/minimal-01',
      skill: 'firestore-rules-audit',
      description: 'Minimal fixture',
      prompt: 'Hello',
      successSpec: { name: 'firestore-rules-audit/minimal' },
    };
    expect(validateFixture(minimal).ok).toBe(true);
  });

  test('rejects fixture missing required fields', () => {
    const result = validateFixture({
      id: 'firestore-rules-audit/x',
      skill: 'firestore-rules-audit',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain('description');
      expect(paths).toContain('prompt');
      expect(paths).toContain('successSpec');
    }
  });

  test('rejects malformed id', () => {
    const result = validateFixture({ ...validFixture, id: 'BadID' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'id')).toBe(true);
    }
  });

  test('rejects id missing the skill prefix slash', () => {
    const result = validateFixture({ ...validFixture, id: 'no-slash-here' });
    expect(result.ok).toBe(false);
  });

  test('rejects unknown skill name with helpful enum list', () => {
    const result = validateFixture({ ...validFixture, skill: 'unknown-skill' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const skillError = result.errors.find((e) => e.path === 'skill');
      expect(skillError).toBeDefined();
      expect(skillError?.message).toContain('firestore-rules-audit');
    }
  });

  test('rejects unknown top-level field', () => {
    const result = validateFixture({ ...validFixture, extraField: 'oops' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'extraField')).toBe(true);
    }
  });

  test('rejects malformed successSpec.name', () => {
    const result = validateFixture({
      ...validFixture,
      successSpec: { name: 'NotKebab' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'successSpec.name')).toBe(true);
    }
  });

  test('rejects malformed initialState field type', () => {
    const result = validateFixture({
      ...validFixture,
      initialState: { rules: 42 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'initialState.rules')).toBe(true);
    }
  });

  test('rejects unknown field inside initialState', () => {
    const result = validateFixture({
      ...validFixture,
      initialState: { rules: 'ok', extraThing: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'initialState.extraThing')).toBe(true);
    }
  });

  test('accepts null stitch sub-fields', () => {
    const result = validateFixture({
      ...validFixture,
      initialState: { stitch: { projectId: null, latestScreenUrl: null, brief: null } },
    });
    expect(result.ok).toBe(true);
  });

  test('rejects non-object input', () => {
    expect(validateFixture(null).ok).toBe(false);
    expect(validateFixture('string').ok).toBe(false);
    expect(validateFixture([]).ok).toBe(false);
    expect(validateFixture(42).ok).toBe(false);
  });
});

describe('parseFixture', () => {
  test('round-trips a valid fixture from JSON', () => {
    const json = JSON.stringify(validFixture);
    const result = parseFixture(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fixture.id).toBe(validFixture.id);
    }
  });

  test('returns error on malformed JSON', () => {
    const result = parseFixture('{ not valid json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toContain('JSON');
    }
  });
});

describe('applyWorkspaceOverrides', () => {
  test('applies overrides on top of base', () => {
    const merged = applyWorkspaceOverrides(EMPTY_WORKSPACE, { rules: 'override-rules' });
    expect(merged.rules).toBe('override-rules');
    expect(merged.code).toBe('');
  });

  test('returns base when no overrides given', () => {
    const merged = applyWorkspaceOverrides(EMPTY_WORKSPACE, undefined);
    expect(merged).toBe(EMPTY_WORKSPACE);
  });

  test('merges stitch sub-fields without mutating base', () => {
    const merged = applyWorkspaceOverrides(EMPTY_WORKSPACE, {
      stitch: { projectId: 'p1' },
    });
    expect(merged.stitch.projectId).toBe('p1');
    expect(merged.stitch.latestScreenUrl).toBeNull();
    expect(EMPTY_WORKSPACE.stitch.projectId).toBeNull();
  });
});

describe('SKILL_NAMES', () => {
  test('contains the nine in-scope skills', () => {
    expect(SKILL_NAMES.length).toBe(9);
    expect(SKILL_NAMES).toContain('firestore-rules-audit');
    expect(SKILL_NAMES).toContain('firebase-client-sdk');
    expect(SKILL_NAMES).toContain('playground-prompts');
  });
});
