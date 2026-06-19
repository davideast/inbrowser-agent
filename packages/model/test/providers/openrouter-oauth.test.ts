import { describe, expect, it } from 'bun:test';
import {
  beginOpenRouterOAuth,
  completeOpenRouterOAuth,
} from '../../src/providers/openrouter-oauth';

// Recompute base64url(SHA-256(verifier)) independently to check the challenge.
async function expectedChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('beginOpenRouterOAuth', () => {
  it('builds the auth URL with an S256 challenge derived from the verifier', async () => {
    const { authUrl, codeVerifier } = await beginOpenRouterOAuth({
      callbackUrl: 'https://inbrowser.io/',
    });
    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('callback_url')).toBe('https://inbrowser.io/');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The challenge must be EXACTLY base64url(sha256(verifier)) — RFC 7636 S256.
    expect(url.searchParams.get('code_challenge')).toBe(await expectedChallenge(codeVerifier));
  });

  it('mints a fresh, high-entropy base64url verifier each call', async () => {
    const a = await beginOpenRouterOAuth({ callbackUrl: 'https://inbrowser.io/' });
    const b = await beginOpenRouterOAuth({ callbackUrl: 'https://inbrowser.io/' });
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    // 256 bits -> 43 base64url chars, unreserved set, no padding.
    expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('honors a baseUrl override and trims a trailing slash', async () => {
    const { authUrl } = await beginOpenRouterOAuth({
      callbackUrl: 'http://localhost:4324/',
      baseUrl: 'https://example.test/',
    });
    expect(authUrl.startsWith('https://example.test/auth?')).toBe(true);
  });
});

describe('completeOpenRouterOAuth', () => {
  it('POSTs code + verifier as JSON and returns the key + userId', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ key: 'sk-or-v1-test', user_id: 'user_42' }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const result = await completeOpenRouterOAuth({ code: 'CODE', codeVerifier: 'VER' });
      expect(result).toEqual({ key: 'sk-or-v1-test', userId: 'user_42' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://openrouter.ai/api/v1/auth/keys');
      expect(calls[0].init.method).toBe('POST');
      expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        code: 'CODE',
        code_verifier: 'VER',
        code_challenge_method: 'S256',
      });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('defaults userId to null when the response omits user_id', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ key: 'sk-or-v1-x' }), { status: 200 })) as typeof fetch;
    try {
      expect(await completeOpenRouterOAuth({ code: 'C', codeVerifier: 'V' })).toEqual({
        key: 'sk-or-v1-x',
        userId: null,
      });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws on a non-OK response', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('bad code', { status: 400 })) as typeof fetch;
    try {
      await expect(completeOpenRouterOAuth({ code: 'C', codeVerifier: 'V' })).rejects.toThrow(
        /400/,
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws when the response carries no key', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ user_id: 'u' }), { status: 200 })) as typeof fetch;
    try {
      await expect(completeOpenRouterOAuth({ code: 'C', codeVerifier: 'V' })).rejects.toThrow(
        /no key/,
      );
    } finally {
      globalThis.fetch = orig;
    }
  });
});
