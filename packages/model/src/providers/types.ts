/**
 * Shared config + factory types for the cloud providers.
 *
 * relay supports BYOK (a per-request API key) plus routing, so a
 * *pre-built* `ModelClient` can't carry a per-request key. Each cloud
 * provider is therefore a FACTORY: construction settings (apiKey / model
 * / baseUrl) come in the config; per-call settings (messages / tools /
 * sampling) come in the `ModelRequest` at `.chat()` time.
 *
 * relay's `providers` map is `Record<string, ModelClientFactory>`; the
 * producer calls `factory({ apiKey: body.apiKey, model: body.model })`
 * per request, then drives `.chat(modelRequest, signal)`.
 */
import type { ModelClient } from '../contract.js';

/**
 * Construction config common to every cloud provider.
 *   - `apiKey`      — BYOK key (Gemini x-goog-api-key,
 *                     OpenRouter/Anthropic bearer/x-api-key); ignored by
 *                     claude-cli/claude-code's subscription paths;
 *                     carries the base URL for Ollama when `baseUrl` is
 *                     unset.
 *   - `model`       — the upstream model id.
 *   - `baseUrl`     — optional override (Ollama's server URL).
 *   - `temperature` — optional construction-time default applied when a
 *                     request omits its own `temperature`. Lets a caller
 *                     pin a sampling default (e.g. the docs agent's 0.2)
 *                     without threading it through every `ModelRequest`.
 *                     A per-request `temperature` always wins. The relay
 *                     never sets this, so its providers keep "send
 *                     temperature only when the client did" semantics.
 */
export interface CloudProviderConfig {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
}

/**
 * The shape relay's `providers` map holds. relay constructs one
 * `ModelClient` per request from `{ apiKey: body.apiKey, model:
 * body.model }`. Providers may accept a wider config (e.g.
 * `ClaudeCliOptions`), but the relay-facing call only ever supplies
 * `apiKey` + `model` — every provider's config makes those the only
 * required fields.
 */
export type ModelClientFactory = (config: { apiKey?: string; model: string }) => ModelClient;
