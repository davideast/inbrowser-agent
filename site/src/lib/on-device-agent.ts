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
  type ChatMessage,
  createAgentSession,
  createDispatch,
  createMetricsCollector,
  createRetrievalStrategy,
} from '@inbrowser/agent';
import type { Engine, EngineState, LoadProgress } from '@inbrowser/model';
import { createEngineModelClient } from '@inbrowser/model/engine-client';
import { qwen2_5_0_5b, smollm2_360m } from '@inbrowser/model/presets';
import { connectWorkerEngine } from '@inbrowser/model/worker';
import { createGraphToolRegistry } from '../agent/graph-tools';
import type { VisitedCard } from './agent-types';
import type { AgentStreamHandlers } from './stream-client';

export type OnDevicePreset = 'smollm2_360m' | 'qwen2_5_0_5b';

const PRESETS = { smollm2_360m, qwen2_5_0_5b } as const;

export const PRESET_META: Record<OnDevicePreset, { label: string; note: string }> = {
  smollm2_360m: { label: 'SmolLM2 360M', note: '~180 MB · runs anywhere (WASM)' },
  qwen2_5_0_5b: { label: 'Qwen2.5 0.5B', note: '~350 MB · WebGPU recommended' },
};

const SYSTEM_PROMPT =
  'You are the documentation assistant for the "inbrowser" monorepo. Answer the ' +
  "user's question concisely and accurately, using only the provided documentation excerpts.";

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
 * Run one question through the on-device agent, dispatching to the same handlers
 * the cloud path uses (so the chat UI is identical). The engine must already be
 * loaded via `loadOnDeviceEngine`.
 */
export async function streamOnDeviceAgent(
  question: string,
  history: { role: 'user' | 'assistant'; text: string }[],
  handlers: AgentStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  if (!current) {
    handlers.onError?.('on-device model is not loaded yet');
    return;
  }
  const llm = createEngineModelClient(current.engine);
  const registry = createGraphToolRegistry();
  const hist: ChatMessage[] = history
    .filter((m) => m.text.trim())
    .map((m, i) => ({ id: `h${i}`, role: m.role, text: m.text }));

  const session = createAgentSession({
    strategy: createRetrievalStrategy(),
    llm,
    tools: createDispatch(registry),
    toolList: registry.list(),
    toolContext: () => ({ signal }),
    systemPromptBuilder: () => SYSTEM_PROMPT,
    metrics: createMetricsCollector(),
    history: hist,
  });

  const toolNames = new Map<string, string>();
  const seen = new Set<string>();

  try {
    for await (const ev of session.submit(question, signal)) {
      if (ev.kind === 'text') {
        if (ev.chunk) handlers.onToken?.(ev.chunk);
      } else if (ev.kind === 'tool_started') {
        toolNames.set(ev.callId, ev.name);
        handlers.onTool?.(ev.name, readArg(ev.args));
      } else if (ev.kind === 'tool_finished') {
        if (
          toolNames.get(ev.callId) === 'get_doc' &&
          ev.result.ok &&
          ev.result.data &&
          typeof ev.result.data === 'object'
        ) {
          const card = toCard(ev.result.data as Partial<VisitedCard>);
          if (card.route && !seen.has(card.route)) {
            seen.add(card.route);
            handlers.onVisited?.(card);
          }
        }
      } else if (ev.kind === 'error') {
        handlers.onError?.(ev.message);
        return;
      } else if (ev.kind === 'completed') {
        handlers.onDone?.();
        return;
      }
    }
    handlers.onDone?.();
  } catch (e) {
    handlers.onError?.(e instanceof Error ? e.message : String(e));
  }
}

function readArg(args: unknown): string {
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    if (typeof a.route === 'string') return a.route;
    if (typeof a.query === 'string') return a.query;
  }
  return '';
}

function toCard(d: Partial<VisitedCard>): VisitedCard {
  return {
    route: d.route ?? '',
    title: d.title ?? d.route ?? '',
    package: d.package ?? '',
    packageLabel: d.packageLabel ?? '',
    breadcrumb: d.breadcrumb ?? [],
    summary: d.summary ?? '',
  };
}
