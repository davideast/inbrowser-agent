# How To Write A Provider

Use a custom provider when an upstream LLM API is not covered by the providers
shipped in `@inbrowser/model` (Gemini, OpenRouter, Anthropic, Ollama, and the
two subscription-backed Claude providers).

A "provider" is a `ModelClient` — the one model-call contract from
`@inbrowser/model`, shared by the cloud providers, the on-device
engine, the relay (transport), and the agent (runtime). A `ModelClient` is
constructed from `{ apiKey, model }` and exposes `chat(req, signal)`, an async
iterable of `ModelEvent`s. The relay registers your provider as a
`ModelClientFactory` — a function that builds the client per request — so the
same client also works page-direct and inside the agent. The provider lives in
your own code (or `@inbrowser/model`); the relay only routes to it.

## Implement A `ModelClient`

```ts
import type {
  ModelClient,
  ModelEvent,
  ModelRequest,
} from '@inbrowser/model';

/** Construction settings come in the config; per-call settings ride the
 *  `ModelRequest`. This factory shape (`{ apiKey?, model }`) is exactly
 *  `ModelClientFactory`, so it registers in `createRelay` directly. */
export function customModelClient(config: { apiKey?: string; model: string }): ModelClient {
  return {
    id: `custom:${config.model}`,
    supportsTools: false,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const response = await fetch('https://example-llm.invalid/v1/stream', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages: req.messages,
          tools: req.tools,
          temperature: req.temperature,
        }),
        signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        yield {
          kind: 'error',
          message: `Custom provider ${response.status}: ${text.slice(0, 240)}`,
        };
        return;
      }

      yield { kind: 'text', text: '...' };
      // On a clean end, emit a final `usage` event before returning.
      yield { kind: 'usage', usage: { promptTokens: 0, outputTokens: 0 } };
    },
  };
}
```

The client converts the `ModelRequest` into the upstream API and yields
provider-agnostic `ModelEvent`s. It does not create jobs, write to the store,
frame SSE, or handle browser reconnection. The turn ends when `chat()` returns;
emit a `usage` event before the return on a normal end (it carries the final
accounting), or a terminal `error` event — consumers rely on exactly one of
those per turn.

## Parse SSE Upstreams

If the upstream API streams SSE, use the shared reader:

```ts
import { readSseDataLines } from '@inbrowser/relay/sse';
import type {
  ModelClient,
  ModelEvent,
  ModelRequest,
} from '@inbrowser/model';

export function sseModelClient(config: { apiKey?: string; model: string }): ModelClient {
  return {
    id: `sse-example:${config.model}`,
    supportsTools: false,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const response = await fetch('https://example-llm.invalid/v1/chat', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: config.model, messages: req.messages }),
        signal,
      });

      if (!response.ok) {
        yield { kind: 'error', message: `upstream ${response.status}` };
        return;
      }

      for await (const payload of readSseDataLines(response.body)) {
        if (payload === '[DONE]') break;
        if (signal.aborted) return;

        const chunk = JSON.parse(payload) as {
          delta?: { text?: string; reasoning?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        if (chunk.delta?.reasoning) {
          yield { kind: 'thinking', text: chunk.delta.reasoning };
        }
        if (chunk.delta?.text) {
          yield { kind: 'text', text: chunk.delta.text };
        }
        if (chunk.usage) {
          yield {
            kind: 'usage',
            usage: {
              promptTokens: chunk.usage.input_tokens ?? 0,
              outputTokens: chunk.usage.output_tokens ?? 0,
            },
          };
        }
      }
    },
  };
}
```

## Emit Tool Calls After Arguments Are Complete

Many providers stream tool-call arguments in fragments. Accumulate the
fragments, parse them when complete, and yield one `tool_call` event:

```ts
let args = '';

// Inside your upstream loop (within `chat()`):
args += partialArgumentJson;

// After the upstream marks the call complete:
yield {
  kind: 'tool_call',
  id: upstreamCallId,
  name: upstreamToolName,
  args: JSON.parse(args),
  // Pass `signature` through when the upstream supplies one (e.g. Gemini 3's
  // `thoughtSignature`) so the call can be replayed faithfully.
};
```

If parsing fails, prefer yielding a structured fallback such as
`{ _raw: args }` instead of throwing away the call.

**Two merge styles, depending on the wire format.** The snippet above
*concatenates* — it fits providers (OpenAI, Anthropic) that stream `args`
as JSON-string fragments. Gemini is different: its
`streamGenerateContent` re-sends the whole, growing `content.parts[]`
every chunk, so each chunk carries the **complete `args` object** (not a
fragment). There you *replace* with the latest non-empty snapshot and
correlate calls by their ordinal position rather than concatenating —
concatenating Gemini's whole objects would corrupt them. See
`@inbrowser/model`'s `src/providers/gemini.ts` for that variant. Match the
merge to the wire: a provider that sends whole objects needs replace; one that
sends fragments needs concatenate.

## Register The Provider

A `ModelClient` factory with config `{ apiKey?, model }` already matches
`ModelClientFactory`, so it registers directly:

```ts
import { createRelay } from '@inbrowser/relay';
import { customModelClient } from './custom-model-client';

const relay = createRelay({
  store,
  providers: {
    custom: customModelClient,
  },
});
```

If your client needs construction options beyond `{ apiKey, model }`, wrap it so
the relay-supplied `{ apiKey, model }` merges with your extras:

```ts
providers: {
  custom: (c) => customModelClient({ ...c, baseUrl: 'https://example-llm.invalid' }),
}
```

Clients then select it with `provider: 'custom'`.

## Error Handling

Yield `{ kind: 'error', message }` for clean upstream errors that should reach
the client as a normal stream event. A yielded `error` is itself terminal: emit
it and `return` without a following `usage` event. Throw only when the client
itself cannot continue — a thrown error finishes the job with terminal status
`error`, while a yielded error is stored in the event log and followed by
normal terminal state when `chat()` returns.

## Keep Provider Code Narrow

A `ModelClient` should own only upstream protocol details:

- request shape and headers;
- provider-specific message and tool conversion;
- parsing streamed chunks;
- mapping usage, reasoning, text, tool calls, and errors to `ModelEvent`.

Leave resumability, SSE framing, HTTP adapters, and client replay to the relay.
