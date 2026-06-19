/**
 * On-device docs agent — runs the SAME agent loop the server runs, but entirely
 * in the browser: the engine streams in a Web Worker, wrapped as a `ModelClient`
 * via `createEngineModelClient`, driven by `createRetrievalStrategy` (code does
 * the doc retrieval; the small model only writes a grounded answer). The graph
 * tools + content graph are already client-safe, so nothing hits the server.
 *
 * Experimental: small on-device models are far weaker than cloud Gemini, and the
 * tool-native ones realistically need WebGPU. This surface exists so the chat can
 * be tested on-device on a real device.
 */
import {
  type Engine,
  type EngineState,
  type LoadProgress,
  type ModelClient,
  connectWorkerEngine,
  createEngineModelClient,
  smollm2_360m,
} from '@inbrowser/model';
import type { AgentStreamHandlers } from './agent-types';
import { runLocalAgent } from './local-agent';

// SmolLM2 360M is the only on-device preset: small enough to run on WASM where
// WebGPU is unavailable, and it caches once for instant reloads.
export type OnDevicePreset = 'smollm2_360m';

const PRESETS = {
  smollm2_360m,
} as const;

const MODEL_CACHE = 'transformers-cache';

/**
 * Which presets are ACTUALLY in the browser model cache. transformers.js stores
 * weights in the `transformers-cache` Cache API under each model's URL; we check
 * for a real weights file (.onnx) per preset's modelId. This is the truthful
 * source for the `✓ cached` badge — the prior localStorage flag could lie after
 * the browser evicted best-effort storage.
 */
export async function getCachedPresets(): Promise<Set<OnDevicePreset>> {
  const out = new Set<OnDevicePreset>();
  if (typeof caches === 'undefined') return out;
  try {
    const cache = await caches.open(MODEL_CACHE);
    const urls = (await cache.keys()).map((r) => r.url);
    for (const p of Object.keys(PRESETS) as OnDevicePreset[]) {
      const id = PRESETS[p].model.modelId;
      if (urls.some((u) => u.includes(id) && u.includes('.onnx'))) out.add(p);
    }
  } catch {
    /* Cache API blocked / unavailable — treat as nothing cached. */
  }
  return out;
}

/**
 * Ask the browser to keep our storage (the model weights) rather than treat it
 * as best-effort and evict it under disk pressure — multi-GB Gemma weights are
 * otherwise a prime eviction target, forcing a re-download each visit.
 * Idempotent; returns the resulting persisted state.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Richer per-preset metadata: drives the dropdown rows (size + quality), the
 *  WebGPU capability gating, and the load-button note. */
export interface PresetMeta {
  label: string;
  /** Human-readable download size, e.g. `~180 MB`. */
  sizeLabel: string;
  /** Relative answer quality on this device class. */
  quality: 'ok' | 'good' | 'best';
  /** WebGPU-only: produces garbage / can't run on WASM. */
  needsWebGPU: boolean;
  /** One-line note for the load button + status. */
  note: string;
}

export const PRESET_META: Record<OnDevicePreset, PresetMeta> = {
  smollm2_360m: {
    label: 'SmolLM2 360M',
    sizeLabel: '~180 MB',
    quality: 'ok',
    needsWebGPU: false,
    note: '~180 MB · WebGPU, or WASM where unavailable',
  },
};

/** Is the WebGPU backend available? (Just presence — not a feature probe.) */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu);
}

let current: { preset: OnDevicePreset; engine: Engine; worker: Worker } | null = null;

export function loadedPreset(): OnDevicePreset | null {
  return current?.preset ?? null;
}

export interface LoadHandlers {
  onProgress?(p: LoadProgress): void;
  onState?(s: EngineState): void;
}

/**
 * Download + compile a preset in the worker and keep it resident. Resolves when
 * the engine is ready. A different preset disposes the previous one.
 */
export async function loadOnDeviceEngine(
  preset: OnDevicePreset,
  handlers: LoadHandlers = {},
): Promise<void> {
  if (current?.preset === preset) return;
  if (current) {
    current.engine.dispose?.();
    current.worker.terminate();
    current = null;
  }
  const worker = new Worker(new URL('../workers/model-worker.ts', import.meta.url), {
    type: 'module',
  });
  const engine = connectWorkerEngine({ worker, engine: { ...PRESETS[preset] } });
  if (handlers.onProgress) engine.on('load', handlers.onProgress);
  if (handlers.onState) engine.on('state', handlers.onState);
  await engine.ensureReady();
  current = { preset, engine, worker };
}

/**
 * Wrap the currently-loaded engine as a `ModelClient`, so the shared
 * `runLocalAgent` loop can drive it exactly like any cloud/local provider.
 * Returns `null` when no engine is loaded yet.
 */
export function createOnDeviceModelClient(): ModelClient | null {
  return current ? createEngineModelClient(current.engine) : null;
}

/**
 * Run one question through the on-device agent, dispatching to the same handlers
 * the cloud path uses (so the chat UI is identical). The engine must already be
 * loaded via `loadOnDeviceEngine`. Thin wrapper over the shared `runLocalAgent`.
 */
export async function streamOnDeviceAgent(
  question: string,
  history: { role: 'user' | 'assistant'; text: string }[],
  handlers: AgentStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const llm = createOnDeviceModelClient();
  if (!llm) {
    handlers.onError?.('on-device model is not loaded yet');
    return;
  }
  await runLocalAgent(llm, question, history, handlers, signal);
}
