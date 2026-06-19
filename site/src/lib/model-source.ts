/**
 * Unified model-source selection for the docs chat. One config describes which
 * of the four sources the chat runs on (Gemini cloud, on-device WebGPU,
 * OpenRouter BYOK, local Ollama) plus the per-source settings. The config is
 * persisted to localStorage so a choice survives reloads.
 *
 * The lean cloud/local providers (OpenRouter, Ollama) are built here via
 * `buildLocalModelClient`; the on-device WebGPU client is built by the caller
 * from the loaded engine (it owns the engine lifecycle), so this module never
 * imports the engine / worker / transformers.
 */
import type { ModelClient } from '@inbrowser/model/contract';
import { ollamaModelClient } from '@inbrowser/model/providers/ollama';
import { openrouterModelClient } from '@inbrowser/model/providers/openrouter';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnDevicePreset } from './on-device-agent';

export type ModelSource = 'gemini' | 'webgpu' | 'openrouter' | 'ollama';

/** Everything the four sources need, in one persisted object. */
export interface ModelSourceConfig {
  source: ModelSource;
  webgpuPreset: OnDevicePreset;
  openrouterKey: string;
  openrouterModel: string;
  ollamaModel: string;
  ollamaBaseUrl: string;
}

export const DEFAULT_MODEL_SOURCE_CONFIG: ModelSourceConfig = {
  source: 'gemini',
  webgpuPreset: 'smollm2_360m',
  openrouterKey: '',
  openrouterModel: 'openai/gpt-4o-mini',
  ollamaModel: 'llama3.2',
  ollamaBaseUrl: 'http://localhost:11434',
};

/** Static per-source descriptors driving the selector rows + gating. */
export interface SourceMeta {
  label: string;
  kind: 'cloud' | 'local' | 'on-device';
  /** `server` = the existing /api/chat resumable path; `local` = the
   *  client-side `runLocalAgent` loop. */
  runner: 'server' | 'local';
  needsKey: boolean;
  needsWebGPU: boolean;
  /** One-word setup requirement shown in the row. */
  requirement: string;
}

export const SOURCE_META: Record<ModelSource, SourceMeta> = {
  gemini: {
    label: 'Gemini',
    kind: 'cloud',
    runner: 'server',
    needsKey: false,
    needsWebGPU: false,
    requirement: 'no setup',
  },
  webgpu: {
    label: 'On-device',
    kind: 'on-device',
    runner: 'local',
    needsKey: false,
    needsWebGPU: true,
    requirement: 'WebGPU',
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'cloud',
    runner: 'local',
    needsKey: true,
    needsWebGPU: false,
    requirement: 'API key',
  },
  ollama: {
    label: 'Ollama',
    kind: 'local',
    runner: 'local',
    needsKey: false,
    needsWebGPU: false,
    requirement: 'localhost',
  },
};

const STORAGE_KEY = 'inbrowser-model-source:v1';

function isModelSource(x: unknown): x is ModelSource {
  return x === 'gemini' || x === 'webgpu' || x === 'openrouter' || x === 'ollama';
}

function isPreset(x: unknown): x is OnDevicePreset {
  return x === 'smollm2_360m' || x === 'gemma4_e2b' || x === 'gemma4_e4b';
}

function load(): ModelSourceConfig {
  if (typeof localStorage === 'undefined') return DEFAULT_MODEL_SOURCE_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_MODEL_SOURCE_CONFIG;
    const p = JSON.parse(raw) as Partial<ModelSourceConfig>;
    // Merge over defaults + field-validate, so a hand-edited / version-skewed
    // blob can never produce an invalid source or preset.
    return {
      source: isModelSource(p.source) ? p.source : DEFAULT_MODEL_SOURCE_CONFIG.source,
      webgpuPreset: isPreset(p.webgpuPreset)
        ? p.webgpuPreset
        : DEFAULT_MODEL_SOURCE_CONFIG.webgpuPreset,
      openrouterKey:
        typeof p.openrouterKey === 'string'
          ? p.openrouterKey
          : DEFAULT_MODEL_SOURCE_CONFIG.openrouterKey,
      openrouterModel:
        typeof p.openrouterModel === 'string' && p.openrouterModel.trim()
          ? p.openrouterModel
          : DEFAULT_MODEL_SOURCE_CONFIG.openrouterModel,
      ollamaModel:
        typeof p.ollamaModel === 'string' && p.ollamaModel.trim()
          ? p.ollamaModel
          : DEFAULT_MODEL_SOURCE_CONFIG.ollamaModel,
      ollamaBaseUrl:
        typeof p.ollamaBaseUrl === 'string' && p.ollamaBaseUrl.trim()
          ? p.ollamaBaseUrl
          : DEFAULT_MODEL_SOURCE_CONFIG.ollamaBaseUrl,
    };
  } catch {
    return DEFAULT_MODEL_SOURCE_CONFIG;
  }
}

export interface UseModelSource {
  config: ModelSourceConfig;
  setSource(source: ModelSource): void;
  setField<K extends keyof ModelSourceConfig>(key: K, value: ModelSourceConfig[K]): void;
}

/**
 * Persist the model-source config to localStorage. Mirrors chat-store's
 * resilience: loads once on mount (client only), writes are debounced, and
 * quota / private-mode failures are swallowed.
 */
export function useModelSource(): UseModelSource {
  const [config, setConfig] = useState<ModelSourceConfig>(DEFAULT_MODEL_SOURCE_CONFIG);
  const loaded = useRef(false);

  // Load once on mount (client only).
  useEffect(() => {
    setConfig(load());
    loaded.current = true;
  }, []);

  // Debounced persist on change.
  const configRef = useRef(config);
  configRef.current = config;
  // biome-ignore lint/correctness/useExhaustiveDependencies: config is the change trigger
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(configRef.current));
      } catch {
        /* quota / private mode — ignore */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [config]);

  const setSource = useCallback((source: ModelSource) => {
    setConfig((c) => ({ ...c, source }));
  }, []);

  const setField = useCallback(
    <K extends keyof ModelSourceConfig>(key: K, value: ModelSourceConfig[K]) => {
      setConfig((c) => ({ ...c, [key]: value }));
    },
    [],
  );

  return { config, setSource, setField };
}

// The `✓ cached` badge is driven by the REAL model cache (the Cache API) via
// getCachedPresets() in on-device-agent — not a localStorage flag, which could
// lie after the browser evicted best-effort storage.

/**
 * Build the `ModelClient` for the lean local/cloud sources (OpenRouter, Ollama).
 * WebGPU is intentionally NOT handled here — it's built by the caller from the
 * loaded engine via `createOnDeviceModelClient`, and gemini never runs locally
 * (it goes through the server path).
 */
export function buildLocalModelClient(config: ModelSourceConfig): ModelClient {
  if (config.source === 'openrouter') {
    return openrouterModelClient({ apiKey: config.openrouterKey, model: config.openrouterModel });
  }
  if (config.source === 'ollama') {
    return ollamaModelClient({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel });
  }
  throw new Error(`buildLocalModelClient: source "${config.source}" is not a lean local source`);
}
