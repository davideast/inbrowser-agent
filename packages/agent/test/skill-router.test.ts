/**
 * Unit tests for the keyword-based skill router.
 *
 * Covers the scenarios called out in the kickoff brief:
 *   - a clear hit on a prompt whose hints match exactly one skill
 *   - tie-break by name-in-prompt when two skills score equally
 *   - threshold filtering (no match when score is below threshold)
 *   - empty prompt returns no match but a full ranking
 *   - a custom catalog override routes against the supplied entries
 *
 * The accuracy harness against the golden fixtures lives in
 * `skill-router-accuracy.test.ts` — this file stays narrow on
 * algorithm correctness so failures here are easier to localize.
 */

import { describe, expect, test } from 'bun:test';
import type { SkillCatalog, SkillCatalogEntry } from '../src/skill-catalog.js';
import { routeSkill } from '../src/skill-router.js';

describe('routeSkill — clear hit', () => {
  test('routes an unambiguous Firestore audit prompt to firestore-rules-audit', () => {
    const decision = routeSkill('Audit my Firestore rules for security issues.');
    expect(decision.match).not.toBeNull();
    expect(decision.match?.skill).toBe('firestore-rules-audit');
    expect(decision.match?.score).toBeGreaterThanOrEqual(1);
  });

  test('ranking is sorted descending by score', () => {
    const { ranking } = routeSkill('Audit my Firestore rules for security issues.');
    for (let i = 1; i < ranking.length; i++) {
      expect(ranking[i - 1].score).toBeGreaterThanOrEqual(ranking[i].score);
    }
  });

  test('ranking always covers every catalog entry', () => {
    const { ranking } = routeSkill('hello world');
    // The default catalog has 9 entries; the ranking must mirror it.
    expect(ranking.length).toBe(9);
    const skills = new Set(ranking.map((r) => r.skill));
    expect(skills.size).toBe(9);
  });
});

describe('routeSkill — tie-break by name-in-prompt', () => {
  test('a skill whose literal name appears in the prompt wins a score tie', () => {
    const catalog: SkillCatalog = [
      {
        name: 'rtdb-data-modeling',
        description: 'modeling',
        triggerHints: ['model'],
        steps: [
          { id: 'a', description: 'a' },
          { id: 'b', description: 'b' },
          { id: 'c', description: 'c' },
          { id: 'd', description: 'd' },
        ],
      } as SkillCatalogEntry,
      {
        name: 'firestore-rules-audit',
        description: 'audit',
        triggerHints: ['model'],
        steps: [
          { id: 'a', description: 'a' },
          { id: 'b', description: 'b' },
          { id: 'c', description: 'c' },
          { id: 'd', description: 'd' },
        ],
      } as SkillCatalogEntry,
    ];

    // Both entries' single triggerHint ("model") matches the prompt,
    // so the scores tie at 1. The literal name `firestore-rules-audit`
    // appears in the prompt (with whitespace-to-dash normalization).
    // It should win the tie-break.
    const decision = routeSkill('how should I model my firestore rules audit data', { catalog });
    expect(decision.match?.skill).toBe('firestore-rules-audit');
    expect(decision.match?.score).toBe(1);
  });

  test('the kebab-case form of the name also disambiguates', () => {
    const catalog: SkillCatalog = [
      {
        name: 'rtdb-data-modeling',
        description: 'modeling',
        triggerHints: ['model'],
        steps: [
          { id: 'a', description: 'a' },
          { id: 'b', description: 'b' },
          { id: 'c', description: 'c' },
          { id: 'd', description: 'd' },
        ],
      } as SkillCatalogEntry,
      {
        name: 'firestore-rules-audit',
        description: 'audit',
        triggerHints: ['model'],
        steps: [
          { id: 'a', description: 'a' },
          { id: 'b', description: 'b' },
          { id: 'c', description: 'c' },
          { id: 'd', description: 'd' },
        ],
      } as SkillCatalogEntry,
    ];

    // Direct kebab-case form in the prompt.
    const decision = routeSkill('please model my firestore-rules-audit', { catalog });
    expect(decision.match?.skill).toBe('firestore-rules-audit');
  });

  test('returns null when scores tie and neither name appears in the prompt', () => {
    const catalog: SkillCatalog = [
      {
        name: 'rtdb-data-modeling',
        description: 'modeling',
        triggerHints: ['frobnicate'],
        steps: [
          { id: 'a', description: 'a' },
          { id: 'b', description: 'b' },
          { id: 'c', description: 'c' },
          { id: 'd', description: 'd' },
        ],
      } as SkillCatalogEntry,
      {
        name: 'pyric-agents',
        description: 'pyric',
        triggerHints: ['frobnicate'],
        steps: [
          { id: 'a', description: 'a' },
          { id: 'b', description: 'b' },
          { id: 'c', description: 'c' },
          { id: 'd', description: 'd' },
        ],
      } as SkillCatalogEntry,
    ];

    // Both score 1, neither name in the prompt — ambiguity guard
    // returns null rather than picking the catalog-order winner.
    const decision = routeSkill('please frobnicate it', { catalog });
    expect(decision.match).toBeNull();
    expect(decision.ranking[0].score).toBe(1);
    expect(decision.ranking[1].score).toBe(1);
  });
});

