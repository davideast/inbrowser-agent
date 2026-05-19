/**
 * `createEngine` — on-device LLM engine implementation.
 *
 * Wires `@huggingface/transformers` v4 to the narrow `Engine` surface
 * declared in `./types.ts`:
 *
 *   - `ensureReady()` loads the `AutoProcessor` + `AutoModelForCausalLM`
 *     pair from the configured HF Hub repo, mapping the runtime's
 *     `ProgressInfo` stream into `LoadProgress` events.
 *   - `generate()` applies the model's bundled chat template, sets up
 *     a `TextStreamer` whose `callback_function` pushes tokens into
 *     an async-iterator queue, and drives `model.generate()`. Yields
 *     `{ kind: 'token' }` per decoded chunk, then a terminal `usage`
 *     event with the engine's local accounting.
 *
 * Backend mapping: `Backend` ('auto' | 'webgpu' | 'wasm') passes
 * straight through to Transformers.js's `DeviceType`. `dtype` is
 * forwarded unchanged.
 *
 * Tool calling: the engine itself is toolless. The agent-side
 * polyfill lives in `@inbrowser/agent` (see AGENTS.md).
 *
 * Stop sequences: `GenerateOpts.stop` is accepted but not yet
 * honored — needs a `StoppingCriteria` adapter. Tracked as a
 * follow-up.
 */

import {
  AutoModelForCausalLM,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type ProgressInfo,
  TextStreamer,
  env as transformersEnv,
} from '@huggingface/transformers';

