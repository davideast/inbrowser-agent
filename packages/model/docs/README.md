# `@inbrowser/model` Documentation

`@inbrowser/model` is an on-device LLM engine. It loads ONNX models in the
browser through `@huggingface/transformers` (ONNX Runtime Web over WebGPU or
WASM) and exposes them behind a narrow `Engine` surface. Adapters widen that
surface to the relay's `InferenceEvent` and the agent's `ChatEvent` shapes, and
a worker transport lets the same engine run off the main thread without any
consumer noticing. It is early but functional: models load, `generate()`
streams real tokens, and the adapters and worker work against it.

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
- [Adapters and worker](reference/adapters-and-worker.md)

## Explanation

Background and design rationale.

- [Design](explanation/design.md)
- [On-device inference](explanation/on-device-inference.md)
