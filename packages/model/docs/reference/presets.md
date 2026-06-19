# Presets Reference

This page describes the six bundled `ModelPreset` values exported from
`@inbrowser/model` and the static types they carry.

Spread a preset into `createEngine` to construct a running engine; see
[./engine.md](./engine.md).

```ts
import { createEngine, smollm2_360m } from '@inbrowser/model';

const engine = createEngine(smollm2_360m);
```

## Bundled presets

Every bundled preset uses `dtype: 'q4f16'` and `backend: 'auto'`.

| Preset | `model.modelId` | `contextWindow` | `supportsTools` | `supportsThinking` | `supportsVision` | `supportsAudio` | `thinkingTags` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gemma4_E2B` | `onnx-community/gemma-4-E2B-it-ONNX` | `128000` | `false` | `true` | `false` | `true` | none |
| `gemma4_E4B` | `onnx-community/gemma-4-E4B-it-ONNX` | `128000` | `false` | `true` | `false` | `true` | none |
| `smollm2_360m` | `HuggingFaceTB/SmolLM2-360M-Instruct` | `8192` | `false` | `false` | `false` | `false` | none |
| `qwen2_5_coder_1_5b` | `onnx-community/Qwen2.5-Coder-1.5B-Instruct` | `32768` | `true` | `false` | `false` | `false` | none |
| `qwen3_1_7b` | `onnx-community/Qwen3-1.7B-ONNX` | `32768` | `true` | `false` | `false` | `false` | none |
| `deepseek_r1_qwen_1_5b` | `onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX` | `131072` | `false` | `true` | `false` | `false` | `<think>` / `</think>` |

Notes on capability flags:

- The Gemma 4 presets declare `supportsThinking: true` but deliberately omit
  `thinkingTags`. Their channel-marker emission is inconsistent, so a text-based
  parser cannot reliably separate thinking from answer. Reasoning streams inline
  as `token` events.
- `qwen2_5_coder_1_5b` and `qwen3_1_7b` declare `supportsTools: true`. The
  engine threads `tools` into the chat template and wraps the output with
  `parseToolCalls()` when tools are provided.
- `deepseek_r1_qwen_1_5b` declares `thinkingTags: { openTag: '<think>',
  closeTag: '</think>' }`. These literal-text tags match `splitThinking`'s
  defaults; declaring them on the preset lets consumers stay model-agnostic.

## `ModelPreset`

A fully-specified model configuration. Spread into `createEngine` alongside
optional `EngineHooks`.

| Field | Type | Description |
| --- | --- | --- |
| `model` | `ModelRef` | HF Hub locator. |
| `dtype` | `Dtype` | Weight/activation precision. |
| `backend` | `Backend` | ONNX Runtime Web execution backend. |
| `capabilities` | `EngineCapabilities` | Static, pre-load capability declaration. |
| `chatTemplate?` | `(messages: ReadonlyArray<EngineMessage>) => string` | Optional chat-template override. |

## `ModelRef`

| Field | Type | Description |
| --- | --- | --- |
| `modelId` | `string` | HF Hub repo id. |
| `revision?` | `string` | Optional revision. The bundled presets pin no revision. |

## `Dtype`

```ts
type Dtype = 'q4f16' | 'q8' | 'fp16' | 'fp32';
```

| Value | Meaning |
| --- | --- |
| `q4f16` | 4-bit int weights, fp16 activations. |
| `q8` | 8-bit int weights. |
| `fp16` | Half precision throughout. |
| `fp32` | Full precision. |

## `Backend`

```ts
type Backend = 'auto' | 'webgpu' | 'wasm';
```

| Value | Meaning |
| --- | --- |
| `auto` | Probe `navigator.gpu`; fall back to wasm if absent. |
| `webgpu` | WebGPU compute pipeline. |
| `wasm` | SIMD CPU fallback. Always available, much slower. |

## `EngineCapabilities`

`EngineCapabilities` is the static capability declaration carried on
`ModelPreset.capabilities`. Its full field table, including `thinkingTags`, is
documented in [./engine.md](./engine.md#enginecapabilities).

## Authoring presets

Community presets are authored with `definePreset`, the same helper used for the
bundled set. See [./engine.md](./engine.md#definepreset).

## Related

- Engine surface and shared types: [./engine.md](./engine.md)
- Adapters and worker: [./adapters-and-worker.md](./adapters-and-worker.md)
- Tutorial: [../tutorials/01-run-a-model-in-the-browser.md](../tutorials/01-run-a-model-in-the-browser.md)
