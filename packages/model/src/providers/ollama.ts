import type { ModelClient } from '../contract.js';
import { makeOaiClient, resolveBaseUrl } from './oai-compat.js';
import type { CloudProviderConfig } from './types.js';
/**
 * Ollama provider — a preset over the shared OpenAI-compatible core
 * (`./oai-compat`). Talks to a locally-running Ollama server's
 * OAI-compatible endpoint (`${baseUrl}/v1/chat/completions`). Default
 * baseUrl is `http://localhost:11434`. The caller passes their own via
 * `config.baseUrl`; the relay passes it through `config.apiKey` (the
 * playground's BYOK slot for Ollama is `kind: 'baseUrl'`; its `getKey()`
 * returns the user-configured URL or the default), so the provider reads
 * `config.baseUrl ?? config.apiKey`.
 *
 * Two Ollama-specific traits the core is configured for:
 *   - No `Authorization` header (Ollama doesn't authenticate). The base
 *     URL — not a key — rides in the `apiKey` slot, so we must NOT route
 *     it to a Bearer header; that's why this delegates to `makeOaiClient`
 *     directly instead of the generic `openaiCompatModelClient`.
 *   - Token counts arrive in the final usage chunk's `prompt_tokens` /
 *     `completion_tokens`, which Ollama's OAI endpoint reports.
 *
 * CORS: Ollama doesn't set CORS headers by default. Browser-side users
 * must run Ollama with `OLLAMA_ORIGINS` set to allow the playground
 * origin (typically `*` for local development). The playground surfaces
 * this warning inline in its BYOK form.
 */

const DEFAULT_BASE_URL = 'http://localhost:11434';

/** Construction config for the Ollama provider. `baseUrl` overrides the
 *  Ollama server URL; the relay passes the URL via `apiKey` instead. */
export interface OllamaConfig extends CloudProviderConfig {}

// Re-exported so existing imports (`import { toOaiTools } from
// './providers/ollama'`) and the package root's `toOllamaTools` alias
// keep resolving after the core extraction.
export { toOaiTools } from './oai-compat.js';

/**
 * Build an Ollama `ModelClient`. The server base URL comes from
 * `config.baseUrl ?? config.apiKey` (relay routes it via apiKey; direct
 * callers pass baseUrl); per-call values (messages, tools, sampling) come
 * in the `ModelRequest`.
 */
export function ollamaModelClient(config: OllamaConfig): ModelClient {
  const base = resolveBaseUrl(config.baseUrl ?? config.apiKey, DEFAULT_BASE_URL);
  return makeOaiClient({
    id: `ollama:${config.model}`,
    endpoint: `${base}/v1/chat/completions`,
    model: config.model,
    headers: {},
    errorLabel: 'Ollama',
    idPrefix: 'oll',
    temperatureDefault: config.temperature,
    // Browser fetch can't cleanly distinguish "not running" from "CORS
    // blocked"; surface a hint that covers both.
    connectHint: (b) =>
      `Confirm \`ollama serve\` is running at ${b} and that OLLAMA_ORIGINS permits this origin.`,
  });
}