import type {
  Backend,
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

export function createEngine(opts: CreateEngineOpts): Engine {
  const model: ModelRef = opts.model;
  const capabilities: EngineCapabilities = opts.capabilities;

  let state: EngineState = 'idle';
  let loadPromise: Promise<void> | null = null;
  let tokenizer: PreTrainedTokenizer | null = null;
  let llm: PreTrainedModel | null = null;

  const stateSubs = new Set<(s: EngineState) => void>();
  const loadSubs = new Set<(p: LoadProgress) => void>();
  if (opts.onLoadProgress) loadSubs.add(opts.onLoadProgress);

  function setState(next: EngineState): void {
    if (state === next) return;
    state = next;
    for (const sub of stateSubs) sub(next);
  }

  function emitLoad(p: LoadProgress): void {
    for (const sub of loadSubs) sub(p);
  }

  function progressCallback(info: ProgressInfo): void {
    // Transformers.js emits five statuses across the load pipeline.
    // Only 'progress' carries byte counts; the others are markers.
    // `LoadProgress.fetch` covers the entire download phase end-to-end.
    if (info.status === 'progress') {
      emitLoad({
        phase: 'fetch',
        file: info.file,
        loadedBytes: info.loaded,
        totalBytes: info.total,
      });
    } else if (info.status === 'initiate' || info.status === 'download') {
      emitLoad({
        phase: 'fetch',
        file: info.file,
        loadedBytes: 0,
        totalBytes: 0,
      });
    }
    // 'done' and 'ready' are deliberately ignored — phase transitions
    // are driven from `ensureReady` so the order is deterministic.
  }

  async function ensureReady(): Promise<void> {
    if (state === 'ready') return;
    if (state === 'disposed') throw new Error('engine disposed');
    if (loadPromise) return loadPromise;

    setState('loading');
    // `weightsBaseUrl` overrides the HF Hub origin for self-hosted
    // mirrors. Transformers.js exposes this as the global
    // `env.remoteHost`; we set it process-wide before load. Documented
    // limitation: with multiple engines spanning different remotes,
    // the last one to load wins. Realistic use case (one app, one
    // mirror) is unaffected.
    if (opts.weightsBaseUrl) {
      transformersEnv.remoteHost = opts.weightsBaseUrl;
    }
    loadPromise = (async () => {
      // AutoTokenizer (not AutoProcessor): text-only models like
      // SmolLM2 ship no preprocessor_config.json and AutoProcessor
      // 404s on them. Multimodal models (e.g., Gemma 4 audio) still
      // resolve via AutoTokenizer because their text tokenizer is
      // the same file — we just don't expose the audio path yet.
      tokenizer = await AutoTokenizer.from_pretrained(model.modelId, {
        ...(model.revision ? { revision: model.revision } : {}),
        progress_callback: progressCallback,
      });

      emitLoad({ phase: 'init', backend: opts.backend });

      llm = await AutoModelForCausalLM.from_pretrained(model.modelId, {
        dtype: opts.dtype,
        device: toDeviceOption(opts.backend),
        ...(model.revision ? { revision: model.revision } : {}),
        progress_callback: progressCallback,
      });

      setState('ready');
      emitLoad({ phase: 'ready' });
    })().catch((e) => {
      setState('error');
      loadPromise = null;
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
    messages: ReadonlyArray<EngineMessage>,
    genOpts: GenerateOpts = {},
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

    if (!tokenizer || !llm) {
      yield { kind: 'error', message: 'engine not ready', recoverable: false };
      return;
    }

    // ── Build prompt ──────────────────────────────────────────────
    const renderedPrompt = applyChatTemplate(tokenizer, messages, opts.chatTemplate);
    // Calling the tokenizer as a function returns a BatchEncoding
    // (`{ input_ids, attention_mask, ... }`) of Tensors.
    const inputs = (await tokenizer(renderedPrompt)) as Record<string, unknown>;
    const promptTokens = countTokens(inputs.input_ids);

    // ── Set up streaming queue ────────────────────────────────────
    const queue: EngineEvent[] = [];
    let resolver: (() => void) | null = null;
    let producerDone = false;
    let producerError: unknown = null;
    let outputTokens = 0;

    function wakeIterator(): void {
      const r = resolver;
      resolver = null;
      if (r) r();
    }

    const pushEvent = (evt: EngineEvent): void => {
      queue.push(evt);
      wakeIterator();
    };

    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      callback_function: (text: string) => {
        if (text.length === 0) return;
        pushEvent({ kind: 'token', text });
      },
      token_callback_function: (tokenIds: bigint[]) => {
        outputTokens += tokenIds.length;
      },
    });

    const startedAt = performance.now();
    const generateArgs: Record<string, unknown> = {
      ...inputs,
      max_new_tokens: genOpts.maxNewTokens ?? 512,
      streamer,
    };
    if (typeof genOpts.temperature === 'number') {
      generateArgs.do_sample = true;
      generateArgs.temperature = genOpts.temperature;
    }
    if (typeof genOpts.topP === 'number') generateArgs.top_p = genOpts.topP;
    if (typeof genOpts.topK === 'number') generateArgs.top_k = genOpts.topK;

    // Drive `model.generate` concurrently with the iterator drain.
    const generatePromise = (async () => {
      try {
        await llm!.generate(generateArgs as Parameters<typeof llm.generate>[0]);
      } catch (e) {
        producerError = e;
      } finally {
        producerDone = true;
        wakeIterator();
      }
    })();

    try {
      while (!producerDone || queue.length > 0) {
        if (queue.length === 0) {
          if (genOpts.signal?.aborted) break;
          await new Promise<void>((r) => {
            resolver = r;
          });
        }
        const next = queue.shift();
        if (next) yield next;
      }
    } finally {
      await generatePromise;
    }

    if (producerError) {
      yield {
        kind: 'error',
        message: producerError instanceof Error ? producerError.message : String(producerError),
        recoverable: false,
      };
      return;
    }

    yield {
      kind: 'usage',
      promptTokens,
      outputTokens,
      decodeMs: Math.round(performance.now() - startedAt),
    };
  }

  async function dispose(): Promise<void> {
    setState('disposed');
    stateSubs.clear();
    loadSubs.clear();
    // Transformers.js doesn't expose a public dispose; dropping
    // references lets GC reclaim the wasm/webgpu sessions.
    tokenizer = null;
    llm = null;
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function toDeviceOption(backend: Backend): 'auto' | 'webgpu' | 'wasm' {
  // Backend names map 1:1 to Transformers.js DeviceType strings.
  return backend;
}

function applyChatTemplate(
  tokenizer: PreTrainedTokenizer,
  messages: ReadonlyArray<EngineMessage>,
  override?: (m: ReadonlyArray<EngineMessage>) => string,
): string {
  if (override) return override(messages);
  // EngineMessage's media field is dropped here — text-only path
  // for POC. A multimodal preset will need a different code path.
  const conversation = messages.map((m) => ({
    role: m.role,
    content: m.text,
  }));
  const rendered = tokenizer.apply_chat_template(conversation, {
    add_generation_prompt: true,
    tokenize: false,
  });
  if (typeof rendered !== 'string') {
    throw new Error('apply_chat_template returned non-string with tokenize:false');
  }
  return rendered;
}

function countTokens(inputIds: unknown): number {
  // input_ids is a Transformers.js Tensor with dims [batch, seq_len].
  if (!inputIds || typeof inputIds !== 'object') return 0;
  const dims = (inputIds as { dims?: unknown }).dims;
  if (!Array.isArray(dims) || dims.length < 2) return 0;
  const seqLen = dims[dims.length - 1];
  return typeof seqLen === 'number' ? seqLen : 0;
}
