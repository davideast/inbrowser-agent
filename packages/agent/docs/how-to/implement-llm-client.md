# How to implement a custom `ModelClient`

This guide shows you how to plug an upstream LLM API into `@inbrowser/agent` so a
session can stream from it.

A session drives the model through one narrow interface: `ModelClient` (the
shared contract from `@inbrowser/model/contract`, re-exported from
`@inbrowser/agent`). You implement `chat()` as an async generator that calls your
provider and maps its stream to `ModelEvent`s. For the full event and usage
shapes, see the [`ModelClient` reference](../reference/library.md).

> Already have a provider? The API-key and subscription providers (Gemini,
> OpenRouter, Anthropic, Ollama, and the Claude CLI/Code bridges) ship as
> `ModelClient` factories in `@inbrowser/model`. Firebase AI Logic instead uses
> `createFirebaseAiLogicModelClient` to wrap a caller-constructed Firebase model.
> Import one and hand it to a session — you only need this guide when wiring an
> API the package does not cover.

## Choose your path

You have two ways to expose a provider:

- If your provider already speaks the streamed-event shape, implement
  `ModelClient` directly. Start at [Implement `chat()`](#implement-chat).
- If your provider exposes callbacks (`onText`, `onThinking`, `onToolCall`) and
  returns a final result, skip the boilerplate and wrap it with
  `callbackProviderAsLlmClient`. Jump to [Adapt a callback provider](#adapt-a-callback-provider).

## Implement `chat()`

`ModelClient` has three members: a stable `id`, a `supportsTools` flag, and
`chat(req, signal)`. The session passes you a `ModelRequest` (`messages`,
`tools`, `toolUseEnabled`, optional sampling fields) and an `AbortSignal`, and
expects an `AsyncIterable<ModelEvent>` back.

Implement `chat()` as an async generator. Call your upstream and map each
fragment to a `ModelEvent`. The turn ends when the iterable returns; emit one
`usage` event carrying final accounting just before you finish. There is no
separate `turn_complete` event:

```ts
import type {
  ModelEvent,
  ModelRequest,
  ModelClient,
  LlmConfig,
} from '@inbrowser/agent';

export function createMyClient(config: LlmConfig): ModelClient {
  return {
    id: `my-provider:${config.model}`,
    supportsTools: true,
    async *chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
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

        if (part.reasoning) yield { kind: 'thinking', text: part.reasoning };
        if (part.text) yield { kind: 'text', text: part.text };
        if (part.toolCall) {
          yield {
            kind: 'tool_call',
            id: part.toolCall.id,
            name: part.toolCall.name,
            args: part.toolCall.args,
          };
        }
      }

      const promptHeader = response.headers.get('x-prompt-tokens');
      yield {
        kind: 'usage',
        usage: {
          promptTokens: promptHeader ? Number(promptHeader) : 0,
          outputTokens: 0,
        },
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
`{ kind: 'error', message }` and `return`. An `error` event is terminal: emit no
`usage` event after it. Reserve `throw` for cases where the client itself cannot
continue.

## Wrap your client in retries (optional)

`@inbrowser/model` ships a `withRetry(client, opts?)` decorator that retries
transient upstream failures while nothing has streamed yet. Wrap any
`ModelClient` to harden it:

```ts
import { withRetry } from '@inbrowser/model';

const client = withRetry(createMyClient({ model: 'my-model-pro', apiKey }));
```

## Adapt a callback provider

If your provider already exposes `onText` / `onThinking` / `onToolCall`
callbacks and resolves a `ProviderTurnResult`, wrap it instead of writing a
generator. `callbackProviderAsLlmClient` buffers the callbacks into a
`ModelEvent` stream and emits the final `usage` event before the iterable
returns for you:

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

The session consumes whatever you yield. For the `ModelUsage` fields the `usage`
event carries (and how the metrics collector interprets them), see the
[`ModelClient` reference](../reference/library.md).
