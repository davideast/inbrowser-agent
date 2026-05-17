# How To Write A Provider

Use a custom provider when an upstream LLM API is not covered by the built-in
Gemini, OpenRouter, or Anthropic providers.

## Implement `InferenceProvider`

```ts
import type { InferenceProvider } from '@inbrowser/relay';

export const customProvider: InferenceProvider = async function* (req) {
  const response = await fetch('https://example-llm.invalid/v1/stream', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      temperature: req.temperature,
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    yield {
      kind: 'error',
      message: `Custom provider ${response.status}: ${text.slice(0, 240)}`,
    };
    return;
  }

  yield { kind: 'text', chunk: '...' };
};
```

A provider receives the normalised request and yields provider-agnostic
`InferenceEvent`s. It does not create jobs, write to the store, frame SSE, or
handle browser reconnection.

## Parse SSE Upstreams

If the upstream API streams SSE, use the shared reader:

```ts
import { readSseDataLines } from '@inbrowser/relay/sse';
import type { InferenceProvider } from '@inbrowser/relay';

export const sseProvider: InferenceProvider = async function* (req) {
  const response = await fetch('https://example-llm.invalid/v1/chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: req.model, messages: req.messages }),
    ...(req.signal ? { signal: req.signal } : {}),
  });

  if (!response.ok) {
    yield { kind: 'error', message: `upstream ${response.status}` };
    return;
  }

  for await (const payload of readSseDataLines(response.body)) {
    if (payload === '[DONE]') break;
    if (req.signal?.aborted) return;

    const chunk = JSON.parse(payload) as {
      delta?: { text?: string; reasoning?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    if (chunk.delta?.reasoning) {
      yield { kind: 'thinking', chunk: chunk.delta.reasoning };
    }
    if (chunk.delta?.text) {
      yield { kind: 'text', chunk: chunk.delta.text };
    }
    if (chunk.usage) {
      yield {
        kind: 'usage',
        promptTokens: chunk.usage.input_tokens ?? 0,
        outputTokens: chunk.usage.output_tokens ?? 0,
      };
    }
  }
};
```

## Emit Tool Calls After Arguments Are Complete

Many providers stream tool-call arguments in fragments. Accumulate the
fragments, parse them when complete, and yield one `tool_call` event:

```ts
let args = '';

// Inside your upstream loop:
args += partialArgumentJson;

// After the upstream marks the call complete:
yield {
  kind: 'tool_call',
  callId: upstreamCallId,
  name: upstreamToolName,
  args: JSON.parse(args),
};
```

If parsing fails, prefer yielding a structured fallback such as
`{ _raw: args }` instead of throwing away the call.

## Register The Provider

```ts
import { createRelay } from '@inbrowser/relay';
import { customProvider } from './custom-provider';

const relay = createRelay({
  store,
  providers: {
    custom: customProvider,
  },
});
```

Clients then select it with `provider: 'custom'`.

## Error Handling

Yield `{ kind: 'error', message }` for clean upstream errors that should reach
the client as a normal stream event. Throw only when the provider itself cannot
continue. A thrown error finishes the job with terminal status `error`; a
yielded error is stored in the event log and followed by normal terminal state
when the provider returns.

## Keep Provider Code Narrow

A provider should own only upstream protocol details:

- request shape and headers;
- provider-specific message and tool conversion;
- parsing streamed chunks;
- mapping usage, reasoning, text, tool calls, and errors to
  `InferenceEvent`.

Leave resumability, SSE framing, HTTP adapters, and client replay to the relay.
