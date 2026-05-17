/**
 * `TokenProvider` — pluggable auth for the RTDB REST client.
 *
 * RTDB REST has a quirk that ruled out the metadata-server token path:
 * it rejects a plain `cloud-platform` token (401 "Unauthorized
 * request") and needs a token minted with the
 * `firebase.database` + `userinfo.email` scopes specifically. Cloud
 * Run's metadata server ignores `?scopes=` for the runtime SA and
 * hands back `cloud-platform` regardless, so the production path is
 * to mint a JWT-bearer access token from the service account
 * directly. `serviceAccountTokenProvider` does that.
 *
 * For tests + bring-your-own-auth scenarios, `staticTokenProvider`
 * wraps a pre-minted token; the consumer can refresh it externally.
 */
export interface TokenProvider {
  /**
   * Return a valid OAuth bearer token for RTDB REST. Implementations
   * SHOULD cache and refresh internally — `getToken()` is called on
   * every store request.
   */
  getToken(): Promise<string>;
}

/** Wraps a fixed token. Useful for tests with a pre-minted token. */
export function staticTokenProvider(token: string): TokenProvider {
  return { getToken: async () => token };
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
];

export interface ServiceAccountTokenProviderOpts {
  /** Path to the service-account JSON. Mutually exclusive with `keyJson`. */
  keyFile?: string;
  /** Parsed service-account JSON. Mutually exclusive with `keyFile`. */
  keyJson?: ServiceAccount;
  /**
   * OAuth scopes to request. Defaults to the RTDB REST minimum:
   * `firebase.database` + `userinfo.email`. Anything else needs an
   * explicit list — `cloud-platform` alone is insufficient.
   */
  scopes?: string[];
  /**
   * How many ms before expiry the cached token is considered stale.
   * Default 60_000 (1 minute) — refresh before the SA-minted token
   * hits its 3600s wall.
   */
  refreshSkewMs?: number;
}

/**
 * Mints a JWT-bearer access token from a service account. Caches
 * until `expires_in - refreshSkewMs`. Pure `fetch` + Node `crypto` —
 * no `firebase-admin` dependency.
 */
export function serviceAccountTokenProvider(opts: ServiceAccountTokenProviderOpts): TokenProvider {
  if (!opts.keyFile && !opts.keyJson) {
    throw new Error('serviceAccountTokenProvider: must supply `keyFile` OR `keyJson`');
  }
  const refreshSkewMs = opts.refreshSkewMs ?? 60_000;
  const scopes = (opts.scopes ?? DEFAULT_SCOPES).join(' ');
  let cached: { token: string; expiresAt: number } | null = null;
  let sa: ServiceAccount | null = opts.keyJson ?? null;

  async function loadSa(): Promise<ServiceAccount> {
    if (sa) return sa;
    const { readFile } = await import('node:fs/promises');
    sa = JSON.parse(await readFile(opts.keyFile!, 'utf-8')) as ServiceAccount;
    return sa;
  }

  return {
    async getToken(): Promise<string> {
      if (cached && cached.expiresAt > Date.now() + refreshSkewMs) {
        return cached.token;
      }
      cached = await mint(await loadSa(), scopes);
      return cached.token;
    },
  };
}

async function mint(
  sa: ServiceAccount,
  scopes: string,
): Promise<{ token: string; expiresAt: number }> {
  const { createSign } = await import('node:crypto');
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: scopes,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const jwt = `${signingInput}.${signer.sign(sa.private_key).toString('base64url')}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `serviceAccountTokenProvider: token exchange failed (${res.status}): ${(
        await res.text()
      ).slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}
