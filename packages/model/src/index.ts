/**
 * `@inbrowser/model` — on-device LLM engine.
 *
 * Root export carries the engine factory + types + `definePreset`.
 * Subpaths:
 *   - `@inbrowser/model/presets` — bundled Gemma 4 presets.
 *   - `@inbrowser/model/relay`   — adapter to `@inbrowser/relay`.
 *   - `@inbrowser/model/agent`   — adapter to `@inbrowser/agent`.
 *   - `@inbrowser/model/worker`  — host/connect helpers.
 *
 * Spread a preset into `createEngine` to get a running engine:
 *
 *   import { createEngine } from '@inbrowser/model';
 *   import { gemma4_E2B } from '@inbrowser/model/presets';
 *   const engine = createEngine(gemma4_E2B);
 */

export { createEngine, definePreset } from './engine.js';
export { parseToolCalls, type ToolCallParseOpts } from './parse-tool-calls.js';
export { splitThinking, type ThinkingSplitOpts } from './think.js';

// Bundled presets are also reachable via the `./presets` subpath for
// users who want narrow imports. Lifted here for ergonomics — these
// are pure data (~6 KB total) with no peer-dep activation, no
// Node-only APIs, no bundle-weight concern that justifies the friction
// of a separate import line.
export {
  deepseek_r1_qwen_1_5b,
  gemma4_E2B,
  gemma4_E4B,
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
