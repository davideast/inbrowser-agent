/**
 * `createEngine` — POC stub.
 *
 * Owns lifecycle state and event subscriptions. `ensureReady()` and
 * `generate()` are NOT YET WIRED to `@huggingface/transformers`; the
 * implementation slice lands next. Until then, calling `generate()`
 * yields a single `error` event so consumers can wire up the surface
 * end-to-end without a model load.
 *
 * The state machine is real and useful today — adapters and the
 * worker transport rely on `on('state')` + `on('load')` regardless
 * of whether the underlying runtime is wired.
 */

import type {
  CreateEngineOpts,
  Engine,
  EngineCapabilities,
  EngineEvent,
  EngineEventMap,
  EngineMessage,
  EngineState,
  GenerateOpts,
  LoadProgress,
  ModelRef,
} from './types.js';

class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
}

export function createEngine(opts: CreateEngineOpts): Engine {
  const model: ModelRef = opts.model;
  const capabilities: EngineCapabilities = opts.capabilities;

  let state: EngineState = 'idle';
  let loadPromise: Promise<void> | null = null;

  const stateSubs = new Set<(s: EngineState) => void>();
  const loadSubs = new Set<(p: LoadProgress) => void>();

  // Mirror onLoadProgress hook into the subscriber set so the two
  // delivery paths share one source of truth.
  if (opts.onLoadProgress) loadSubs.add(opts.onLoadProgress);

  function setState(next: EngineState): void {
    if (state === next) return;
    state = next;
    for (const sub of stateSubs) sub(next);
  }

  function emitLoad(p: LoadProgress): void {
    for (const sub of loadSubs) sub(p);
  }

  async function ensureReady(): Promise<void> {
    if (state === 'ready') return;
    if (state === 'disposed') throw new Error('engine disposed');
    if (loadPromise) return loadPromise;

    setState('loading');
    loadPromise = (async () => {
      // POC: the load pipeline is not wired. A real implementation
      // calls `AutoProcessor.from_pretrained` + the model class
      // (Gemma4ForConditionalGeneration et al), surfaces fetch
      // progress, runs a warmup forward pass, then flips to ready.
      emitLoad({ phase: 'init', backend: opts.backend });
      throw new NotImplementedError(
        `engine load not yet wired for ${model.modelId} (${opts.backend}/${opts.dtype})`,
      );
    })().catch((e) => {
      setState('error');
      throw e;
    });
    return loadPromise;
  }

  function on<K extends keyof EngineEventMap>(
    event: K,
    handler: (value: EngineEventMap[K]) => void,
  ): () => void {
    if (event === 'state') {
      const h = handler as (s: EngineState) => void;
      stateSubs.add(h);
      return () => stateSubs.delete(h);
    }
    const h = handler as (p: LoadProgress) => void;
    loadSubs.add(h);
    return () => loadSubs.delete(h);
  }

  async function* generate(
    _messages: ReadonlyArray<EngineMessage>,
    _opts?: GenerateOpts,
  ): AsyncIterable<EngineEvent> {
    try {
      await ensureReady();
    } catch (e) {
      yield {
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
        recoverable: false,
      };
      return;
    }
    yield {
      kind: 'error',
      message: 'engine.generate not yet implemented (POC stub)',
      recoverable: false,
    };
  }

  async function dispose(): Promise<void> {
    setState('disposed');
    stateSubs.clear();
    loadSubs.clear();
  }

  return {
    get model() {
      return model;
    },
    get state() {
      return state;
    },
    get capabilities() {
      return capabilities;
    },
    ensureReady,
    on,
    generate,
    dispose,
  };
}

/**
 * Type-safe preset authoring. Identity at runtime; the value of this
 * helper is purely the compile-time completeness check it enforces
 * on caller-defined presets.
 */
export function definePreset<P extends import('./types.js').ModelPreset>(p: P): P {
  return p;
}