describe('routeSkill — threshold filtering', () => {
  test('returns match: null when no hint hits clear threshold 1', () => {
    const decision = routeSkill('lorem ipsum dolor sit amet xyzzy');
    expect(decision.match).toBeNull();
    // Ranking still present, all scores zero.
    expect(decision.ranking.length).toBeGreaterThan(0);
    for (const entry of decision.ranking) {
      expect(entry.score).toBe(0);
    }
  });

  test('a custom threshold raises the bar', () => {
    // The audit-flavored prompt below hits 3 hints in the
    // firestore-rules-audit entry: "firestore", "rules", "audit".
    // No other catalog entry has all three, so the match is clean.
    const promptHigh = 'audit my firestore rules for security review';
    const low = routeSkill(promptHigh, { threshold: 2 });
    expect(low.match).not.toBeNull();
    expect(low.match?.skill).toBe('firestore-rules-audit');
    expect(low.match?.score).toBeGreaterThanOrEqual(2);

    const high = routeSkill(promptHigh, { threshold: 99 });
    expect(high.match).toBeNull();
    // Ranking is unaffected by threshold — it always reports raw scores.
    expect(high.ranking.length).toBe(9);
    expect(high.ranking[0].score).toBeGreaterThan(0);
  });

  test('threshold 0 admits a zero-score match (every entry clears the bar)', () => {
    // Threshold 0 is the explicit opt-in for catalog-order pick when
    // no signal is present. The ambiguity guard does not apply here
    // because the brief reserves it for resolving positive-score ties.
    const decision = routeSkill('xyzzy', { threshold: 0 });
    expect(decision.match).not.toBeNull();
    expect(decision.match?.score).toBe(0);
  });
});

describe('routeSkill — empty prompt', () => {
  test('empty prompt returns match: null and full ranking in catalog order', () => {
    const decision = routeSkill('');
    expect(decision.match).toBeNull();
    expect(decision.ranking.length).toBe(9);
    for (const entry of decision.ranking) {
      expect(entry.score).toBe(0);
    }
    // With all scores zero and no name-in-prompt, catalog order
    // should be preserved.
    expect(decision.ranking[0].skill).toBe('firestore-rules-audit');
  });
});

describe('routeSkill — custom catalog override', () => {
  test('routes against the supplied catalog only', () => {
    const catalog: SkillCatalog = [
      {
        name: 'pyric-agents',
        description: 'just pyric',
        triggerHints: ['pyric'],
        steps: [
          { id: 'a', description: 'a' },
          { id: 'b', description: 'b' },
          { id: 'c', description: 'c' },
          { id: 'd', description: 'd' },
        ],
      } as SkillCatalogEntry,
    ];
    const decision = routeSkill('use the pyric tools', { catalog });
    expect(decision.ranking.length).toBe(1);
    expect(decision.match?.skill).toBe('pyric-agents');
  });

  test('an empty catalog produces an empty ranking and no match', () => {
    const decision = routeSkill('audit my firestore rules', { catalog: [] });
    expect(decision.ranking.length).toBe(0);
    expect(decision.match).toBeNull();
  });
});
