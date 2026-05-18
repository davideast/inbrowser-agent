/**
 * Static catalog of skill workflows.
 *
 * Phase five of the implementation plan splits the planner-executor work
 * into three branches: this catalog, the router that classifies a user
 * prompt against the catalog, and the executor that walks a chosen
 * skill's prescribed step sequence. This module is the data + types
 * gate — no runtime logic. The router reads `triggerHints` to score
 * candidate matches; the executor reads `steps` to materialize a plan.
 *
 * Each entry's `name` matches a value in the `SkillName` enum from
 * `eval/fixture.ts` (re-exported here for convenience). Step
 * descriptions are imperative, short, and model-agnostic. Per-step
 * `verifier?` references existing starter / custom specs where one
 * fits naturally; not every step has one. Leaf "compile / deploy /
 * verify" steps tend to have a spec; intermediate read / draft steps
 * usually don't.
 *
 * The catalog is hand-authored and intentionally `const`. The
 * companion test in `test/skill-catalog.test.ts` asserts shape
 * invariants: every `name` is in `SKILL_NAMES`, every entry has at
 * least three trigger hints, every entry has between four and nine
 * steps, every step id is unique and kebab-case within its plan, and
 * every `verifier?.name` matches a spec registered by
 * `registerAllSpecs(createSpecRegistry())`.
 */

import type { SkillName, SuccessSpecReference } from './eval/fixture.js';
import {
  SPEC_FINAL_RULES_INCLUDES_LITERAL,
  SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK,
  SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
  SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
  SPEC_REPORT_MENTIONS_ALL_OF,
  SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
  SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
} from './eval/spec-helpers.js';

/**
 * One ordered step in a skill's prescribed workflow.
 *
 * `id` is a stable kebab-case identifier, unique within the parent
 * plan. The executor uses it as the scratch key for the step's
 * bounded sub-loop. `description` is an imperative one-liner — what
 * the step does, in the project's voice. `verifier?` is an optional
 * `SuccessSpecReference` the executor can run after the step finishes
 * to gate whether the plan advances; the same shape that fixtures
 * use, so the executor can re-use `evaluateSpec` without translation.
 */
export interface PlanStep {
  /** Stable kebab-case id, unique within the plan. */
  id: string;
  /** Short imperative description of what the step does. */
  description: string;
  /** Optional reference to a success spec that verifies this step. */
  verifier?: SuccessSpecReference;
}

/**
 * One row in the skill catalog. Describes a single skill workflow as
 * a triple of (router signals, plan, identity).
 */
export interface SkillCatalogEntry {
  /** Matches a value in `SKILL_NAMES` from `eval/fixture.ts`. */
  name: SkillName;
  /** One-line description used by the router and surfaced in the plan. */
  description: string;
  /**
   * Lowercase keyword tokens the router scans the user prompt for.
   * Order does not matter; at least one hit signals a candidate match.
   */
  triggerHints: readonly string[];
  /** Prescribed workflow as an ordered sequence of steps. */
  steps: readonly PlanStep[];
}

/** Read-only view over the catalog. */
export type SkillCatalog = readonly SkillCatalogEntry[];

// ---------------------------------------------------------------------------
// The catalog. One entry per in-scope skill, in `SKILL_NAMES` order.
// Step content is derived from each skill's `SKILL.md` playbook in the
// downstream firebase-agent-sdk repo.
// ---------------------------------------------------------------------------

