# How to implement a custom `LlmClient`

This guide shows you how to plug an upstream LLM API into `@inbrowser/agent` so a
session can stream from it.

A session drives the model through one narrow interface: `LlmClient`. You
implement `chat()` as an async generator that calls your provider and maps its
stream to `ChatEvent`s. For the full event and usage shapes, see the
[`LlmClient` reference](../reference/library.md).

## Choose your path

You have two ways to expose a provider:

- If your provider already speaks the streamed-event shape, implement `LlmClient`
  directly. Start at [Implement `chat()`](#implement-chat).
- If your provider exposes callbacks (`onText`, `onThinking`, `onToolCall`) and
  returns a final result, skip the boilerplate and wrap it with
  `callbackProviderAsLlmClient`. Jump to [Adapt a callback provider](#adapt-a-callback-provider).

## Implement `chat()`

`LlmClient` has three members: a stable `id`, a `supportsTools` flag, and
`chat(req, signal)`. The session passes you a `ChatRequest` (`messages`, `tools`,
`toolUseEnabled`) and an `AbortSignal`, and expects an `AsyncIterable<ChatEvent>`
back.

Implement `chat()` as an async generator. Call your upstream, map each fragment
to a `ChatEvent`, and finish with one `turn_complete` carrying usage:

```ts
import type {
  ChatEvent,
  ChatRequest,
  LlmClient,
  LlmConfig,
} from '@inbrowser/agent';

export function createMyClient(config: LlmConfig): LlmClient {
  return {
    id: `my-provider:${config.model}`,
    supportsTools: true,
    async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const response = await fetch('https://my-provider.invalid/v1/chat', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages: req.messages,
          tools: req.toolUseEnabled ? req.tools : undefined,
        }),
        signal,
      });

      if (!response.ok) {
        yield { kind: 'error', message: `my-provider ${response.status}` };
        return;
      }

      for await (const part of readUpstream(response)) {
        if (signal.aborted) return;

        if (part.reasoning) yield { kind: 'thinking', chunk: part.reasoning };
        if (part.text) yield { kind: 'text', chunk: part.text };
        if (part.toolCall) {
          yield {
            kind: 'tool_call',
            id: part.toolCall.id,
            name: part.toolCall.name,
            args: part.toolCall.args,
          };
        }
      }

      yield {
        kind: 'turn_complete',
        usage: {
          promptTokens: response.headers.get('x-prompt-tokens') ? Number(response.headers.get('x-prompt-tokens')) : 0,
          completionTokens: 0,
        },
        details: { requestedModel: config.model },
      };
    },
  };
}
```

`readUpstream` is your provider-specific stream parser. It owns the upstream
protocol and nothing else.

## Honour the abort signal

The session aborts mid-turn when the user cancels or a strategy stops. Check
`signal.aborted` between fragments and `return` early, and pass `signal` to
`fetch` so the socket itself is torn down. Do not throw on abort - just stop
yielding.

## Emit tool calls only when arguments are complete

If your provider streams tool-call arguments in fragments, accumulate them and
yield one `tool_call` event after the call closes:

```ts
let buffer = '';
buffer += part.toolArgsFragment;

// once the upstream marks the call complete:
yield {
  kind: 'tool_call',
  id: part.callId,
  name: part.toolName,
  args: JSON.parse(buffer),
};
```

If `JSON.parse` fails, yield a structured fallback such as `{ _raw: buffer }`
rather than dropping the call.

## Report errors

If you want the error to reach the session as a normal stream event, yield
`{ kind: 'error', message }` and `return`. Reserve `throw` for cases where the
client itself cannot continue.

## Adapt a callback provider

If your provider already exposes `onText` / `onThinking` / `onToolCall`
callbacks and resolves a `ProviderTurnResult`, wrap it instead of writing a
generator. `callbackProviderAsLlmClient` buffers the callbacks into a
`ChatEvent` stream and appends the final `turn_complete` for you:

```ts
import { callbackProviderAsLlmClient } from '@inbrowser/agent';

const client = callbackProviderAsLlmClient(myCallbackProvider, 'my-provider');
```

Your provider must satisfy the `CallbackProvider` surface: a `label`, an `ask()`
for plain chat, and an optional `chatWithTools()` for tool turns. The adapter
derives `supportsTools` from `provider.supportsTools` (or the presence of
`chatWithTools`). See the [`CallbackProvider` reference](../reference/library.md#callbackproviderasllmclient)
for the exact method signatures.

## Use the client in a session

Pass the client as the session's `llm`:

```ts
import { createAgentSession, createReactLoopStrategy } from '@inbrowser/agent';

const session = createAgentSession({
  strategy: createReactLoopStrategy(),
  llm: createMyClient({ model: 'my-model-pro', apiKey: process.env.MY_API_KEY }),
  // ...tools, toolContext, metrics, history, id, systemPromptBuilder
});
```

The session consumes whatever you yield. For the `RawUsage` and `TurnDetails`
fields `turn_complete` carries (and how the metrics collector interprets them),
see the [`LlmClient` reference](../reference/library.md).
