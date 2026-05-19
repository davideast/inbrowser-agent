/**
 * Public types for `@inbrowser/model`.
 *
 * Vocabulary anchor:
 *   - `ModelRef`     — bare locator (HF Hub repo id + revision).
 *   - `ModelPreset`  — locator + static config (dtype, backend,
 *                      capabilities, optional chat template).
 *   - `Engine`       — runtime object owning a loaded model.
 *                      Spread a preset into `createEngine` to get one.
 *
 * The Engine speaks a narrow `EngineEvent` vocabulary. Adapters in
 * `./adapters/*` translate to the relay's `InferenceEvent` or the
 * agent's `ChatEvent` shape. Cloud-only concepts (cost, signatures)
 * are deliberately absent here.
 */

/**
 * HF Hub repo id + optional revision. Pin a revision for
 * reproducibility — `main` drifts.
 */
export interface ModelRef {
  modelId: string;
  revision?: string;
}

/**
 * ONNX Runtime Web execution backend.
 *
 *   - `'webgpu'` — WebGPU compute pipeline. Required for Gemma 4 perf.
 *   - `'wasm'`   — SIMD CPU fallback. Always available, much slower.
 *   - `'auto'`   — Probe `navigator.gpu`; fall back to wasm if absent.
 */
export type Backend = 'auto' | 'webgpu' | 'wasm';

/**
 * Weight/activation precision selection.
 *
 *   - `q4f16` — 4-bit int weights, fp16 activations. Recommended
 *               default for Gemma 4 on WebGPU.
 *   - `q8`    — 8-bit int weights. Larger, sometimes higher quality.
 *   - `fp16`  — half precision throughout.
 *   - `fp32`  — full precision (rarely useful in-browser).
 */
export type Dtype = 'q4f16' | 'q8' | 'fp16' | 'fp32';

/**
 * Static, pre-load capability declaration. Lives on `ModelPreset`
 * so consumers can interrogate before paying load cost.
 */
export interface EngineCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  /** Context window in tokens. */
  contextWindow: number;
  /** Whether the model emits thinking traces (Gemma 4: no). */
  supportsThinking: boolean;
}

/**
 * A fully-specified model configuration. Spread into `createEngine`
 * along with optional hooks. Authored via `definePreset` for
 * compile-time completeness checks; community presets can be exported
 * the same way.
 */
export interface ModelPreset {
  model: ModelRef;
  dtype: Dtype;
  backend: Backend;
  capabilities: EngineCapabilities;
  /**
   * Optional override of the chat template. The default uses the
   * tokenizer's bundled template (`apply_chat_template`); override
   * only when a model ships a broken or missing template.
   */
  chatTemplate?: (messages: ReadonlyArray<EngineMessage>) => string;
}

/**
 * Granular progress for the three observable phases of cold start.
 *
 *   - `fetch`  — weights flowing from HF Hub (or `weightsBaseUrl`) into
 *                the browser Cache API. Cached after first run.
 *   - `init`   — ONNX Runtime compiling the graph for `backend`.
 *                Per-page-load (not cached across reloads today).
 *   - `warmup` — first forward pass primes WebGPU pipelines + kernel
 *                caches. Once-per-engine-instance.
 *   - `ready`  — terminal phase; safe to `generate`.
 */
export type LoadProgress =
  | { phase: 'fetch'; file: string; loadedBytes: number; totalBytes: number }
  | { phase: 'init'; backend: Backend }
  | { phase: 'warmup'; tokensGenerated: number }
  | { phase: 'ready' };

export type EngineState = 'idle' | 'loading' | 'ready' | 'error' | 'disposed';

/**
 * Inline media for multimodal models. Gemma 4 accepts audio; future
 * presets may set `supportsVision: true` and accept images.
 */
export type MediaPart =
  | { kind: 'image'; data: Blob | ArrayBuffer; mimeType: string }
  | { kind: 'audio'; data: Blob | ArrayBuffer; mimeType: string };

/**
 * Engine-side chat message. Symmetric with agent's `NormalizedMessage`
 * minus tool fields — the engine itself is toolless. Tool-use
 * polyfilling lives upstream in `@inbrowser/agent`.
 */
export interface EngineMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
  media?: ReadonlyArray<MediaPart>;
}

export interface GenerateOpts {
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  /** Stop sequences enforced post-tokenization. */
  stop?: ReadonlyArray<string>;
  /** Caller-side cancellation. Aborting stops the decode loop. */
  signal?: AbortSignal;
}

/**
 * Engine's narrow event vocabulary. Adapters translate to the wider
 * shapes consumers expect (`InferenceEvent`, `ChatEvent`). No cost,
 * no thoughtSignature, no cloud-specific extension fields.
 *
 *   - `token`    — decoded text per decode step.
 *   - `thinking` — content the model emitted inside a reasoning-tag
 *                  wrapper (e.g., `<think>…</think>` for DeepSeek R1).
 *                  The engine itself never produces this kind; it's
 *                  emitted by `splitThinking()` (see `./think.ts`) when
 *                  a consumer wraps the engine's stream. The variant
 *                  lives on `EngineEvent` so a single `switch (kind)`
 *                  handles both wrapped and raw streams.
 *   - `usage`    — terminal accounting, once per stream.
 *   - `error`    — `recoverable` distinguishes retryable transients
 *                  (decode hiccup) from terminal failures (OOM, dispose).
 */
export type EngineEvent =
  | { kind: 'token'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'usage'; promptTokens: number; outputTokens: number; decodeMs: number }
  | { kind: 'error'; message: string; recoverable: boolean };

/**
 * Lifecycle event types `engine.on()` subscribes to.
 */
export interface EngineEventMap {
  state: EngineState;
  load: LoadProgress;
}

/**
 * The runtime engine. Holds the loaded model + tokenizer/processor.
 * One engine per model instance; spawn multiple to run different
 * models in parallel (memory permitting).
 */
export interface Engine {
  readonly model: ModelRef;
  readonly state: EngineState;
  /** Static capabilities — equal to `preset.capabilities` post-load. */
  readonly capabilities: EngineCapabilities;

  /** Idempotent. Resolves once state is `'ready'`. */
  ensureReady(): Promise<void>;

  on<K extends keyof EngineEventMap>(
    event: K,
    handler: (value: EngineEventMap[K]) => void,
  ): () => void;

  generate(messages: ReadonlyArray<EngineMessage>, opts?: GenerateOpts): AsyncIterable<EngineEvent>;

  /** Release GPU buffers + tokenizer state. Engine unusable after. */
  dispose(): Promise<void>;
}

/**
 * Non-preset construction options. Spread alongside a `ModelPreset`
 * into `createEngine`.
 */
export interface EngineHooks {
  /**
   * Base URL for weight fetches. Defaults to huggingface.co. Set for
   * self-hosted mirrors or offline bundles; the engine appends
   * `{modelId}/{file}`.
   */
  weightsBaseUrl?: string;
  /**
   * Minimum reported GPU memory in MB. If the device reports less,
   * `ensureReady()` rejects with `InsufficientMemoryError` rather than
   * crashing mid-load.
   */
  minGpuMemoryMb?: number;
  onLoadProgress?: (p: LoadProgress) => void;
}

/**
 * Full argument shape for `createEngine`. A complete `ModelPreset`
 * is required; hooks are optional.
 *
 *   createEngine({ ...gemma4_E2B, onLoadProgress: console.log });
 */
export type CreateEngineOpts = ModelPreset & EngineHooks;
