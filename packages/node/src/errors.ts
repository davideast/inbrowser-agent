// Host-facing error taxonomy. An embedder must be able to tell "unsupported by
// design" from "limit exceeded" from "channel failed" from "container gone"
// without parsing messages, so every host and kernel error built by `fault()`
// carries a `kind` and, where the code is in the map below, a stable class.
//
// Two deliberate constraints:
//   - `code`, `errno`, `syscall` and message text are unchanged. The taxonomy is
//     additive; a code outside the map still produces a plain Error, as before.
//   - No subclass overrides `name`. Guest programs print these errors and
//     asserted output depends on the Node shape `Error: <message>`, so the
//     inherited name stays `Error` and `kind`/`instanceof` carry the taxonomy.

export type RuntimeErrorKind = 'unsupported' | 'limit' | 'channel' | 'lifecycle';

export interface LimitBounds {
  limit?: number;
  actual?: number;
}
export interface FaultDetails extends LimitBounds {
  kind?: RuntimeErrorKind;
}

export class RuntimeError extends Error {
  readonly code: string;
  readonly kind: RuntimeErrorKind;
  constructor(kind: RuntimeErrorKind, code: string, message: string) {
    super(message);
    this.code = code;
    this.kind = kind;
  }
}

/** Unsupported by design: ENOSYS and explicit not-implemented paths. */
export class UnsupportedError extends RuntimeError {
  constructor(code: string, message: string) {
    super('unsupported', code, message);
  }
}

/** A declared bound was exceeded: E2BIG, capacity, count and byte budgets. */
export class LimitError extends RuntimeError {
  // Declared, never defined: the bound is only present when the raising site
  // knows it, so a serialized record stays minimal and comparable.
  declare limit?: number;
  declare actual?: number;
  constructor(code: string, message: string, bounds: LimitBounds = {}) {
    super('limit', code, message);
    if (typeof bounds.limit === 'number') this.limit = bounds.limit;
    if (typeof bounds.actual === 'number') this.actual = bounds.actual;
  }
}

/** A syscall or RPC channel failed: timeout, poisoned channel, bad protocol. */
export class ChannelError extends RuntimeError {
  constructor(code: string, message: string) {
    super('channel', code, message);
  }
}

/** The owning container, process or worker is gone. */
export class LifecycleError extends RuntimeError {
  constructor(code: string, message: string) {
    super('lifecycle', code, message);
  }
}

// The complete code-to-kind map. Codes absent here keep producing plain Errors,
// including guest-visible Node codes (ERR_INVALID_ARG_TYPE, EINVAL, ENOENT,
// Z_DATA_ERROR) whose shape guest programs depend on. EPIPE is overwhelmingly a
// closed container, process or stream; the one poisoned-channel site passes
// `kind: 'channel'` explicitly.
export const ERROR_KINDS: Readonly<Record<string, RuntimeErrorKind>> = {
  ENOSYS: 'unsupported',
  ENOTSUP: 'unsupported',
  E2BIG: 'limit',
  ENOMEM: 'limit',
  EOVERFLOW: 'limit',
  ETIMEDOUT: 'channel',
  EPROTO: 'channel',
  EPIPE: 'lifecycle',
  ESRCH: 'lifecycle',
  EASSET: 'lifecycle',
};

export function errorKind(code: string): RuntimeErrorKind | undefined {
  return Object.prototype.hasOwnProperty.call(ERROR_KINDS, code) ? ERROR_KINDS[code] : undefined;
}

// Guest realm policy. Process Workers throw these errors into guest programs,
// and Node throws plain Errors there: the conformance harness and guest code
// inspect the prototype and own properties. In the guest realm `runtimeError`
// therefore builds an exact-prototype Error whose only own data property is
// `code`, and keeps the taxonomy in a side table so `errorRecord` still
// serializes `kind` for the host.
let guestRealm = false;
const taxonomy = new WeakMap<object, FaultDetails>();
export function markGuestRealm(): void {
  guestRealm = true;
}
export function isGuestRealm(): boolean {
  return guestRealm;
}
/** Taxonomy for any error: own fields on a host class, or the guest side table. */
export function errorTaxonomy(error: unknown): FaultDetails {
  if (typeof error !== 'object' || error === null) return {};
  if (error instanceof RuntimeError) {
    const bounds = error as LimitBounds;
    return {
      kind: error.kind,
      ...(typeof bounds.limit === 'number' ? { limit: bounds.limit } : {}),
      ...(typeof bounds.actual === 'number' ? { actual: bounds.actual } : {}),
    };
  }
  return taxonomy.get(error) ?? {};
}

export function isRuntimeErrorKind(value: unknown): value is RuntimeErrorKind {
  return (
    value === 'unsupported' || value === 'limit' || value === 'channel' || value === 'lifecycle'
  );
}

/** Builds the taxonomy class for a code, or a plain coded Error outside it. */
export function runtimeError(
  code: string,
  message: string,
  details: FaultDetails = {},
): Error & { code: string } {
  const kind = details.kind ?? errorKind(code);
  if (guestRealm) {
    const error = Object.assign(new Error(message), { code });
    if (kind !== undefined) {
      taxonomy.set(error, {
        kind,
        ...(typeof details.limit === 'number' ? { limit: details.limit } : {}),
        ...(typeof details.actual === 'number' ? { actual: details.actual } : {}),
      });
    }
    return error;
  }
  if (kind === 'unsupported') return new UnsupportedError(code, message);
  if (kind === 'limit') return new LimitError(code, message, details);
  if (kind === 'channel') return new ChannelError(code, message);
  if (kind === 'lifecycle') return new LifecycleError(code, message);
  return Object.assign(new Error(message), { code });
}
