/**
 * Site-side wiring for the OpenRouter "Connect" flow (PKCE). The library
 * (`@inbrowser/model`) provides the crypto + exchange primitives; this module
 * owns the browser policy the library deliberately leaves to the app: where to
 * stash the verifier, the full-page redirect, and consuming `?code=` on return.
 */
import { beginOpenRouterOAuth, completeOpenRouterOAuth } from '@inbrowser/model';

// The PKCE verifier must survive the redirect to OpenRouter and back.
// sessionStorage (not localStorage): scoped to this tab, gone when it closes.
const VERIFIER_KEY = 'inbrowser-openrouter-pkce-verifier';

/**
 * Start the flow: mint a PKCE challenge, stash the verifier, and redirect the
 * page to OpenRouter. The user returns to the SAME page (path preserved) with
 * `?code=` appended.
 */
export async function connectOpenRouter(): Promise<void> {
  // Return the user to the exact page they started on. OpenRouter allows a
  // path on an https:443 (or localhost) callback.
  const callbackUrl = window.location.origin + window.location.pathname;
  const { authUrl, codeVerifier } = await beginOpenRouterOAuth({ callbackUrl });
  try {
    sessionStorage.setItem(VERIFIER_KEY, codeVerifier);
  } catch {
    /* private mode: the exchange will simply fail cleanly on return */
  }
  window.location.assign(authUrl);
}

export type OpenRouterCallbackResult =
  | { status: 'none' }
  | { status: 'ok'; key: string }
  | { status: 'error'; message: string };

function stripCode(params: URLSearchParams): void {
  params.delete('code');
  const query = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
}

function clearVerifier(): void {
  try {
    sessionStorage.removeItem(VERIFIER_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * If the page loaded with an OpenRouter `?code=` (and we have the stashed
 * verifier from `connectOpenRouter`), exchange it for a key.
 *
 * Returns a discriminated result so the caller can tell "nothing to consume"
 * from "exchange failed" and surface an error. The verifier + `?code=` are torn
 * down only AFTER the (fallible) exchange resolves — not before — so a reload
 * mid-request can still retry, and a definite failure leaves nothing stale to
 * replay. Recovery from a failure is a fresh `connectOpenRouter()`.
 */
export async function consumeOpenRouterCallback(): Promise<OpenRouterCallbackResult> {
  if (typeof window === 'undefined') return { status: 'none' };
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return { status: 'none' };

  let codeVerifier: string | null = null;
  try {
    codeVerifier = sessionStorage.getItem(VERIFIER_KEY);
  } catch {
    /* ignore */
  }
  // No verifier: a foreign/replayed code, or storage was cleared. Strip the
  // code so it can't linger; there is nothing of ours to exchange.
  if (!codeVerifier) {
    stripCode(params);
    return { status: 'none' };
  }

  try {
    const { key } = await completeOpenRouterOAuth({ code, codeVerifier });
    clearVerifier();
    stripCode(params);
    return { status: 'ok', key };
  } catch (e) {
    clearVerifier();
    stripCode(params);
    return {
      status: 'error',
      message: e instanceof Error ? e.message : 'OpenRouter sign-in failed',
    };
  }
}
