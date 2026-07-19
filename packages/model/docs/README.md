# `@inbrowser/model` Documentation

`@inbrowser/model` is the model layer for the stack. Three public seams:

- **Root** — the shared `ModelClient` contract that `@inbrowser/relay` and
  `@inbrowser/agent` consume, plus usage helpers and `withRetry`.
- **Providers** — `@inbrowser/model/providers/<name>` for each cloud factory
  (Gemini, OpenRouter, Requesty, Anthropic, Ollama, Claude-CLI, Claude-Code,
  Firebase AI Logic, …).
- **Local** — opt-in `@inbrowser/model/local` for the on-device engine.

The engine loads ONNX models in the browser through
`@huggingface/transformers` (ONNX Runtime Web over WebGPU or WASM) and exposes
them behind a narrow `Engine` surface that streams `EngineEvent`s; a worker
transport lets the same engine run off the main thread without any consumer
noticing.

The engine can also be wrapped as a `ModelClient` with
`createEngineModelClient`. Drive the `EngineEvent` stream directly when you need
engine-specific details; use the wrapper when you want to hand the engine to the
relay or agent through the shared model contract.

These docs cover the on-device engine in depth. For cloud-provider factories,
import from `@inbrowser/model/providers/<name>`; for `withRetry` and the
contract, see the package [README](../README.md) and
[contract source](../src/contract.ts). Providers all implement the same
`ModelClient.chat()` surface.

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
- [Use a local model in the relay](how-to/use-a-local-model-in-relay.md)
- [Use a local model in the agent](how-to/use-a-local-model-in-the-agent.md)
- [Handle thinking and tool calls](how-to/handle-thinking-and-tool-calls.md)

## Reference

The facts: configuration shapes, event variants, exports.

- [Engine](reference/engine.md)
- [Presets](reference/presets.md)
- [Worker](reference/adapters-and-worker.md)
- [Gateway providers](reference/gateway-providers.md)
- [Firebase AI Logic](reference/firebase-ai-logic.md)

## Explanation

Background and design rationale.

- [Design](explanation/design.md)
- [On-device inference](explanation/on-device-inference.md)
- [Firebase AI Logic provider assessment](explanation/firebase-ai-logic-provider-assessment.md)
