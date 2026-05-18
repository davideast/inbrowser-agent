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
