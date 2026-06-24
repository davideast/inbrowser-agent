import type { ModelClient } from '../contract.js';
import {
  type OaiGatewayAttribution,
  makeOaiClient,
  oaiGatewayAttributionHeaders,
  toOaiTools,
} from './oai-compat.js';
import type { CloudProviderConfig } from './types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Construction config for the OpenRouter provider. */
export interface OpenRouterConfig extends CloudProviderConfig {
  appAttribution?: OaiGatewayAttribution;
}

export { toOaiTools };

/**
 * Build an OpenRouter `ModelClient`.
 *
 * OpenRouter speaks the OpenAI chat-completions stream plus gateway extensions
 * for final cost telemetry and streamed reasoning summaries.
 */
export function openrouterModelClient(config: OpenRouterConfig): ModelClient {
  return makeOaiClient({
    id: `openrouter:${config.model}`,
    endpoint: ENDPOINT,
    model: config.model,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...oaiGatewayAttributionHeaders(config.appAttribution),
    },
    errorLabel: 'OpenRouter',
    idPrefix: 'or',
    temperatureDefault: config.temperature,
    includeUsage: true,
    reasoningMode: 'openrouter-compatible',
    thinkingDeltaFields: ['reasoning', 'reasoning_content'],
  });
}
