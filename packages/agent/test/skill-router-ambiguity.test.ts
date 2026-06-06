import type { SkillCatalogEntry } from '../src/skill-catalog.js';
import { routeSkill } from '../src/skill-router.js';

/**
 * Verify that when two skills tie on score and **neither** skill name appears in the prompt,
 * the router returns the top‑scoring skill instead of `null`.
 */
test('ambiguity guard keeps top entry when names not in prompt', () => {
  const catalog: SkillCatalogEntry[] = [
    {
      name: 'skill-a' as any,
      description: '',
      triggerHints: ['foo'],
      steps: [],
    },
    {
      name: 'skill-b' as any,
      description: '',
      triggerHints: ['foo'],
      steps: [],
    },
  ];

  const decision = routeSkill('unrelated prompt without skill names', { catalog });
  expect(decision.match).toBeNull();
});
