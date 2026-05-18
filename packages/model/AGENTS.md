# Agent context for `@inbrowser/model`

## Purpose

On-device LLM inference. Wraps `@huggingface/transformers` behind a
narrow `Engine` surface so a local Gemma 4 model is a drop-in
replacement for a cloud provider when consumed through the adapter
subpaths.

## Layering invariants

- `src/types.ts` is the canonical type surface. Every other file in
  the package imports types from here.
- `src/engine.ts` is the only module that holds runtime state.
- `src/adapters/relay.ts` is the only place that imports from
  `@inbrowser/relay`. `src/adapters/agent.ts` is the only place that
  imports from `@inbrowser/agent`. The root barrel must not.
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
- Don't put tool-calling polyfill logic here. It belongs in
  `@inbrowser/agent` — it's a property of the agent runtime, not the
  model.
- Don't widen `EngineEvent` with cloud-only concepts (cost,
  thoughtSignature). Translate at the adapter boundary.
- Don't make `@huggingface/transformers` a regular dependency. It's
  a peer dep; consumers control the version.

## Status

POC. Types + adapter surface + worker frames are stable. The
`@huggingface/transformers` wiring inside `createEngine` is the
next slice.
