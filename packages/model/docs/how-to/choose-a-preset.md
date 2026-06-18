# How To Choose A Preset

Pick the bundled `ModelPreset` whose declared capabilities and download cost match what your app needs, or define your own.

A preset is pure data: a model locator plus a static capability declaration. You can inspect every field before paying any download or load cost, so capability selection happens at build time, not after a cold start.

## Pick By Capability

Every bundled preset declares `capabilities` up front. Read the field that matters for your use case:

- **Need tool / function calling?** Require `capabilities.supportsTools`. Only `qwen2_5_coder_1_5b` and `qwen3_1_7b` set it `true`. The Gemma and DeepSeek presets are not tool-native (see [how to handle thinking and tool calls](./handle-thinking-and-tool-calls.md) for what "native" means and where the polyfill lives).
- **Want a visible reasoning trace?** Require `capabilities.supportsThinking`. `gemma4_E2B`, `gemma4_E4B`, and `deepseek_r1_qwen_1_5b` set it `true`. Only `deepseek_r1_qwen_1_5b` also declares `thinkingTags`, so its reasoning can be split into a separate UI surface; Gemma 4 deliberately omits them.
- **Long input?** Compare `capabilities.contextWindow`: `smollm2_360m` is 8 192, the Qwens are 32 768, Gemma 4 is 128 000, and `deepseek_r1_qwen_1_5b` is 131 072 tokens.
- **Want audio in?** Require `capabilities.supportsAudio`. Only the Gemma 4 presets accept audio.

## Trade Size Against Quality

Download size and memory headroom scale with quality. If you are unsure where to start:

- **Verifying the pipeline on any machine, no GPU:** use `smollm2_360m` (~180 MB, runs on the WASM backend).
- **A capable general model on an integrated GPU:** use `gemma4_E2B` (~500 MB).
- **Higher quality, with a discrete GPU's memory:** use `gemma4_E4B` (~1.5 GB).
- **Tool use:** use `qwen2_5_coder_1_5b` for code or `qwen3_1_7b` for general work (each ~1.3 GB). Both are real-GPU only; the headless WASM path fails to load them.

All bundled presets ship at `dtype: 'q4f16'` with `backend: 'auto'` (WebGPU when available, WASM otherwise).

## Inspect Capabilities Before Loading

Because a preset is inert data, read its fields directly without constructing an engine:

```ts
import { gemma4_E2B } from '@inbrowser/model/presets';

gemma4_E2B.capabilities.contextWindow; // 128000
gemma4_E2B.capabilities.supportsTools; // false
```

Gate your own UI or routing on these fields before you spend a cold start. To choose at runtime from a list:

```ts
import { qwen3_1_7b, gemma4_E2B } from '@inbrowser/model/presets';

const candidates = [qwen3_1_7b, gemma4_E2B];
const preset = needTools
  ? candidates.find((p) => p.capabilities.supportsTools)
  : gemma4_E2B;
```

Spread the chosen preset into `createEngine` to load it. See [run a model in the browser](../tutorials/01-run-a-model-in-the-browser.md).

## Define Your Own Preset

If none of the bundled presets fit, author one with `definePreset`. It is an identity helper that gives you compile-time completeness checks against `ModelPreset`:

```ts
import { definePreset } from '@inbrowser/model';

export const myModel = definePreset({
  model: { modelId: 'onnx-community/Some-Model-ONNX', revision: 'main' },
  dtype: 'q4f16',
  backend: 'auto',
  capabilities: {
    supportsTools: false,
    supportsVision: false,
    supportsAudio: false,
    contextWindow: 32_768,
    supportsThinking: false,
  },
});
```

Declare `capabilities` from the upstream model card; the runtime engine confirms them after load. Pin `model.revision` for reproducibility, since `main` drifts. Pass an optional `chatTemplate` only when the model ships a broken or missing template. Export the result like any bundled preset and spread it into `createEngine`.

For the full shape of each field (`ModelRef`, `Dtype`, `Backend`, `EngineCapabilities`, `thinkingTags`), see [the presets reference](../reference/presets.md). For why capabilities are declared statically rather than probed, see [the design notes](../explanation/design.md).
