/**
 * Success-spec framework for the eval harness.
 *
 * A success specification (a "spec") decides whether one captured agent
 * run satisfied its fixture's success criterion. The framework provides
 * three things:
 *
 *   1. A `SpecRegistry` plus an `createSpecRegistry()` factory.
 *      Registration is explicit — no side-effect registration on import.
 *      Callers build a registry, call `registerStarterSpecs()` if they
 *      want the common helpers (see `spec-helpers.ts`), and register
 *      their own specs on top.
 *
 *   2. An `evaluateSpec(registry, reference, snapshot)` evaluator that
 *      looks the spec up by name, awaits it (specs may be async), and
 *      returns a structured `SpecResult`. A thrown error inside the
 *      spec body is caught and converted into `{ ok: false, error }`,
 *      so a misbehaving spec never crashes the harness.
 *
 *   3. The `RunSnapshot` interface — the input every spec consumes.
 *      Intentionally narrower than the runner's eventual `RunRecord`,
 *      so this branch develops independently of `eval/harness-runner`.
 *      The runner's `RunRecord` is designed to be a structural superset:
 *      a runner caller passes its `record` straight to `evaluateSpec`.
 *
 * Specs read three slices of state — the final workspace (rules / code
 * / app source), the final runtime (the most recent run summary, any
 * uiErrors, terminal output, etc.), the full assistant text, and the
 * trace. Anything outside those four fields is a sign the snapshot
 * shape needs widening; do that here, not in spec bodies.
 *
 * Spec names follow the same `family/spec-name` kebab-case form that
 * `validateFixture` enforces on `SuccessSpecReference.name`. Registration
 * validates the name at registration time so typos surface immediately.
 */

import type { RuntimeState } from '../types/runtime.js';
import type { TraceEvent } from '../types/trace.js';
import type { Workspace } from '../types/workspace.js';
import type { SuccessSpecReference } from './fixture.js';

/**
 * Input shape every spec consumes. Intentionally narrower than the
 * runner's eventual `RunRecord` so this branch develops independently
 * of `eval/harness-runner`. The runner's record is designed to be a
 * structural superset; a runner caller can pass its record straight to
 * `evaluateSpec`.
 */
export interface RunSnapshot {
  /** Workspace state at the end of the run. */
  finalWorkspace: Workspace;
  /** Runtime state at the end of the run (run summary, uiErrors, ...). */
  finalRuntime: RuntimeState;
  /** Concatenated assistant text across the run's iterations. */
  assistantText: string;
  /** All trace events emitted during the run, in emission order. */
  trace: readonly TraceEvent[];
}

/**
 * Structured result returned by `evaluateSpec` and by every spec body.
 * `ok` is the pass/fail bit. `detail` is optional structured context a
 * report can surface (matched tokens, missing tokens, the offending
 * trace event id, ...). `error` carries the failure reason when the
 * spec did not run cleanly — registration miss, args validation failure,
 * spec body threw, etc.
 */
export interface SpecResult {
  ok: boolean;
  detail?: Record<string, unknown>;
  error?: string;
}

/**
 * Spec function signature. May be sync or async; the evaluator awaits
 * the return either way. `args` is whatever the fixture supplied in
 * `SuccessSpecReference.args` — typed as `unknown` because every spec
 * declares (and validates) its own arg shape.
 */
export type SpecFn = (snapshot: RunSnapshot, args: unknown) => SpecResult | Promise<SpecResult>;

/**
 * In-memory registry. Backed by a `Map`, exposed as a small object so
 * callers do not depend on Map identity.
 */
export interface SpecRegistry {
  /**
   * Register a spec by name. Throws if the name does not match the
   * required `family/spec-name` kebab-case form, or if the name is
   * already registered. Throws-on-conflict is intentional: silent
   * overwrites mask real bugs and the harness only registers specs at
   * startup, so a throw is observable.
   */
  register(name: string, fn: SpecFn): void;
  /** Returns the registered spec function, or undefined. */
  get(name: string): SpecFn | undefined;
  /** True iff `name` is registered. */
  has(name: string): boolean;
  /** All registered names, in registration order. */
  names(): string[];
}

const SPEC_NAME_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/**
 * Create a fresh, empty spec registry. Callers register specs on it
 * explicitly — `registerStarterSpecs()` is the common starting point
 * for fixtures that reuse the helpers; bespoke specs are registered the
 * same way.
 */
export function createSpecRegistry(): SpecRegistry {
  const specs = new Map<string, SpecFn>();
  return {
    register(name, fn) {
      if (typeof name !== 'string' || !SPEC_NAME_PATTERN.test(name)) {
        throw new Error(
          `spec name must match \`family/spec-name\` kebab-case, got: ${JSON.stringify(name)}`,
        );
      }
      if (specs.has(name)) {
        throw new Error(`spec already registered: ${name}`);
      }
      specs.set(name, fn);
    },
    get(name) {
      return specs.get(name);
    },
    has(name) {
      return specs.has(name);
    },
    names() {
      return Array.from(specs.keys());
    },
  };
}

/**
 * Resolve a `SuccessSpecReference` against a registry and evaluate it
 * over a `RunSnapshot`. Returns a `SpecResult`. Never throws — an
 * unregistered name, a thrown spec body, or a returned non-result is
 * surfaced as `{ ok: false, error }`.
 *
 * Async specs are awaited. Sync specs are returned unchanged.
 */
export async function evaluateSpec(
  registry: SpecRegistry,
  reference: SuccessSpecReference,
  snapshot: RunSnapshot,
): Promise<SpecResult> {
  const fn = registry.get(reference.name);
  if (!fn) {
    return { ok: false, error: `spec not registered: ${reference.name}` };
  }
  try {
    const result = await fn(snapshot, reference.args);
    if (!isSpecResult(result)) {
      return {
        ok: false,
        error: `spec "${reference.name}" returned a non-SpecResult value`,
      };
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `spec "${reference.name}" threw: ${message}` };
  }
}

function isSpecResult(value: unknown): value is SpecResult {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.ok === 'boolean';
}
