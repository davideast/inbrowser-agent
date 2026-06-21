/**
 * Default job-id generator. Stores accept an optional `generateId`
 * override so tests can pin ids deterministically without monkey-
 * patching globals.
 *
 * `crypto.randomUUID()` is the happy path, but it is gated to SECURE
 * CONTEXTS (HTTPS or localhost). On a plain-HTTP, non-localhost origin
 * (a LAN IP, a Tailscale `.ts.net` URL, a self-hosted box) it is
 * `undefined` and throws "crypto.randomUUID is not a function".
 * `crypto.getRandomValues` is NOT secure-context-gated, so fall back to
 * a getRandomValues-based UUIDv4, and to `Math.random` only if even that
 * is unavailable.
 */
export function defaultGenerateId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return uuidv4(c);
}

// Exported for the regression test only; not re-exported from the package
// barrel (index.ts), so it is not part of the public API.
export function uuidv4(c: Crypto | undefined): string {
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type IdGenerator = () => string;
