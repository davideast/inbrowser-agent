# How To Use A Local Model In Relay

Serve an on-device engine through `@inbrowser/relay` so the relay's durable storage, SSE wire format, and reconnection treat a local model the same as a cloud provider.

`@inbrowser/relay` is a peer dependency, and the `@inbrowser/model/relay` subpath is the only place `@inbrowser/model` imports from it. Install both.

## Wrap An Engine As A Provider

Build an engine from a preset, then wrap it with `createLocalInferenceProvider`. The result is a relay [`InferenceProvider`](../../../relay/docs/reference.md): the same async-generator contract a Gemini-over-HTTP provider implements.

```ts
import { createEngine } from '@inbrowser/model';
import { qwen3_1_7b } from '@inbrowser/model/presets';
import { createLocalInferenceProvider } from '@inbrowser/model/relay';

const engine = createEngine(qwen3_1_7b);
const local = createLocalInferenceProvider(engine);
```

The engine is bound to a single model at construction, so the provider ignores `NormalizedRequest` fields with no on-device analogue (`apiKey`, `provider`, and `model` routing).

## Register It Under A Provider Key

Add the provider to the `providers` map you pass to `createRelay`. The key is what clients select with `provider:` in their request.

```ts
import { createRelay } from '@inbrowser/relay';

const relay = createRelay({
  store,
  providers: {
    local,
  },
});
```

Clients then run a job against `provider: 'local'`. For wiring the store and the client side of a relay, see [how to wire a web app](../../../relay/docs/how-to-wire-a-web-app.md). For authoring providers in general, see [how to write a provider](../../../relay/docs/how-to-write-a-provider.md).

## Know What The Adapter Widens

The adapter translates the engine's narrow [`EngineEvent`](../reference/engine.md) vocabulary into the relay's wider `InferenceEvent`. The mappings:

- `token` becomes a `text` chunk (`{ kind: 'text', chunk }`).
- `thinking` passes through as `{ kind: 'thinking', chunk }`. The engine only emits `thinking` when you wrapped its stream with `splitThinking` upstream, so if you want a reasoning channel on the wire, compose it before building the engine generator (see [how to handle thinking and tool calls](./handle-thinking-and-tool-calls.md)).
- `tool_call` is rekeyed: the engine's `id` becomes `callId`. `name` and `args` carry through.
- `usage` carries `promptTokens` and `outputTokens`; the engine's `decodeMs` is dropped, since the relay's `usage` event has no such field.
- `error` becomes `{ kind: 'error', message }` and ends the stream.

## Forward Tools Safely

If a request brings tool declarations, the adapter forwards them to the engine in OpenAI function format. The engine itself gates emission on `capabilities.supportsTools`, so passing tools to a non-tools preset is a no-op rather than an error. To actually get tool calls back, bind a tools-capable preset (`qwen2_5_coder_1_5b` or `qwen3_1_7b`); see [how to choose a preset](./choose-a-preset.md).

For the adapter's exact signature and the full `EngineEvent` to `InferenceEvent` table, see [the adapters reference](../reference/adapters-and-worker.md).
