# How To Use A Local Model In The Agent

Drive an on-device engine from an `@inbrowser/agent` session so the agent runtime treats a local model identically to a cloud provider.

`@inbrowser/agent` is a peer dependency, and the `@inbrowser/model/agent` subpath is the only place `@inbrowser/model` imports from it. Install both.

## Wrap An Engine As An LlmClient

Build an engine from a preset, then wrap it with `createLocalLlmClient`. The result is an agent `LlmClient`: `{ id, supportsTools, chat(req, signal) }`. The `id` is yours to choose; `supportsTools` is read straight off `engine.capabilities.supportsTools`.

```ts
import { createEngine } from '@inbrowser/model';
import { qwen3_1_7b } from '@inbrowser/model/presets';
import { createLocalLlmClient } from '@inbrowser/model/agent';

const engine = createEngine(qwen3_1_7b);
const llm = createLocalLlmClient(engine, 'local-qwen3');
```

## Wire It Into A Session

Pass the client as the `llm` field of `createAgentSession`. The session drives it through the same `chat(req, signal) → AsyncIterable<ChatEvent>` surface a cloud client uses.

```ts
import { createAgentSession } from '@inbrowser/agent';

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

For the rest of the session configuration (`strategy`, `tools`, `toolList`, `systemPromptBuilder`, and how to run a turn), see the [agent documentation](../../../agent/README.md).

## Pick A Tools-Capable Preset For Tool Use

If the chosen preset declares `supportsTools: false` and the request enables tool use, the client declines: it yields a single `{ kind: 'error' }` event and stops. So when your session needs tools, bind a tools-capable preset (`qwen2_5_coder_1_5b` or `qwen3_1_7b`); see [how to choose a preset](./choose-a-preset.md).

The runtime can instead layer its own prompt-engineered tool-use polyfill over a non-tools client to lift it into a tool-capable one. That polyfill lives in `@inbrowser/agent`, not here.

## Know What The Adapter Maps

The adapter translates the engine's narrow [`EngineEvent`](../reference/engine.md) vocabulary into the agent's `ChatEvent`:

- `token` becomes a `text` chunk.
- `thinking` passes through (the engine only emits it when you wrapped its stream with `splitThinking` upstream; see [how to handle thinking and tool calls](./handle-thinking-and-tool-calls.md)).
- `tool_call` carries `id`, `name`, and `args` through unchanged.
- `usage` is accumulated and reported once at the end as a `turn_complete` event whose `usage` holds `promptTokens` and `completionTokens`.
- `error` ends the stream.

For the adapter's exact signature, see [the adapters reference](../reference/adapters-and-worker.md).
