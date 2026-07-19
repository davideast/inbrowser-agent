# Gateway provider reference

OpenRouter and Requesty are OpenAI-compatible gateway providers. Both are built
on the shared OpenAI-compatible client and add gateway-specific defaults for
reasoning, usage, and telemetry.

## Factories

```ts
import { openrouterModelClient } from '@inbrowser/model/providers/openrouter';
import { requestyModelClient } from '@inbrowser/model/providers/requesty';
```

| Factory | Endpoint | Client id |
| --- | --- | --- |
| `openrouterModelClient(config)` | `https://openrouter.ai/api/v1/chat/completions` | `openrouter:${config.model}` |
| `requestyModelClient(config)` | `https://router.requesty.ai/v1/chat/completions` | `requesty:${config.model}` |

Both factories return a `ModelClient`.

## Config

Both providers accept the shared cloud-provider fields:

| Field | Description |
| --- | --- |
| `apiKey` | Bearer token sent to the gateway. |
| `model` | Gateway model id. |
| `reasoningEffort` | `off`, `low`, `medium`, or `high`, when the gateway supports reasoning controls. |

They also accept optional app attribution:

```ts
const client = openrouterModelClient({
  apiKey,
  model: 'openai/gpt-4.1-mini',
  appAttribution: {
    referer: 'https://example.com',
    title: 'Example Builder',
  },
});
```

`appAttribution.referer` becomes `HTTP-Referer`. `appAttribution.title` becomes
`X-Title`. No attribution headers are sent unless you pass them.

## Reasoning controls

Gateway providers use OpenRouter-compatible reasoning fields:

| `reasoningEffort` | Request fields |
| --- | --- |
| `off` | `reasoning: { enabled: false }` |
| `low`, `medium`, `high` | `reasoning: { effort, summary: 'auto' }` and `include_reasoning: true` |

Reasoning stream deltas are surfaced as `ModelEvent` values with
`kind: 'thinking'` when the gateway sends `reasoning` or `reasoning_content`
delta fields.

## Usage telemetry

Both gateway providers request included usage details and preserve provider
telemetry in `ModelUsage`:

| Usage field | Source |
| --- | --- |
| `promptTokens` | `usage.prompt_tokens` |
| `outputTokens` | `usage.completion_tokens` |
| `cachedTokens` | `usage.prompt_tokens_details.cached_tokens` |
| `reasoningTokens` | `usage.completion_tokens_details.reasoning_tokens` |
| `costUsd` | `usage.cost` |

Fields are omitted when the provider does not report them.

## Tool encoding

OpenRouter and Requesty share the same nested OpenAI tool encoding. A
`ToolSpec` becomes:

```ts
{
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}
```

The shared encoding keeps gateway providers aligned when new tool metadata is
added to the model contract.
