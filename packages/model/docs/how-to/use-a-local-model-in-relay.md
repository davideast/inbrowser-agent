# How To Use A Local Model In Relay

> **Status: the on-device path into the relay is not wired yet.** The relay
> consumes a [`ModelClient`](../../src/contract.ts) (the contract this package
> owns), and the **cloud providers already implement it** — so a Gemini /
> OpenRouter / Anthropic / Ollama model drops into `createRelay` today. The
> **on-device engine does not implement `ModelClient` yet**: it streams
> `EngineEvent`, not the contract's `ModelEvent`. The old
> `@inbrowser/model/relay` adapter (`createLocalInferenceProvider`) and the
> `InferenceProvider` contract it targeted have been removed. A
> `createEngineModelClient(engine)` wrapper that lets a local engine serve over
> the relay is **planned but not built**. This page records both the working
> path (cloud) and what to do with a local engine until the wrapper lands.

## A cloud model over the relay (works today)

The relay's `providers` map holds `ModelClientFactory`s — functions that
construct a `ModelClient` per request (so a BYOK key can be threaded in). Import
a cloud provider factory from this package and register it under a key:

```ts
import { geminiModelClient } from '@inbrowser/model';
import { createRelay } from '@inbrowser/relay';

const relay = createRelay({
  store, // a JobStore<ModelEvent> — see the relay docs
  providers: {
    // Each factory is called per request with `{ apiKey, model }`.
    gemini: ({ apiKey, model }) => geminiModelClient({ apiKey, model }),
  },
  // Server-managed keys (optional): a static string (or a per-request
  // function) so clients don't have to send their own key.
  apiKeys: { gemini: process.env.GEMINI_KEY! },
});
```

Clients then run a job against `provider: 'gemini'`. For wiring the relay's
store and the client side, see the relay's own
[how-to](../../../relay/docs/how-to-wire-a-web-app.md).

## A local engine until the wrapper lands

There is no supported way to register the on-device engine in `createRelay`
right now. Two honest options:

1. **Drive the engine directly**, off to the side of the relay. Build it from a
   preset and consume its `EngineEvent` stream yourself:

   ```ts
   import { createEngine, qwen3_1_7b } from '@inbrowser/model';

   const engine = createEngine(qwen3_1_7b);
   await engine.ensureReady();

   for await (const evt of engine.generate([{ role: 'user', text: 'hi' }])) {
     if (evt.kind === 'token') process.stdout.write(evt.text);
   }
   ```

   See [run a model in the browser](../tutorials/01-run-a-model-in-the-browser.md).

2. **Wait for `createEngineModelClient`.** The planned wrapper will adapt an
   `Engine` to a `ModelClient` — widening `EngineEvent` to the contract's
   `ModelEvent` (e.g. `token` → `{ kind: 'text' }`, the engine's terminal
   `usage` into a `ModelEvent` `usage`) — so that a local engine registers in
   `createRelay({ providers })` exactly like a cloud factory. When it ships, the
   shape will mirror the cloud example above.

## What the wrapper will have to translate

For reference, the engine's narrow [`EngineEvent`](../reference/engine.md)
vocabulary differs from the contract's `ModelEvent` in a few ways the wrapper
will reconcile:

- `token` carries `text`; the contract's `text` event carries `text` too, so
  this is a straight rename of the `kind`.
- `thinking` maps to the contract's `thinking` event.
- `tool_call` carries `id`, `name`, `args` on both sides.
- the engine's `usage` carries `promptTokens`, `outputTokens`, `decodeMs`; the
  contract's `usage` carries a `ModelUsage` (`promptTokens`, `outputTokens`, and
  optional cost/cached fields). `decodeMs` has no contract home.
- `error` is terminal on both sides.

The engine gates `tool_call` emission on `capabilities.supportsTools`, so a
non-tools preset simply never emits them. To get tool calls back, bind a
tools-capable preset (`qwen2_5_coder_1_5b` or `qwen3_1_7b`); see
[how to choose a preset](./choose-a-preset.md).