export const SKILL_CATALOG: SkillCatalog = [
  {
    name: 'firestore-rules-audit',
    description:
      'Audit Firestore security rules for vulnerabilities, semantic errors, and structural anti-patterns.',
    triggerHints: ['firestore', 'audit', 'rules', 'security', 'vulnerability', 'review'],
    steps: [
      {
        id: 'inspect-rules',
        description: 'Fetch deployed Firestore rules, parse to AST, and run validator checks.',
      },
      {
        id: 'triage-findings',
        description: 'Group validator findings by severity: critical, high, medium, low.',
      },
      {
        id: 'cross-reference',
        description: 'Combine findings on the same path to surface compound vulnerabilities.',
      },
      {
        id: 'apply-context',
        description: 'Escalate or de-escalate findings based on path purpose and data sensitivity.',
      },
      {
        id: 'compile-report',
        description: 'Compile prioritized health report with score, findings, and remediation.',
        verifier: {
          name: SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
          args: { tokens: ['critical', 'high', 'finding'] },
        },
      },
    ],
  },
  {
    name: 'firebase-project-audit',
    description:
      'Audit an unknown Firebase project for auth gaps, rule weaknesses, and structural issues across services.',
    triggerHints: ['firebase', 'project', 'audit', 'inspect', 'health', 'unknown'],
    steps: [
      {
        id: 'inspect-project',
        description: 'Inspect auth, rules, and database structure in a single crawl.',
      },
      {
        id: 'assess-auth',
        description: 'Evaluate enabled providers and surface auth configuration gaps.',
      },
      {
        id: 'assess-rules',
        description: 'Walk the rule tree and flag open paths, broken expressions, and warnings.',
      },
      {
        id: 'assess-structure',
        description: 'Walk the data structure for deep nesting, god nodes, and array patterns.',
      },
      {
        id: 'cross-reference-rules-data',
        description:
          'Compare rule paths against data paths to find unprotected data and orphan rules.',
      },
      {
        id: 'compile-report',
        description:
          'Compile prioritized report with health score, findings, and recommended skills to load.',
        verifier: {
          name: SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
          args: { tokens: ['health', 'finding', 'recommendation'] },
        },
      },
    ],
  },
  {
    name: 'rtdb-data-modeling',
    description:
      'Analyze and recommend Realtime Database structures with flat collections, fan-out writes, and index tables.',
    triggerHints: [
      'rtdb',
      'realtime',
      'data',
      'model',
      'modeling',
      'denormalize',
      'structure',
      'schema',
    ],
    steps: [
      {
        id: 'crawl-structure',
        description:
          'Crawl database structure to inventory top-level keys, depth, and child counts.',
      },
      {
        id: 'sample-data',
        description: 'Read representative paths to compare stored shape against per-screen needs.',
      },
      {
        id: 'check-god-nodes',
        description: 'Identify unbounded lists and god nodes that grow without per-user scoping.',
      },
      {
        id: 'evaluate-queries',
        description:
          'Map each app list to a single orderBy path and flag multi-field filter needs.',
      },
      {
        id: 'propose-restructure',
        description:
          'Propose flat collections, index tables, and summary collections via fan-out writes.',
      },
      {
        id: 'verify-restructure',
        description:
          'Validate the proposed shape with a multi-path write and a re-crawl of the structure.',
        verifier: {
          name: SPEC_TRACE_CONTAINS_TOOL_CALL_BY_NAME,
          args: { tool: 'crawl_database_structure', minCount: 1 },
        },
      },
    ],
  },
  {
    name: 'firebase-security-rules',
    description:
      'Author, simulate, and deploy Realtime Database security rules with auth, validation, and immutability patterns.',
    triggerHints: ['rtdb', 'realtime', 'rules', 'security', 'authz', 'access', 'validate'],
    steps: [
      {
        id: 'inspect-current-rules',
        description: 'Inspect deployed rules and read linter warnings on existing expressions.',
      },
      {
        id: 'design-change',
        description:
          'Identify the rule changes required by the request or by prior audit findings.',
      },
      {
        id: 'validate-expressions',
        description: 'Build and validate each rule expression before assembling the ruleset IR.',
      },
      {
        id: 'simulate-access',
        description:
          'Simulate positive, negative, cross-user, and validation scenarios against the draft rules.',
      },
      {
        id: 'deploy-rules',
        description: 'Deploy the full ruleset after every simulation passes.',
        verifier: {
          name: SPEC_FINAL_RULES_INCLUDES_LITERAL,
          args: { literal: 'auth' },
        },
      },
      {
        id: 'verify-deployment',
        description: 'Re-inspect the deployed rules to confirm they match the intended IR.',
      },
    ],
  },
  {
    name: 'firebase-client-sdk',
    description:
      'Generate correct Firebase web client code for init, auth gating, listeners, fan-out writes, and queries.',
    triggerHints: ['client', 'sdk', 'web', 'javascript', 'app', 'listener', 'init'],
    steps: [
      {
        id: 'get-config',
        description: 'Fetch the project client config for initializeApp.',
      },
      {
        id: 'inspect-rules-for-auth',
        description: 'Inspect deployed rules to determine the auth state the client must satisfy.',
      },
      {
        id: 'check-indexes',
        description: 'Verify indexOn declarations cover every planned orderByChild query.',
      },
      {
        id: 'generate-init-and-auth',
        description: 'Emit initialization, the auth gate, and the sign-in flow.',
      },
      {
        id: 'generate-reads',
        description: 'Emit entity listeners, fan-in patterns, or one-time reads as needed.',
      },
      {
        id: 'generate-writes',
        description: 'Emit set, update at path, and multi-location update writes per intent.',
      },
      {
        id: 'add-cleanup-and-errors',
        description: 'Add listener unsubscription and permission-denied error handling.',
      },
      {
        id: 'verify-run',
        description: 'Run the generated code once and confirm the run summary reports success.',
        verifier: { name: SPEC_FINAL_RUNTIME_RUN_SUMMARY_OK },
      },
    ],
  },
  {
    name: 'pyric-agents',
    description:
      'Author Firestore rules and seed data through the pyric MCP tools with lint gating and reversible commits.',
    triggerHints: ['pyric', 'firestore', 'rules', 'seed', 'lint', 'mcp'],
    steps: [
      {
        id: 'draft-rules',
        description: 'Draft the Firestore rules source in conversation.',
      },
      {
        id: 'lint-rules',
        description: 'Lint the draft and iterate until errors are empty.',
      },
      {
        id: 'write-rules',
        description: 'Write the lint-clean rules through the gated write tool.',
      },
      {
        id: 'draft-seed',
        description: 'Compose seed data as collection-to-documents arrays.',
      },
      {
        id: 'write-seed',
        description: 'Write the shape-validated seed through the gated write tool.',
        verifier: {
          name: SPEC_PYRIC_AGENTS_LINT_CLEAN_AND_RULE_REJECTS_CHEAT,
        },
      },
      {
        id: 'surface-audit-log',
        description: 'Point the user at the emitted plan and commit event ids.',
      },
    ],
  },
  {
    name: 'playground-prompts',
    description:
      'Generate well-shaped 30-50 word playground prompts with a bounded domain and a rule-enforced security boundary.',
    triggerHints: ['playground', 'prompt', 'prompts', 'demo', 'test', 'scenario'],
    steps: [
      {
        id: 'pick-dimension',
        description:
          'Pick the capability dimension to exercise (rules, transactions, queries, listeners).',
      },
      {
        id: 'pick-domain',
        description: 'Pick a bounded familiar domain with two collections and a relationship.',
      },
      {
        id: 'specify-security-boundary',
        description: 'Specify a security boundary tedious to enforce in client code alone.',
      },
      {
        id: 'draft-prompt',
        description: 'Draft a 30-50 word prompt that fills in actors, data model, and constraint.',
      },
      {
        id: 'tag-capabilities',
        description: 'Tag what the prompt exercises so the consumer can pick by capability.',
        verifier: {
          name: SPEC_REPORT_MENTIONS_AT_LEAST_ONE_OF,
          args: { tokens: ['exercises', 'capability', 'rules', 'state', 'membership'] },
        },
      },
    ],
  },
  {
    name: 'rtdb-game-rules',
    description:
      'Design and deploy Realtime Database security rules for turn-based games with turn guards and win checks.',
    triggerHints: ['rtdb', 'realtime', 'game', 'turn', 'multiplayer', 'rules'],
    steps: [
      {
        id: 'identify-players',
        description: 'Identify players, their marks, and how they map to authenticated UIDs.',
      },
      {
        id: 'design-turn-flow',
        description: 'Design the turn marker, alternation order, and turn-guard write rule.',
      },
      {
        id: 'design-board-and-moves',
        description: 'Design the board layout, move protocol, and per-cell validation.',
      },
      {
        id: 'design-win-and-end',
        description: 'Design win helpers, terminal states, and the winner validation rule.',
      },
      {
        id: 'compose-ruleset',
        description: 'Compose the full ruleset from turnGuard, flip, winCheckHelper, and helpers.',
      },
      {
        id: 'simulate-and-deploy',
        description: 'Simulate positive and cheating moves, then deploy the ruleset.',
        verifier: {
          name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
          args: { database: 'rtdb' },
        },
      },
    ],
  },
  {
    name: 'firestore-game-rules',
    description:
      'Design and deploy Firestore security rules for turn-based games with split-allow rules and dynamic field keys.',
    triggerHints: ['firestore', 'game', 'turn', 'multiplayer', 'rules', 'split-allow'],
    steps: [
      {
        id: 'design-board',
        description: 'Design a flat board map with statically named cell fields.',
      },
      {
        id: 'design-turns',
        description: 'Design turn enforcement with resource.data and a turn-flip validation.',
      },
      {
        id: 'design-move-validity',
        description:
          'Design placement or movement validity with dynamic field keys or a config document.',
      },
      {
        id: 'design-win-detection',
        description: 'Enumerate winning lines or piece-counter wins as static expressions.',
      },
      {
        id: 'split-allow-rules',
        description:
          'Split the update rule into normal-move, winning-move, and draw branches to stay under the complexity ceiling.',
      },
      {
        id: 'generate-and-deploy',
        description: 'Generate the rules via code, deploy them, and verify under the test API.',
        verifier: {
          name: SPEC_GAME_RULES_SIMULATOR_ACCEPTS_POSITIVE_AND_REJECTS_CHEAT,
          args: { database: 'firestore' },
        },
      },
      {
        id: 'iterate-on-complexity',
        description:
          'If valid moves are denied, re-split the rules and move expensive checks into separate allow branches.',
        verifier: {
          name: SPEC_REPORT_MENTIONS_ALL_OF,
          args: { tokens: ['allow', 'update'] },
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers. The router and executor will read the catalog through these to
// keep their implementations narrow; the catalog itself is exported as a
// value so callers can iterate without going through them.
// ---------------------------------------------------------------------------

const ENTRY_BY_NAME: ReadonlyMap<SkillName, SkillCatalogEntry> = new Map(
  SKILL_CATALOG.map((entry) => [entry.name, entry]),
);

const NAMES: readonly SkillName[] = SKILL_CATALOG.map((entry) => entry.name);

/**
 * Look up a catalog entry by skill name. Returns `undefined` when the
 * name is not in the catalog. The router will use this to materialize
 * an entry after picking a winner; the executor will use it to
 * unwrap a router decision into a plan.
 */
export function getSkillEntry(name: SkillName): SkillCatalogEntry | undefined {
  return ENTRY_BY_NAME.get(name);
}

/**
 * List every skill name present in the catalog, in catalog order. The
 * router uses this to iterate candidates when scoring a prompt; the
 * test suite uses it to assert the catalog covers every value in
 * `SKILL_NAMES`.
 */
export function listSkillNames(): readonly SkillName[] {
  return NAMES;
}
