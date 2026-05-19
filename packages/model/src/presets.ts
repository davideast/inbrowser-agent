/**
 * Bundled `ModelPreset`s for Gemma 4 family.
 *
 * Adding a model is one entry here — not a new factory. Consumers
 * may also author their own via `definePreset` from the package root.
 *
 * Capabilities are declared statically from the upstream model card;
 * the runtime engine confirms them after load.
 *
 * Reference: https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX
 */

import { definePreset } from './engine.js';
import type { ModelPreset } from './types.js';

const GEMMA_4_CAPS = {
  supportsTools: false, // native tool-calling absent; polyfill lives in @inbrowser/agent
  supportsVision: false,
  supportsAudio: true,
  contextWindow: 128_000,
  supportsThinking: false,
} as const;

/**
 * Gemma 4 E2B (effective ~2.3B params). ~500MB on-device download.
 * Comfortable fit for modern integrated GPUs; recommended starting
 * point for the POC.
 */
export const gemma4_E2B: ModelPreset = definePreset({
  model: { modelId: 'onnx-community/gemma-4-E2B-it-ONNX' },
  dtype: 'q4f16',
  backend: 'auto',
  capabilities: GEMMA_4_CAPS,
});

/**
 * Gemma 4 E4B (effective ~4.5B params). ~1.5GB on-device download.
 * Higher quality; needs a discrete GPU's worth of WebGPU memory.
 */
export const gemma4_E4B: ModelPreset = definePreset({
  model: { modelId: 'onnx-community/gemma-4-E4B-it-ONNX' },
  dtype: 'q4f16',
  backend: 'auto',
  capabilities: GEMMA_4_CAPS,
});

/**
 * SmolLM2 360M Instruct. ~180MB on-device download at q4f16.
 *
 * Demo + verification preset — small enough to fit ORT-Web's WASM
 * backend on headless setups (no GPU required), and well under
 * WebGPU's 1 GiB `maxBufferSize` cap. Cold-loads in seconds, decodes
 * a token stream end-to-end without specialized hardware.
 *
 * Reference: https://huggingface.co/onnx-community/SmolLM2-360M-Instruct
 */
export const smollm2_360m: ModelPreset = definePreset({
  model: { modelId: 'HuggingFaceTB/SmolLM2-360M-Instruct' },
  dtype: 'q4f16',
  backend: 'auto',
  capabilities: {
    supportsTools: false,
    supportsVision: false,
    supportsAudio: false,
    contextWindow: 8_192,
    supportsThinking: false,
  },
});

/**
 * Qwen 2.5 Coder 1.5B Instruct. ~1.28 GB on-device download at q4f16.
 *
 * Strong on code completion and fill-in-the-middle for size. Uses the
 * Qwen2 vocabulary (~152K tokens) — embedding table stays well under
 * WebGPU's 1 GiB `maxBufferSize` cap, so this runs on most modern
 * GPUs that Gemma 4 can't reach. Native tool calling is disabled
 * here because the ONNX export drops the tool-aware decoding hooks;
 * use the `@inbrowser/agent` polyfill if you need tools.
 *
 * **Verification status:** real-GPU only. Headless WASM verify
 * fetches and loads cleanly but the first decode step fails with
 * `Shape mismatch attempting to re-use buffer. {1,1,1536} != {1,40,1536}`
 * — an ORT-Web buffer-reuse optimization bug at this scale. The
 * WebGPU path works on any real desktop GPU.
 *
 * Reference: https://huggingface.co/onnx-community/Qwen2.5-Coder-1.5B-Instruct
 */
export const qwen2_5_coder_1_5b: ModelPreset = definePreset({
  model: { modelId: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct' },
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

/**
 * Qwen 3 1.7B. ~1.36 GB on-device download at q4f16.
 *
 * Current frontier-for-size general model. Supports a "thinking mode"
 * toggle in the chat template (off by default here — flip via a
 * custom `chatTemplate` override on the preset spread). Same Qwen
 * vocabulary as 2.5; embedding table fits comfortably under the
 * WebGPU buffer cap.
 *
 * **Verification status:** real-GPU only. Headless WASM verify fails
 * at session creation with `ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc`
 * — V8's WASM heap (~4 GB ceiling) is too tight for this model's
 * load-time scratch allocations. The WebGPU path works on any real
 * desktop GPU.
 *
 * Reference: https://huggingface.co/onnx-community/Qwen3-1.7B-ONNX
 */
export const qwen3_1_7b: ModelPreset = definePreset({
  model: { modelId: 'onnx-community/Qwen3-1.7B-ONNX' },
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
