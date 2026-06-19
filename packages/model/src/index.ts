/**
 * `@inbrowser/model` — on-device LLM engine.
 *
 * Everything ships from this single root export: the engine factory +
 * types + `definePreset`, the bundled presets, the shared `ModelClient`
 * contract, the cloud provider factories, the engine-client adapter,
 * `withRetry`, and the in-worker host/connect helpers. There are no
 * subpaths — the on-device transformers runtime is lazy-loaded, so
 * importing the root never statically pulls ONNX/WASM into a
 * cloud-only consumer.
 *
 * Spread a preset into `createEngine` to get a running engine:
 *
 *   import { createEngine, gemma4_E2B } from '@inbrowser/model';
 *   const engine = createEngine(gemma4_E2B);
 */

export { createEngine, definePreset } from './engine.js';
// The on-device engine as a `ModelClient` (wraps `EngineEvent` → `ModelEvent`).
// Runtime, not type-only.
export { createEngineModelClient } from './engine-client.js';
export { parseToolCalls, type ToolCallParseOpts } from './parse-tool-calls.js';
export { splitThinking, type ThinkingSplitOpts } from './think.js';
// In-worker transport: host an `Engine` inside a Web Worker and connect a
// matching `Engine` stub on the main thread.
export {
  connectWorkerEngine,
  hostEngineInWorker,
  type ConnectWorkerEngineOpts,
  type HostEngineInWorkerOpts,
  type WorkerHostHandle,
} from './worker.js';

// Cloud provider factories. Each returns a `ModelClient`; construction
// settings (apiKey / model / baseUrl) come in the factory config, per-call
// settings (messages / tools / sampling) come in the `ModelRequest`.
export {
  geminiModelClient,
  buildGeminiRequest,
  geminiEventsFromResponse,
  sanitizeGeminiSchema,
  type GeminiConfig,
} from './providers/gemini.js';
export {
  openrouterModelClient,
  toOaiTools as toOpenRouterTools,
  type OpenRouterConfig,
} from './providers/openrouter.js';
export {
  anthropicModelClient,
  toAnthropicTools,
  type AnthropicConfig,
} from './providers/anthropic.js';
// The generic OpenAI-compatible factory + its shared tool encoder. Point
// it at any OAI server (vLLM, LM Studio, LocalAI, …); the named local
// presets below are thin wrappers over it.
export {
  openaiCompatModelClient,
  toOaiTools,
  type OpenAiCompatConfig,
} from './providers/oai-compat.js';
// ollama re-exports the shared `toOaiTools`; alias the named-client export
// to keep the historical `toOllamaTools` root name.
export {
  ollamaModelClient,
  toOaiTools as toOllamaTools,
  type OllamaConfig,
} from './providers/ollama.js';
// llama.cpp's llama-server — same OAI core, default :8080, optional Bearer.
export { llamaServerModelClient, type LlamaServerConfig } from './providers/llama-server.js';
// claude-cli is Node-only (spawns a subprocess) but SSR-safe to import:
// nothing runs until the client's `chat` is invoked.
export {
  claudeCliModelClient,
  renderPrompt,
  type ClaudeCliConfig,
  type ClaudeCliOptions,
} from './providers/claude-cli.js';
// claude-code uses the Claude Code Agent SDK programmatically. The SDK is
// an OPTIONAL peer dep — consumers who don't use this provider don't need
// it. Importing this file is SSR-safe; the SDK is lazy-loaded inside chat.
export { claudeCodeModelClient, type ClaudeCodeConfig } from './providers/claude-code.js';

// The reusable transient-retry decorator (was the site's relay bridge).
export { withRetry, type WithRetryOpts } from './with-retry.js';

// Shared provider config + the factory type relay routes on.
export type { CloudProviderConfig, ModelClientFactory } from './providers/types.js';

// Bundled presets — pure data (~6 KB total) with no peer-dep activation,
// no Node-only APIs, no bundle-weight concern.
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

// The shared model-call contract (cloud providers + on-device engine implement
// it; relay + agent consume it). Type-only; importing it pulls no runtime.
export type {
  ModelClient,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelUsage,
  ReasoningEffort,
} from './contract.js';
