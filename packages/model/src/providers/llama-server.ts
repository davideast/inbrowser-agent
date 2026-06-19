import type { ModelClient } from '../contract.js';
import { makeOaiClient, resolveBaseUrl } from './oai-compat.js';
import type { CloudProviderConfig } from './types.js';
/**
 * llama.cpp `llama-server` provider — a preset over the shared
 * OpenAI-compatible core (`./oai-compat`). Talks to a locally-running
 * `llama-server`'s OAI endpoint (`${baseUrl}/v1/chat/completions`).
 * Default baseUrl is `http://localhost:8080` (llama-server's default
 * port).
 *
 * llama-server differs from Ollama in two operator-facing ways:
 *   - **Auth is optional.** Started with `--api-key KEY`, the server
 *     expects `Authorization: Bearer KEY`; without it, no auth header is
 *     needed.
 *   - **Tool calling requires `--jinja`.** The server only honors the
 *     OpenAI `tools` array when launched with `--jinja` (so it applies a
 *     tool-aware chat template). Without it, tool_calls never stream back.
 *
 * Auth/URL resolution mirrors Ollama because the relay only hands a
 * provider an `apiKey` slot (no separate baseUrl):
 *   - If `apiKey` looks like an http(s) URL, it's treated as the base URL
 *     (the relay BYOK `kind: 'baseUrl'` path) and no auth header is sent.
 *   - Otherwise `apiKey` is sent as a Bearer token.
 *   - Direct library callers can pass `baseUrl` and `apiKey` (the key)
 *     separately for an authenticated server.
 */

const DEFAULT_BASE_URL = 'http://localhost:8080';

/** Construction config for the llama-server provider. `baseUrl` sets the
 *  server URL; `apiKey` is the optional `--api-key` Bearer token (or, on
 *  the relay path, carries the base URL when it's an http(s) URL). */
export interface LlamaServerConfig extends CloudProviderConfig {}

// Re-exported for parity with the other OAI providers (and so tool-wire
// tests can assert against it).
export { toOaiTools } from './oai-compat.js';

/**
 * Build a `llama-server` `ModelClient`. Construction values (baseUrl,
 * apiKey, model) come in the config; per-call values (messages, tools,
 * sampling) come in the `ModelRequest`.
 */
export function llamaServerModelClient(config: LlamaServerConfig): ModelClient {
  const apiKeyIsUrl = config.apiKey ? /^https?:\/\//.test(config.apiKey) : false;
  const base = resolveBaseUrl(config.baseUrl ?? config.apiKey, DEFAULT_BASE_URL);
  // A non-URL apiKey is the `--api-key` Bearer token; a URL apiKey was
  // just the relay routing the base URL through its only config slot.
  const key = apiKeyIsUrl ? undefined : config.apiKey;
  return makeOaiClient({
    id: `llama:${config.model}`,
    endpoint: `${base}/v1/chat/completions`,
    model: config.model,
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    errorLabel: 'llama-server',
    idPrefix: 'llama',
    temperatureDefault: config.temperature,
    connectHint: (b) =>
      `Confirm llama-server is running at ${b} (start it with --jinja to enable tool calling).`,
  });
}
