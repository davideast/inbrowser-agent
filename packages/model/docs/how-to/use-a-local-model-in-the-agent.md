# How To Use A Local Model In The Agent

An `@inbrowser/agent` session is driven by a
[`ModelClient`](../../src/contract.ts). Cloud providers implement that contract
directly. An on-device `Engine` speaks the narrower `EngineEvent` vocabulary,
so wrap it with `createEngineModelClient` before passing it to the agent.

## A cloud model in a session (works today)

Build a `ModelClient` from a cloud provider factory and pass it as the `llm`
field of `createAgentSession`:

```ts
import { geminiModelClient } from '@inbrowser/model/providers/gemini';
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

## A local engine in a session

```ts
import {
  createEngine,
  createEngineModelClient,
  qwen3_1_7b,
} from '@inbrowser/model/local';

const engine = createEngine(qwen3_1_7b);
const llm = createEngineModelClient(engine);

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

See [run a model in the browser](../tutorials/01-run-a-model-in-the-browser.md).

## Tool use

The wrapper's `supportsTools` mirrors
`engine.capabilities.supportsTools`. A preset that declares `supportsTools:
false` cannot emit native tool calls; the agent runtime can layer its own
prompt-engineered tool-use polyfill over a non-tools client to lift it into a
tool-capable one. That polyfill lives in `@inbrowser/agent`, not here. To get
native tool calls, bind a tools-capable preset (`qwen2_5_coder_1_5b` or
`qwen3_1_7b`); see [how to choose a preset](./choose-a-preset.md).

## What the wrapper translates

The engine's narrow [`EngineEvent`](../reference/engine.md) vocabulary maps onto
the contract's `ModelEvent` as follows:

- `token` becomes the contract's `{ kind: 'text', text }`.
- `thinking` becomes `{ kind: 'thinking', text }`.
- `tool_call` carries `id`, `name`, `args` through.
- the engine's `usage` (`promptTokens`, `outputTokens`, `decodeMs`) becomes a
  terminal `{ kind: 'usage', usage }` `ModelEvent`; the turn ends when the
  iterable returns. There is no `turn_complete` event in the contract.
- `error` is terminal on both sides.
