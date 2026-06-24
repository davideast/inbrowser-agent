# Agent context for `@inbrowser/model`

## Purpose

The model layer. Two halves:

1. **Contract + cloud providers.** `src/contract.ts` defines the one
   `ModelClient` contract the whole stack shares (relay + agent both
   consume it). `src/providers/*` are the cloud providers (Gemini,
   OpenRouter, Requesty, Anthropic, Ollama, Claude-CLI, Claude-Code), each a
   factory returning a `ModelClient`. `src/with-retry.ts` decorates one.
2. **On-device engine.** Wraps `@huggingface/transformers` behind a
   narrow `Engine` surface (`src/engine.ts`) that streams `EngineEvent`.

The engine is also a `ModelClient`, via `createEngineModelClient`
(`src/engine-client.ts`; exported from the root + the
`@inbrowser/model/engine-client` subpath). It wraps an `Engine`,
widening the engine's `EngineEvent` stream to the contract's
`ModelEvent`. The old engine→relay/agent adapter subpaths were removed;
this single wrapper replaces them. (The site's in-browser docs-chat
toggle that drives a local engine through the agent is a separate,
still-forthcoming piece — the adapter is the building block it needs.)

## Layering invariants

- `src/contract.ts` is type-only (zero runtime imports) so importing the
  contract never pulls in the engine or `@huggingface/transformers`.
- `src/types.ts` is the canonical engine type surface. Engine-side files
  import engine types from here.
- `src/engine.ts` is the only module that holds runtime model state.
- Each `src/providers/<name>.ts` is self-contained: it imports the
  contract types and emits `ModelEvent`s. Providers do not import the
  relay or the agent — the dependency points inward (relay/agent depend
  on this package's contract, never the reverse).
- `src/worker.ts` returns the same `Engine` shape `createEngine`
  returns. Consumers must not need to know which side of `postMessage`
  the engine lives on.

## Vocabulary

Use the precise terms — they show up in types, comments, and PRs:

- **ModelRef** (locator) vs **ModelPreset** (locator + static config)
  vs **Engine** (loaded runtime).
- **Backend**: WebGPU / WASM, the ORT execution provider. Not "GPU
  mode."
- **`dtype`**: precision selection. Not "model size."
- **Cold start** = fetch + init + warmup. Three distinct phases,
  each with its own `LoadProgress` variant.

## Don't

- Don't add `createGemmaEngine` / `createPhi3Engine` / sugar
  factories. New models are new `ModelPreset` entries.
- Don't put the agent's tool-calling polyfill logic here. The native
  envelope recognition (`parseToolCalls`) is mechanical and stays; the
  prompt-engineered polyfill is a strategy and belongs in
  `@inbrowser/agent`.
- Don't widen `EngineEvent` with cloud-only concepts (cost,
  thoughtSignature). Translate at the `createEngineModelClient`
  boundary (`src/engine-client.ts`), not in the engine.
- Don't re-introduce provider exports into `@inbrowser/relay` — the
  providers live here now and the relay consumes them as
  `ModelClientFactory`s.
- Don't make `@huggingface/transformers` a regular dependency. It's
  a peer dep; consumers control the version. (The Claude Code Agent SDK,
  used only by `claudeCodeModelClient`, is an optional peer dep.)

## Status

Contract + cloud providers are the live path: relay and agent both
consume a `ModelClient` from here. The engine loads and `generate()`
streams real tokens, and the engine is now a `ModelClient` via
`createEngineModelClient` (the engine→ModelClient adapter). The next
slice is the site wiring that drives a local engine through the agent
end to end (the in-browser docs-chat toggle).
