/**
 * Task fixture schema for the eval harness.
 *
 * A `TaskFixture` describes one reproducible evaluation case: a user
 * prompt, an initial workspace state, and a reference to the success
 * specification that decides whether a run passed.
 *
 * This file is browser-safe — types, `validateFixture`, `parseFixture`,
 * `applyWorkspaceOverrides` only. File loading lives in
 * `eval/load-node.ts` and is re-exported via `@inbrowser/agent/node`.
 *
 * Example fixture (JSON):
 *
 *     {
 *       "id": "firestore-rules-audit/seed-open-write-01",
 *       "skill": "firestore-rules-audit",
 *       "description": "Detects open-write vulnerability on /users",
 *       "prompt": "Audit my Firestore rules for security issues.",
 *       "initialState": {
 *         "rules": "rules_version='2'; ..."
 *       },
 *       "successSpec": {
 *         "name": "firestore-rules-audit/names-planted-vulnerability",
 *         "args": { "vulnerability": "open-write-users" }
 *       }
 *     }
 */

import type { StitchContext, Workspace } from '../types/workspace.js';

export type SkillName =
  | 'firestore-rules-audit'
  | 'firebase-project-audit'
  | 'rtdb-data-modeling'
  | 'firebase-security-rules'
  | 'firebase-client-sdk'
  | 'pyric-agents'
  | 'playground-prompts'
  | 'rtdb-game-rules'
  | 'firestore-game-rules';

export const SKILL_NAMES: readonly SkillName[] = [
  'firestore-rules-audit',
  'firebase-project-audit',
  'rtdb-data-modeling',
  'firebase-security-rules',
  'firebase-client-sdk',
  'pyric-agents',
  'playground-prompts',
  'rtdb-game-rules',
  'firestore-game-rules',
];

export interface PartialWorkspace {
  presetId?: string;
  rules?: string;
  code?: string;
  appSource?: string;
  stitch?: Partial<StitchContext>;
}

export interface SuccessSpecReference {
  /** Stable spec identifier in `family/spec-name` kebab-case form. */
  name: string;
  /** Optional structured arguments passed when the spec runs. */
  args?: Record<string, unknown>;
}

export interface TaskFixture {
  /** Stable identifier in `skill-prefix/case-name` kebab-case form. */
  id: string;
  /** The skill family this fixture exercises. */
  skill: SkillName;
  /** One-line human summary; shown in comparison reports. */
  description: string;
  /** Optional free-form prose; ignored by tooling. */
  notes?: string;
  /** The user prompt, verbatim. */
  prompt: string;
  /** Optional initial workspace state, applied on top of EMPTY_WORKSPACE. */
  initialState?: PartialWorkspace;
  /** Reference to the success spec that decides this fixture's pass/fail. */
  successSpec: SuccessSpecReference;
}

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; fixture: TaskFixture }
  | { ok: false; errors: ValidationError[] };

const ID_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const SPEC_NAME_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const SKILL_NAME_SET: ReadonlySet<string> = new Set(SKILL_NAMES);

const FIXTURE_KEYS = new Set([
  'id',
  'skill',
  'description',
  'notes',
  'prompt',
  'initialState',
  'successSpec',
]);
const INITIAL_STATE_KEYS = new Set(['presetId', 'rules', 'code', 'appSource', 'stitch']);
const STITCH_KEYS = new Set(['projectId', 'latestScreenUrl', 'brief']);
const SPEC_KEYS = new Set(['name', 'args']);

