/**
 * `defaultGenerateId` must work in an INSECURE context (plain-HTTP,
 * non-localhost) where `crypto.randomUUID` is undefined. Regression for
 * "crypto.randomUUID is not a function" seen on a LAN / Tailscale `.ts.net`
 * dev URL. `crypto.getRandomValues` is not secure-context-gated, so it is the
 * fallback; `Math.random` is the last resort.
 */
import { describe, expect, it } from 'bun:test';
import { defaultGenerateId, uuidv4 } from '../src/ids';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('defaultGenerateId / uuidv4', () => {
  it('returns a v4 UUID on the happy path', () => {
    expect(defaultGenerateId()).toMatch(UUID_RE);
  });

  it('builds a v4 UUID from getRandomValues (insecure context: no randomUUID)', () => {
    expect(uuidv4(globalThis.crypto)).toMatch(UUID_RE);
  });

  it('falls back to Math.random when getRandomValues is absent', () => {
    expect(uuidv4({} as Crypto)).toMatch(UUID_RE);
  });

  it('falls back when crypto is missing entirely', () => {
    expect(uuidv4(undefined)).toMatch(UUID_RE);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => defaultGenerateId()));
    expect(ids.size).toBe(1000);
  });
});
