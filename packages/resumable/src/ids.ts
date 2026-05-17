/**
 * Default job-id generator. Stores accept an optional `generateId`
 * override so tests can pin ids deterministically without monkey-
 * patching globals.
 *
 * `crypto.randomUUID()` is available on every supported runtime
 * (Node 18+, Bun, Deno, browsers with secure context). No polyfill.
 */
export function defaultGenerateId(): string {
  return crypto.randomUUID();
}

export type IdGenerator = () => string;