export function validateFixture(input: unknown): ValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'fixture must be a plain object' }] };
  }
  const obj = input;
  const errors: ValidationError[] = [];

  requireString(obj, 'id', errors, (value) => {
    if (!ID_PATTERN.test(value)) {
      errors.push({
        path: 'id',
        message:
          'id must match `skill-prefix/case-name` kebab-case (e.g., "firestore-rules-audit/seed-01")',
      });
    }
  });

  requireString(obj, 'skill', errors, (value) => {
    if (!SKILL_NAME_SET.has(value)) {
      errors.push({
        path: 'skill',
        message: `skill must be one of: ${SKILL_NAMES.join(', ')}`,
      });
    }
  });

  requireString(obj, 'description', errors);
  optionalString(obj, 'notes', errors);
  requireString(obj, 'prompt', errors);

  if (obj.initialState !== undefined) {
    validateInitialState(obj.initialState, 'initialState', errors);
  }

  if (obj.successSpec === undefined) {
    errors.push({ path: 'successSpec', message: 'successSpec is required' });
  } else {
    validateSpecRef(obj.successSpec, 'successSpec', errors);
  }

  for (const key of Object.keys(obj)) {
    if (!FIXTURE_KEYS.has(key)) {
      errors.push({ path: key, message: `unknown field "${key}"` });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, fixture: obj as unknown as TaskFixture };
}

export function parseFixture(json: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON';
    return { ok: false, errors: [{ path: '', message: `failed to parse JSON: ${message}` }] };
  }
  return validateFixture(parsed);
}

export function applyWorkspaceOverrides(
  base: Workspace,
  overrides: PartialWorkspace | undefined,
): Workspace {
  if (!overrides) return base;
  return {
    presetId: overrides.presetId ?? base.presetId,
    rules: overrides.rules ?? base.rules,
    code: overrides.code ?? base.code,
    appSource: overrides.appSource ?? base.appSource,
    stitch: {
      projectId: overrides.stitch?.projectId ?? base.stitch.projectId,
      latestScreenUrl: overrides.stitch?.latestScreenUrl ?? base.stitch.latestScreenUrl,
      brief: overrides.stitch?.brief ?? base.stitch.brief,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
  onValid?: (value: string) => void,
): void {
  const value = obj[key];
  if (value === undefined) {
    errors.push({ path: key, message: `${key} is required` });
    return;
  }
  if (typeof value !== 'string') {
    errors.push({ path: key, message: `${key} must be a string` });
    return;
  }
  if (value.length === 0) {
    errors.push({ path: key, message: `${key} must not be empty` });
    return;
  }
  if (onValid) onValid(value);
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
): void {
  const value = obj[key];
  if (value === undefined) return;
  if (typeof value !== 'string') {
    errors.push({ path: key, message: `${key} must be a string when present` });
  }
}

function validateInitialState(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(value)) {
    errors.push({ path, message: `${path} must be an object` });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!INITIAL_STATE_KEYS.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `unknown field "${key}"` });
    }
  }
  for (const key of ['presetId', 'rules', 'code', 'appSource'] as const) {
    const v = value[key];
    if (v !== undefined && typeof v !== 'string') {
      errors.push({
        path: `${path}.${key}`,
        message: `${path}.${key} must be a string when present`,
      });
    }
  }
  if (value.stitch !== undefined) {
    validateStitchOverrides(value.stitch, `${path}.stitch`, errors);
  }
}

function validateStitchOverrides(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(value)) {
    errors.push({ path, message: `${path} must be an object when present` });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!STITCH_KEYS.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `unknown field "${key}"` });
    }
  }
  for (const key of ['projectId', 'latestScreenUrl', 'brief'] as const) {
    const v = value[key];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      errors.push({
        path: `${path}.${key}`,
        message: `${path}.${key} must be a string or null when present`,
      });
    }
  }
}

function validateSpecRef(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(value)) {
    errors.push({ path, message: `${path} must be an object` });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!SPEC_KEYS.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `unknown field "${key}"` });
    }
  }
  if (typeof value.name !== 'string') {
    errors.push({ path: `${path}.name`, message: `${path}.name must be a string` });
  } else if (!SPEC_NAME_PATTERN.test(value.name)) {
    errors.push({
      path: `${path}.name`,
      message: `${path}.name must match \`family/spec-name\` kebab-case`,
    });
  }
  if (value.args !== undefined && !isPlainObject(value.args)) {
    errors.push({ path: `${path}.args`, message: `${path}.args must be an object when present` });
  }
}
