/**
 * Site-side wiring for the OpenRouter "Connect" flow (PKCE). The library
 * (`@inbrowser/model`) provides the crypto + exchange primitives; this module
 * owns the browser policy the library deliberately leaves to the app: the
 * verifier storage, the redirect-or-popup transport, and consuming `?code=`.
 *
 * Two transports share those primitives: `connectOpenRouter` (full-page
 * redirect, paired with `consumeOpenRouterCallback` on return) and
 * `connectOpenRouterPopup` (popup + postMessage, no navigation).
 */
import {
  type OpenRouterOAuthStart,
  beginOpenRouterOAuth,
  completeOpenRouterOAuth,
} from '@inbrowser/model';

// The PKCE verifier must survive the redirect to OpenRouter and back.
// sessionStorage (not localStorage): scoped to this tab, gone when it closes.
const VERIFIER_KEY = 'inbrowser-openrouter-pkce-verifier';

// The dedicated popup callback route (src/pages/oauth/openrouter.astro). The
// popup flow returns here instead of to the current page.
const CALLBACK_PATH = '/oauth/openrouter';

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

export type PopupResult =
  | { status: 'ok'; key: string }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }
  | { status: 'blocked' };

/**
 * Popup variant of the Connect flow: opens OpenRouter in a popup and waits for
 * the callback page to post the `?code=` back via postMessage. The verifier
 * stays in this window's memory (no redirect, no sessionStorage) and the opener
 * never navigates, so the chat stays in place.
 *
 * Returns `blocked` if the browser blocked the popup (the caller can fall back
 * to the full-page `connectOpenRouter`) and `cancelled` if the user closed it.
 */
export async function connectOpenRouterPopup(): Promise<PopupResult> {
  if (typeof window === 'undefined') return { status: 'blocked' };

  // Open synchronously inside the click gesture, BEFORE the async PKCE work, or
  // the popup blocker trips. Point it at the authorize URL once it's ready.
  const popup = window.open('', 'openrouter-oauth', 'width=520,height=720');
  if (!popup) return { status: 'blocked' };

  let start: OpenRouterOAuthStart;
  try {
    start = await beginOpenRouterOAuth({ callbackUrl: window.location.origin + CALLBACK_PATH });
  } catch (e) {
    popup.close();
    return {
      status: 'error',
      message: e instanceof Error ? e.message : 'OpenRouter sign-in failed',
    };
  }
  popup.location.href = start.authUrl;

  // Resolve with the code (callback-page postMessage) or null (user closed it).
  const code = await new Promise<string | null>((resolve) => {
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(poll);
      resolve(value);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; code?: string } | null;
      if (data?.type === 'openrouter-oauth' && data.code) settle(data.code);
    };
    window.addEventListener('message', onMessage);
    // The callback page posts then closes; on seeing the popup closed, give any
    // in-flight message a beat to win before declaring cancellation.
    const poll = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(poll);
      window.setTimeout(() => settle(null), 300);
    }, 400);
  });

  try {
    popup.close();
  } catch {
    /* it already closed itself */
  }
  if (!code) return { status: 'cancelled' };

  try {
    const { key } = await completeOpenRouterOAuth({ code, codeVerifier: start.codeVerifier });
    return { status: 'ok', key };
  } catch (e) {
    return {
      status: 'error',
      message: e instanceof Error ? e.message : 'OpenRouter sign-in failed',
    };
  }
}
