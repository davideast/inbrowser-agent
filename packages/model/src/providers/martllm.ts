import type { ModelClient } from '../contract.js';
import {
  type OaiGatewayAttribution,
  makeOaiClient,
  oaiGatewayAttributionHeaders,
  toOaiTools,
} from './oai-compat.js';
import type { CloudProviderConfig } from './types.js';

const ENDPOINT = 'https://api.martllm.com/v1/chat/completions';

/** Construction config for the MartLLM provider. */
export interface MartLLMConfig extends CloudProviderConfig {
  appAttribution?: OaiGatewayAttribution;
}

export { toOaiTools };

/**
 * Build a MartLLM `ModelClient`.
 *
 * MartLLM speaks the OpenAI chat-completions stream with `vendor/model` ids
 * plus the OpenRouter-compatible `reasoning` request field and streamed
 * `reasoning` / `reasoning_content` deltas.
 */
export function martllmModelClient(config: MartLLMConfig): ModelClient {
  return makeOaiClient({
    id: `martllm:${config.model}`,
    endpoint: ENDPOINT,
    model: config.model,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...oaiGatewayAttributionHeaders(config.appAttribution),
    },
    errorLabel: 'MartLLM',
    idPrefix: 'ull',
    temperatureDefault: config.temperature,
    includeUsage: true,
    reasoningMode: 'openrouter-compatible',
    thinkingDeltaFields: ['reasoning', 'reasoning_content'],
  });
}
