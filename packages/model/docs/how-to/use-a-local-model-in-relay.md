# How To Use A Local Model In Relay

The relay consumes a [`ModelClient`](../../src/contract.ts), the contract this
package owns. Cloud providers implement it directly. An on-device `Engine`
speaks the narrower `EngineEvent` vocabulary, so wrap it with
`createEngineModelClient` before registering it with the relay.

## A cloud model over the relay (works today)

The relay's `providers` map holds `ModelClientFactory`s — functions that
construct a `ModelClient` per request (so a BYOK key can be threaded in). Import
a cloud provider factory from this package and register it under a key:

```ts
import { geminiModelClient } from '@inbrowser/model/providers/gemini';
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

## A local engine over the relay

Build the engine and wrapper once, then return that `ModelClient` from the
relay's provider factory:

```ts
import {
  createEngine,
  createEngineModelClient,
  qwen3_1_7b,
} from '@inbrowser/model/local';

const engine = createEngine(qwen3_1_7b);
const local = createEngineModelClient(engine);

const relay = createRelay({
  store,
  providers: { local: () => local },
});
```

## What the wrapper translates

For reference, the engine's narrow [`EngineEvent`](../reference/engine.md)
vocabulary differs from the contract's `ModelEvent` in a few ways the wrapper
reconciles:

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
