/**
 * `ProjectContext` — credential bundle Firebase-aware agents (rules
 * audits, scripted deploys, hosted-app tooling) need to talk to a
 * live project. The agent runtime stays Firebase-agnostic at the
 * type level: `getFirestore()` is typed as `unknown` so the agent
 * package has no `firebase-admin` dependency. Host packages that
 * supply a ProjectContext narrow the return type at the call site
 * via a cast (`ctx.getFirestore() as Firestore`).
 */

export interface ProjectContext {
  readonly projectId: string;
  resolveToken(): Promise<string>;
  /** Returns the host's `firebase-admin/firestore` Firestore (or
   *  equivalent). Typed `unknown` to keep agent runtime free of a
   *  firebase-admin dep; callers cast at the use site. */
  getFirestore(): unknown;
}
