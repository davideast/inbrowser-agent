/**
 * `Workspace` — the user-authored half of the playground's state.
 *
 * Pure data. Immutable updates via the `WorkspaceTransitions`
 * functions; no I/O, no React, no `localStorage`. Persistence is the
 * host's job (Zustand in the React IDE, in-memory in the CLI).
 *
 * Distinct from `RuntimeState` (`./runtime.ts`), which holds what the
 * agent's tools have produced — separate concerns, separate types.
 */

export interface Workspace {
  /** Identifier of the active preset (e.g. "chess", "lobby", "owner"). */
  presetId: string;
  /** Firestore rules source the user / agent is currently editing. */
  rules: string;
  /** JavaScript code source for the agent's `runCode` tool. */
  code: string;
  /** TSX source for the App-panel rendered preview. */
  appSource: string;
  /** Stitch design context — orthogonal to rules/code/app, but session-scoped. */
  stitch: StitchContext;
}

export interface StitchContext {
  projectId: string | null;
  latestScreenUrl: string | null;
  brief: string | null;
}

export const EMPTY_WORKSPACE: Workspace = Object.freeze({
  presetId: '',
  rules: '',
  code: '',
  appSource: '',
  stitch: Object.freeze({ projectId: null, latestScreenUrl: null, brief: null }) as StitchContext,
}) as Workspace;
