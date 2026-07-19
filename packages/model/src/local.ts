/**
 * `@inbrowser/model/local` — opt-in on-device inference.
 *
 * This is the only public seam for the Transformers-backed engine. Consumers
 * that only need the shared `ModelClient` contract or a cloud provider can
 * import `@inbrowser/model` / `@inbrowser/model/providers/<name>` without
 * exposing their dependency graph to the on-device runtime.
 */

export { createEngine, definePreset } from './engine.js';
export { createEngineModelClient } from './engine-client.js';
export { parseToolCalls, type ToolCallParseOpts } from './parse-tool-calls.js';
export { splitThinking, type ThinkingSplitOpts } from './think.js';
export {
  connectWorkerEngine,
  hostEngineInWorker,
  type ConnectWorkerEngineOpts,
  type HostEngineInWorkerOpts,
  type WorkerHostHandle,
} from './worker.js';

export {
  deepseek_r1_qwen_1_5b,
  gemma4_E2B,
  gemma4_E4B,
  qwen2_5_0_5b,
  qwen2_5_coder_1_5b,
  qwen3_1_7b,
  smollm2_360m,
} from './presets.js';

export type {
  Backend,
  CreateEngineOpts,
  Dtype,
  Engine,
  EngineCapabilities,
  EngineEvent,
  EngineEventMap,
  EngineHooks,
  EngineMessage,
  EngineState,
  GenerateOpts,
  LoadProgress,
  MediaPart,
  ModelPreset,
  ModelRef,
  ToolSpec,
} from './types.js';
