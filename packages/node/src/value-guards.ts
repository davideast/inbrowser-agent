import {
  type FaultDetails,
  type RuntimeErrorKind,
  errorTaxonomy,
  isRuntimeErrorKind,
  runtimeError,
} from './errors';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export type StdioBindings = Array<number | 'inherit' | null>;
export function isFileDescriptor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function isStdioBindings(value: unknown): value is StdioBindings {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    Array.from(value).every(
      (entry) => entry === null || entry === 'inherit' || isFileDescriptor(entry),
    )
  );
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function fault(
  code: string,
  message: string,
  details: FaultDetails = {},
): Error & { code: string } {
  return runtimeError(code, message, details);
}
export interface ErrorRecord {
  name: string;
  message: string;
  code: string;
  errno?: unknown;
  syscall?: unknown;
  path?: unknown;
  dest?: unknown;
  kind?: RuntimeErrorKind;
  limit?: number;
  actual?: number;
}
export function errorRecord(error: unknown): ErrorRecord {
  const e = record(error) ? error : {};
  const serialized: ErrorRecord = {
    name: typeof e.name === 'string' ? e.name : 'Error',
    message: typeof e.message === 'string' ? e.message : String(error),
    code: typeof e.code === 'string' ? e.code : 'EIO',
    errno: e.errno,
    syscall: e.syscall,
    path: e.path,
    dest: e.dest,
  };
  // Taxonomy fields are added only when they exist, so records for errors
  // outside the taxonomy stay byte-identical to the previous wire shape.
  const details = errorTaxonomy(error);
  const kind = details.kind ?? (isRuntimeErrorKind(e.kind) ? e.kind : undefined);
  if (kind !== undefined) serialized.kind = kind;
  const limit = details.limit ?? e.limit;
  const actual = details.actual ?? e.actual;
  if (typeof limit === 'number') serialized.limit = limit;
  if (typeof actual === 'number') serialized.actual = actual;
  return serialized;
}
// Rebuilds a serialized error on the receiving side. A record without a usable
// `kind` - an older peer, or an error outside the taxonomy - becomes a plain
// Error carrying the same fields, exactly as before.
export function reviveError(error: Record<string, unknown>): Error {
  const message = String(error.message);
  const kind = isRuntimeErrorKind(error.kind) ? error.kind : undefined;
  const revived =
    kind === undefined
      ? new Error(message)
      : runtimeError(typeof error.code === 'string' ? error.code : 'EIO', message, {
          kind,
          ...(typeof error.limit === 'number' ? { limit: error.limit } : {}),
          ...(typeof error.actual === 'number' ? { actual: error.actual } : {}),
        });
  // `runtimeError` already placed the taxonomy where this realm keeps it: own
  // fields on a host class, or the guest side table with no own property.
  const fields = Object.fromEntries(
    Object.entries(error).filter(([key]) => key !== 'kind' && key !== 'limit' && key !== 'actual'),
  );
  return Object.assign(revived, fields);
}
export function unwrap(value: unknown): unknown {
  if (!record(value) || typeof value.ok !== 'boolean') throw fault('EPROTO', 'Invalid reply');
  if (!value.ok) {
    if (!record(value.error)) throw fault('EPROTO', 'Invalid error reply');
    throw reviveError(value.error);
  }
  return value.value;
}
