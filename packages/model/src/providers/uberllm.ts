import type { ModelClient } from '../contract.js';
import {
  type OaiGatewayAttribution,
  makeOaiClient,
  oaiGatewayAttributionHeaders,
  toOaiTools,
} from './oai-compat.js';
import type { CloudProviderConfig } from './types.js';

const ENDPOINT = 'https://api.uberllm.dev/v1/chat/completions';

/** Construction config for the UberLLM provider. */
export interface UberLLMConfig extends CloudProviderConfig {
  appAttribution?: OaiGatewayAttribution;
}

export { toOaiTools };

/**
 * Build an UberLLM `ModelClient`.
 *
 * UberLLM speaks the OpenAI chat-completions stream with `vendor/model` ids
 * plus the OpenRouter-compatible `reasoning` request field and streamed
 * `reasoning` / `reasoning_content` deltas.
 */
export function uberllmModelClient(config: UberLLMConfig): ModelClient {
  return makeOaiClient({
    id: `uberllm:${config.model}`,
    endpoint: ENDPOINT,
    model: config.model,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...oaiGatewayAttributionHeaders(config.appAttribution),
    },
    errorLabel: 'UberLLM',
    idPrefix: 'ull',
    temperatureDefault: config.temperature,
    includeUsage: true,
    reasoningMode: 'openrouter-compatible',
    thinkingDeltaFields: ['reasoning', 'reasoning_content'],
  });
}
