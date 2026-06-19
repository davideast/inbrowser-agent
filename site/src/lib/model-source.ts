/**
 * Unified model-source selection for the docs chat. One config describes which
 * source the chat runs on (Gemini cloud, on-device WebGPU, OpenRouter BYOK,
 * local Ollama, self-hosted Llama/llama-server) plus the per-source settings.
 * The config is persisted to localStorage so a choice survives reloads.
 *
 * The lean cloud/local providers (OpenRouter, Ollama, Llama) are built here via
 * `buildLocalModelClient`; the on-device WebGPU client is built by the caller
 * from the loaded engine (it owns the engine lifecycle), so this module never
 * imports the engine / worker / transformers.
 */
import {
  type ModelClient,
  geminiModelClient,
  llamaServerModelClient,
  ollamaModelClient,
  openrouterModelClient,
} from '@inbrowser/model';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnDevicePreset } from './on-device-agent';

export type ModelSource = 'gemini' | 'webgpu' | 'openrouter' | 'ollama' | 'llama';

/** Everything the four sources need, in one persisted object. */
export interface ModelSourceConfig {
  source: ModelSource;
  geminiKey: string;
  geminiModel: string;
  webgpuPreset: OnDevicePreset;
  openrouterKey: string;
  openrouterModel: string;
  ollamaModel: string;
  ollamaBaseUrl: string;
  llamaBaseUrl: string;
  llamaModel: string;
  llamaKey: string;
}

export const DEFAULT_MODEL_SOURCE_CONFIG: ModelSourceConfig = {
  source: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-3.5-flash',
  webgpuPreset: 'smollm2_360m',
  openrouterKey: '',
  openrouterModel: 'openai/gpt-4o-mini',
  ollamaModel: 'llama3.2',
  ollamaBaseUrl: 'http://localhost:11434',
  llamaBaseUrl: 'http://localhost:8080',
  llamaModel: 'local-model',
  llamaKey: '',
};

/** Static per-source descriptors driving the selector rows + gating. */
export interface SourceMeta {
  label: string;
  kind: 'cloud' | 'local' | 'on-device';
  /** All sources now run the client-side `runLocalAgent` loop (the server is
   *  gone); kept as a one-value union for the per-source descriptor shape. */
  runner: 'local';
  needsKey: boolean;
  needsWebGPU: boolean;
  /** One-word setup requirement shown in the row. */
  requirement: string;
}

export const SOURCE_META: Record<ModelSource, SourceMeta> = {
  gemini: {
    label: 'Gemini',
    kind: 'cloud',
    runner: 'local',
    needsKey: true,
    needsWebGPU: false,
    requirement: 'needs key',
  },
  webgpu: {
    label: 'On-device',
    kind: 'on-device',
    runner: 'local',
    needsKey: false,
    needsWebGPU: true,
    requirement: 'in browser',
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'cloud',
    runner: 'local',
    needsKey: true,
    needsWebGPU: false,
    requirement: 'needs key',
  },
  ollama: {
    label: 'Ollama',
    kind: 'local',
    runner: 'local',
    needsKey: false,
    needsWebGPU: false,
    requirement: 'localhost',
  },
  llama: {
    label: 'Llama',
    kind: 'local',
    runner: 'local',
    needsKey: false,
    needsWebGPU: false,
    requirement: 'self-hosted',
  },
};

const STORAGE_KEY = 'inbrowser-model-source:v1';

function isModelSource(x: unknown): x is ModelSource {
  return x === 'gemini' || x === 'webgpu' || x === 'openrouter' || x === 'ollama' || x === 'llama';
}

function isPreset(x: unknown): x is OnDevicePreset {
  return x === 'smollm2_360m';
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
      geminiKey:
        typeof p.geminiKey === 'string' ? p.geminiKey : DEFAULT_MODEL_SOURCE_CONFIG.geminiKey,
      geminiModel:
        typeof p.geminiModel === 'string' && p.geminiModel.trim()
          ? p.geminiModel
          : DEFAULT_MODEL_SOURCE_CONFIG.geminiModel,
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
      llamaBaseUrl:
        typeof p.llamaBaseUrl === 'string' && p.llamaBaseUrl.trim()
          ? p.llamaBaseUrl
          : DEFAULT_MODEL_SOURCE_CONFIG.llamaBaseUrl,
      llamaModel:
        typeof p.llamaModel === 'string' && p.llamaModel.trim()
          ? p.llamaModel
          : DEFAULT_MODEL_SOURCE_CONFIG.llamaModel,
      llamaKey: typeof p.llamaKey === 'string' ? p.llamaKey : DEFAULT_MODEL_SOURCE_CONFIG.llamaKey,
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
 * Build the `ModelClient` for the lean cloud/local sources (Gemini, OpenRouter,
 * Ollama). All three now run browser-direct (BYOK for the cloud ones). WebGPU is
 * intentionally NOT handled here — it's built by the caller from the loaded
 * engine via `createOnDeviceModelClient`.
 *
 * All providers import from the `@inbrowser/model` root. The root barrel is
 * bundle-safe: the on-device transformers runtime is lazy-loaded inside the
 * engine, so importing a cloud provider never statically pulls ONNX/WASM here.
 */
export function buildLocalModelClient(config: ModelSourceConfig): ModelClient {
  if (config.source === 'gemini') {
    return geminiModelClient({
      apiKey: config.geminiKey,
      model: config.geminiModel,
      temperature: 0.2,
    });
  }
  if (config.source === 'openrouter') {
    return openrouterModelClient({ apiKey: config.openrouterKey, model: config.openrouterModel });
  }
  if (config.source === 'ollama') {
    return ollamaModelClient({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel });
  }
  if (config.source === 'llama') {
    return llamaServerModelClient({
      baseUrl: config.llamaBaseUrl,
      model: config.llamaModel,
      apiKey: config.llamaKey || undefined,
      temperature: 0.2,
    });
  }
  throw new Error(`buildLocalModelClient: source "${config.source}" is not a lean local source`);
}

/**
 * Fetch the model ids an OpenAI-compatible server advertises at `/v1/models`,
 * browser-direct (the server must allow CORS for this origin). Used to
 * auto-populate the Llama source's model picker. Throws on a non-OK response or
 * network failure so callers can fall back to manual entry.
 */
export async function fetchOaiModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { id?: string }[];
    models?: { id?: string; name?: string }[];
  };
  const list = json.data ?? json.models ?? [];
  return list
    .map((m) => m.id ?? (m as { name?: string }).name)
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
}
