# How To Use A Local Model In The Agent

> **Status: the on-device path into the agent is not wired yet.** An
> `@inbrowser/agent` session is driven by a [`ModelClient`](../../src/contract.ts)
> (the contract this package owns — the agent's old `LlmClient` IS now
> `ModelClient`). The **cloud providers already implement it**, so a Gemini /
> OpenRouter / Anthropic / Ollama / Claude model drives a session today. The
> **on-device engine does not implement `ModelClient` yet**: it streams
> `EngineEvent`, not the contract's `ModelEvent`. The old
> `@inbrowser/model/agent` adapter (`createLocalLlmClient`) and the `LlmClient`
> contract it targeted have been removed. A `createEngineModelClient(engine)`
> wrapper is **planned but not built**. This page records the working path
> (cloud) and what to do with a local engine until the wrapper lands.

## A cloud model in a session (works today)

Build a `ModelClient` from a cloud provider factory and pass it as the `llm`
field of `createAgentSession`:

```ts
import { geminiModelClient } from '@inbrowser/model';
import { createAgentSession } from '@inbrowser/agent';

const llm = geminiModelClient({ apiKey: process.env.GEMINI_KEY, model: 'gemini-3.5-flash' });

const session = createAgentSession({
  llm,
  strategy,
  tools,
  toolList,
  toolContext,
  systemPromptBuilder,
  metrics,
  history: [],
});
```

The session drives the client through `chat(req, signal) →
AsyncIterable<ModelEvent>`. For the rest of the session configuration
(`strategy`, `tools`, `toolList`, `systemPromptBuilder`, and how to run a turn),
see the [agent documentation](../../../agent/README.md).

If you have a callback-style provider rather than a `ModelClient`, the agent
ships `callbackProviderAsLlmClient(provider, id)`, which returns a `ModelClient`
you can pass as `llm`.

## A local engine until the wrapper lands

There is no supported way to pass the on-device engine as a session's `llm`
right now — `llm` must be a `ModelClient`, and the engine is not one yet. Until
`createEngineModelClient(engine)` ships, drive the engine directly via its
`EngineEvent` stream, outside the session:

```ts
import { createEngine, qwen3_1_7b } from '@inbrowser/model';

const engine = createEngine(qwen3_1_7b);
await engine.ensureReady();

for await (const evt of engine.generate([{ role: 'user', text: 'hi' }])) {
  if (evt.kind === 'token') process.stdout.write(evt.text);
}
```

See [run a model in the browser](../tutorials/01-run-a-model-in-the-browser.md).

When the wrapper lands, a local engine will become a `ModelClient` and pass to
`createAgentSession({ llm })` exactly like the cloud example above.

## Tool use, for when the wrapper exists

When it lands, the wrapper's `supportsTools` will mirror
`engine.capabilities.supportsTools`. A preset that declares `supportsTools:
false` cannot emit native tool calls; the agent runtime can layer its own
prompt-engineered tool-use polyfill over a non-tools client to lift it into a
tool-capable one. That polyfill lives in `@inbrowser/agent`, not here. To get
native tool calls, bind a tools-capable preset (`qwen2_5_coder_1_5b` or
`qwen3_1_7b`); see [how to choose a preset](./choose-a-preset.md).

## What the wrapper will have to translate

The engine's narrow [`EngineEvent`](../reference/engine.md) vocabulary maps onto
the contract's `ModelEvent` as follows (the wrapper will do this):

- `token` becomes the contract's `{ kind: 'text', text }`.
- `thinking` becomes `{ kind: 'thinking', text }`.
- `tool_call` carries `id`, `name`, `args` through.
- the engine's `usage` (`promptTokens`, `outputTokens`, `decodeMs`) becomes a
  terminal `{ kind: 'usage', usage }` `ModelEvent`; the turn ends when the
  iterable returns. There is no `turn_complete` event in the contract.
- `error` is terminal on both sides.
