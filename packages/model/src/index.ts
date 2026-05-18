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
} from './types.js';
