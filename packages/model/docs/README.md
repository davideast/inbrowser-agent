# `@inbrowser/model` Documentation

`@inbrowser/model` is the model layer for the stack. It owns the shared
`ModelClient` contract (from `@inbrowser/model`) that both `@inbrowser/relay`
(transport) and `@inbrowser/agent` (runtime) consume, the cloud providers that
implement it (Gemini, OpenRouter, Requesty, Anthropic, Ollama, Claude-CLI,
Claude-Code), and the on-device LLM engine. The engine loads ONNX models in the browser
through `@huggingface/transformers` (ONNX Runtime Web over WebGPU or WASM) and
exposes them behind a narrow `Engine` surface that streams `EngineEvent`s; a
worker transport lets the same engine run off the main thread without any
consumer noticing.

The engine is not yet a `ModelClient`: today you drive it directly via its
`EngineEvent` stream, and a `createEngineModelClient` wrapper that plugs the
engine into the relay/agent is planned but not built. The docs below say so where
it matters.

These docs cover the on-device engine in depth. For the cloud-provider factories
and the `withRetry` decorator, the package
[README](../README.md) and the [contract source](../src/contract.ts) are the
reference; the providers all implement the same `ModelClient.chat()` surface.

The documentation is organised along [Diataxis](https://diataxis.fr) lines:
tutorials to learn, how-to guides to get a job done, reference for the facts,
explanation for the why.

## Tutorials

Start here to learn by doing.

- [Run a model in the browser](tutorials/01-run-a-model-in-the-browser.md)
- [Run the model in a worker](tutorials/02-run-the-model-in-a-worker.md)

## How-to Guides

Task-focused recipes for when you know what you want.

- [Choose a preset](how-to/choose-a-preset.md)
- [Use a local model in the relay](how-to/use-a-local-model-in-relay.md) — status of the (unbuilt) `ModelClient` path
- [Use a local model in the agent](how-to/use-a-local-model-in-the-agent.md) — status of the (unbuilt) `ModelClient` path
- [Handle thinking and tool calls](how-to/handle-thinking-and-tool-calls.md)

## Reference

The facts: configuration shapes, event variants, exports.

- [Engine](reference/engine.md)
- [Presets](reference/presets.md)
- [Worker](reference/adapters-and-worker.md)

## Explanation

Background and design rationale.

- [Design](explanation/design.md)
- [On-device inference](explanation/on-device-inference.md)
