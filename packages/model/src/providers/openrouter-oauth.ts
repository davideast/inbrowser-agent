/**
 * OpenRouter OAuth (PKCE) — a browser-first "Connect OpenRouter" flow. Lets a
 * backend-less app obtain a user-controlled, revocable OpenRouter API key
 * without the user pasting a raw key.
 *
 * Two primitives; the app owns the redirect/popup, storage, and routing:
 *
 *   1. `beginOpenRouterOAuth({ callbackUrl })` -> `{ authUrl, codeVerifier }`
 *      Persist `codeVerifier` (e.g. sessionStorage), then send the user to
 *      `authUrl` (full-page redirect or popup).
 *   2. On return, OpenRouter appends `?code=<code>` to the callback URL. Call
 *      `completeOpenRouterOAuth({ code, codeVerifier })` -> `{ key, userId }`.
 *      Feed `key` to `openrouterModelClient({ apiKey: key })`.
 *
 * Fully client-side: PKCE means no client secret, and the implementation uses
 * only WebCrypto + `fetch`, so it runs in the browser with no backend (and is
 * import-safe in Node). The key still lives wherever the app stores it — this
 * provisions and exchanges it; it does not persist anything itself.
 *
 * OpenRouter constrains the callback URL to https on port 443 or 3000, or
 * localhost on any port.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai';

export interface BeginOpenRouterOAuthOpts {
  /**
   * Where OpenRouter returns the user with `?code=`. Must be https on port 443
   * or 3000, or localhost on any port. A path is allowed (e.g. to return the
   * user to the exact page they started from).
   */
  callbackUrl: string;
  /** Override the OpenRouter origin (for testing). Default `https://openrouter.ai`. */
  baseUrl?: string;
}

export interface OpenRouterOAuthStart {
  /** Send the user here (full-page redirect or popup) to authorize. */
  authUrl: string;
  /** The PKCE verifier. Persist it across the redirect and pass it to `complete`. */
  codeVerifier: string;
}

export interface CompleteOpenRouterOAuthOpts {
  /** The `code` query param OpenRouter appended to the callback URL. */
  code: string;
  /** The verifier returned by `beginOpenRouterOAuth`. */
  codeVerifier: string;
  /** Override the OpenRouter origin (for testing). Default `https://openrouter.ai`. */
  baseUrl?: string;
  /** Optional abort signal for the exchange request. */
  signal?: AbortSignal;
}

export interface OpenRouterOAuthResult {
  /** The user-controlled API key (`sk-or-v1-...`). Feed to `openrouterModelClient`. */
  key: string;
  /** The OpenRouter user id associated with the key, or null. */
  userId: string | null;
}

/** base64url (RFC 4648, no padding) of a byte array. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

/** A cryptographically-random PKCE code verifier (43-char base64url, 256 bits). */
function randomCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

const trimSlashes = (url: string) => url.replace(/\/+$/, '');

/**
 * Step 1 of the PKCE flow: mint a verifier + S256 challenge and build the
 * OpenRouter authorization URL. Persist the returned `codeVerifier` (it must
 * survive the redirect), then navigate the user to `authUrl`.
 */
export async function beginOpenRouterOAuth(
  opts: BeginOpenRouterOAuthOpts,
): Promise<OpenRouterOAuthStart> {
  const baseUrl = trimSlashes(opts.baseUrl ?? DEFAULT_BASE_URL);
  const codeVerifier = randomCodeVerifier();
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));
  const params = new URLSearchParams({
    callback_url: opts.callbackUrl,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { authUrl: `${baseUrl}/auth?${params.toString()}`, codeVerifier };
}

/**
 * Step 2 of the PKCE flow: exchange the `code` (from the callback) plus the
 * stored `codeVerifier` for a user-controlled API key. Throws on a non-OK
 * response or a missing key so callers can surface a clear error.
 */
export async function completeOpenRouterOAuth(
  opts: CompleteOpenRouterOAuthOpts,
): Promise<OpenRouterOAuthResult> {
  const baseUrl = trimSlashes(opts.baseUrl ?? DEFAULT_BASE_URL);
  const res = await fetch(`${baseUrl}/api/v1/auth/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: opts.code,
      code_verifier: opts.codeVerifier,
      code_challenge_method: 'S256',
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `OpenRouter OAuth exchange failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    );
  }
  const json = (await res.json()) as { key?: string; user_id?: string | null };
  if (!json.key) throw new Error('OpenRouter OAuth exchange returned no key');
  return { key: json.key, userId: json.user_id ?? null };
}
