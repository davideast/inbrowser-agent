import type { ModelClient } from '../contract.js';
import {
  type OaiGatewayAttribution,
  makeOaiClient,
  oaiGatewayAttributionHeaders,
  toOaiTools,
} from './oai-compat.js';
import type { CloudProviderConfig } from './types.js';

const ENDPOINT = 'https://router.requesty.ai/v1/chat/completions';

/** Construction config for the Requesty provider. */
export interface RequestyConfig extends CloudProviderConfig {
  appAttribution?: OaiGatewayAttribution;
}

export { toOaiTools };

/**
 * Build a Requesty `ModelClient`.
 *
 * Requesty speaks the OpenAI chat-completions stream plus OpenRouter-compatible
 * gateway extensions for final cost telemetry and streamed reasoning summaries.
 */
export function requestyModelClient(config: RequestyConfig): ModelClient {
  return makeOaiClient({
    id: `requesty:${config.model}`,
    endpoint: ENDPOINT,
    model: config.model,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...oaiGatewayAttributionHeaders(config.appAttribution),
    },
    errorLabel: 'Requesty',
    idPrefix: 'rq',
    temperatureDefault: config.temperature,
    includeUsage: true,
    reasoningMode: 'openrouter-compatible',
    thinkingDeltaFields: ['reasoning', 'reasoning_content'],
  });
}
