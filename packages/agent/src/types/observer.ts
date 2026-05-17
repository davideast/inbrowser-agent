/**
 * `SandboxObserver` — centralized error sink for simulated services.
 *
 * Every site inside `@pyric/sandbox`, `@pyric/admin`,
 * `@pyric/firestore` (sandbox target), `@pyric/storage` (sandbox
 * target) that throws / errors / surfaces denials calls
 * `observer.onEvent({...})` *before* the throw or callback. The
 * structured error returns the SDK already provides are unchanged.
 *
 * Append-only from the sandbox's perspective — emitting an event
 * must never throw, never block, never affect the operation's
 * return value. Pure side-channel.
 *
 * NOTE: this is the agent-layer *host-observer* event — a coarse
 * error-sink shape. It is distinct from `@pyric/sandbox`'s
 * `SandboxEvent` (the substrate-level discriminated union of every
 * evaluated op). The two were briefly name-colliding; this one is
 * `ObserverEvent` to keep them unambiguous. See issue #307.
 */

export interface ObserverEvent {
  kind:
    | 'denial'
    | 'snapshot_error'
    | 'transaction_conflict'
    | 'runtime_error'
    | 'lint_warning';
  timestamp: number;
  /** Stable identifier for the originating operation. */
  operationId?: string;
  /** Path the operation touched. */
  path?: string;
  /** Identity context at the time of the event. */
  auth?: { uid: string | null };
  /** Structured detail — denial reason, error code, message. */
  detail: unknown;
}

export interface SandboxObserver {
  onEvent(event: ObserverEvent): void;
}

/** Compose multiple observers into one. */
export function combineObservers(...observers: SandboxObserver[]): SandboxObserver {
  return {
    onEvent: (event) => {
      for (const o of observers) {
        try {
          o.onEvent(event);
        } catch {
          // Side-channel; never let one observer's bug crash another.
        }
      }
    },
  };
}

/** No-op observer — the default when no host subscribes. */
export const noopObserver: SandboxObserver = Object.freeze({
  onEvent: () => { /* intentionally empty */ },
});
