/**
 * Demo entrypoint — vanilla TS + DOM.
 *
 *   1. Probe WebGPU; warn if absent.
 *   2. `createEngine(gemma4_E2B)`.
 *   3. Subscribe to `engine.on('load')` → progress bar.
 *   4. `ensureReady()` on user click (don't auto-fetch — weights are
 *      hundreds of MB to several GB depending on preset).
 *   5. On generate: render tokens into <pre>, then usage line.
 */

import {
  type Backend,
  type Engine,
  type LoadProgress,
  type ModelPreset,
  createEngine,
  splitThinking,
} from '@inbrowser/model';
import {
  deepseek_r1_qwen_1_5b,
  gemma4_E2B,
  gemma4_E4B,
  qwen2_5_coder_1_5b,
  qwen3_1_7b,
  smollm2_360m,
} from '@inbrowser/model/presets';

const PRESETS: Record<string, ModelPreset> = {
  gemma4_e2b: gemma4_E2B,
  gemma4_e4b: gemma4_E4B,
  smollm2_360m,
  qwen2_5_coder_1_5b,
  qwen3_1_7b,
  deepseek_r1_qwen_1_5b,
};

/**
 * Preset precedence: ?preset= query param, else gemma4_e2b.
 * Lets the verify script (or a curious user) pick a smaller model
 * without a code edit.
 */
function pickPreset(): { name: string; preset: ModelPreset } {
  const fromQuery = new URLSearchParams(window.location.search).get('preset');
  if (fromQuery && PRESETS[fromQuery]) {
    return { name: fromQuery, preset: PRESETS[fromQuery] };
  }
  return { name: 'gemma4_e2b', preset: gemma4_E2B };
}

/**
 * Decode-length cap. Default 2048 — generous enough that natural
 * EOS stops most replies before this kicks in, but bounded so a
 * runaway generation can't hold the tab forever. Override via
 * `?maxTokens=N` for code-heavy prompts that legitimately need more.
 *
 * A higher cap doesn't force the model to talk longer; the model
 * emits its own EOS token when it thinks it's done. This only
 * raises the ceiling.
 */
function pickMaxTokens(): number {
  const raw = new URLSearchParams(window.location.search).get('maxTokens');
  if (!raw) return 2048;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2048;
}

/**
 * Sampling temperature. Returns `undefined` (omit the option, engine
 * stays in greedy/deterministic decode) by default — matches what
 * the demo did before this knob existed. Override with
 * `?temperature=N`:
 *
 *   0     deterministic (greedy)
 *   0.2   focused — good for code / structured output
 *   0.7   balanced (most chat-UI defaults)
 *   1.0+  creative / divergent
 *
 * Setting any value enables sampling on the engine side. Returning
 * `undefined` instead of `0` is intentional: the engine treats
 * "explicit 0" and "omitted" differently in some Transformers.js
 * code paths, and "omitted" is what the previous behavior assumed.
 */
function pickTemperature(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get('temperature');
  if (raw === null) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Backend selection precedence:
 *   1. ?backend=webgpu|wasm|auto query param (verification + debugging override)
 *   2. webgpu when `navigator.gpu` is present
 *   3. wasm fallback
 *
 * Headless WebGPU (SwiftShader/Vulkan) advertises `navigator.gpu`
 * but typically lacks the `shader-f16` feature and caps
 * `maxBufferSize` at 1 GiB — both of which Gemma 4 E2B needs. The
 * query-param override lets a headless verify run force wasm
 * without flipping a hidden flag.
 */
function pickBackend(): Backend {
  const fromQuery = new URLSearchParams(window.location.search).get('backend');
  if (fromQuery === 'webgpu' || fromQuery === 'wasm' || fromQuery === 'auto') {
    return fromQuery;
  }
  return navigator.gpu ? 'webgpu' : 'wasm';
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const statusEl = $<HTMLDivElement>('status');
const progressEl = $<HTMLProgressElement>('progress');
const promptEl = $<HTMLTextAreaElement>('prompt');
const buttonEl = $<HTMLButtonElement>('generate');
const outputEl = $<HTMLPreElement>('output');
const usageEl = $<HTMLDivElement>('usage');
const thinkingDetailsEl = $<HTMLDetailsElement>('thinking-details');
const thinkingEl = $<HTMLPreElement>('thinking');

function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', kind === 'error');
}

function renderLoadProgress(p: LoadProgress): void {
  if (p.phase === 'fetch') {
    progressEl.hidden = false;
    if (p.totalBytes > 0) {
      const pct = (p.loadedBytes / p.totalBytes) * 100;
      progressEl.value = pct;
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      setStatus(`fetching ${p.file} — ${mb(p.loadedBytes)} / ${mb(p.totalBytes)} MB`);
    } else {
      progressEl.removeAttribute('value');
      setStatus(`fetching ${p.file}`);
    }
    return;
  }
  if (p.phase === 'init') {
    progressEl.hidden = true;
    setStatus(`initializing ORT (${p.backend})…`);
    return;
  }
  if (p.phase === 'warmup') {
    setStatus(`warmup decode (${p.tokensGenerated} tokens)`);
    return;
  }
  if (p.phase === 'ready') {
    progressEl.hidden = true;
    setStatus('ready');
  }
}

if (!navigator.gpu) {
  setStatus(
    'WebGPU not available — engine will fall back to WASM/CPU. Expect 5–20× slower decode. Chrome 113+ on the desktop is the supported target.',
    'error',
  );
}

let engine: Engine | null = null;
let busy = false;

function setBusy(b: boolean): void {
  busy = b;
  buttonEl.disabled = b;
  promptEl.disabled = b;
}

buttonEl.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);

  try {
    if (!engine) {
      const backend = pickBackend();
      const { name, preset } = pickPreset();
      setStatus(`creating engine (preset=${name}, backend=${backend})`);
      engine = createEngine({
        ...preset,
        backend,
        onLoadProgress: renderLoadProgress,
      });
      buttonEl.textContent = 'Generating…';
      await engine.ensureReady();
    }

    buttonEl.textContent = 'Generating…';
    outputEl.textContent = '';
    usageEl.textContent = '';
    thinkingEl.textContent = '';
    // Show or hide the thinking section based on whether the active
    // preset declares it. Default open while a thinking model is
    // mid-decode so the reasoning trace is visible without an extra
    // click; consumers can collapse it manually.
    const thinkingMode = engine.capabilities.supportsThinking;
    thinkingDetailsEl.hidden = !thinkingMode;
    thinkingDetailsEl.open = thinkingMode;

    const maxTokens = pickMaxTokens();
    const temperature = pickTemperature();
    const sampling = temperature === undefined ? 'greedy' : `temp=${temperature}`;
    setStatus(
      `decoding (${engine.capabilities.contextWindow.toLocaleString()} ctx, ${sampling}, maxTokens=${maxTokens}${
        thinkingMode ? ', thinking-aware' : ''
      })`,
    );

    const messages = [{ role: 'user' as const, text: promptEl.value }];

    const startedAt = performance.now();
    // Wrap the raw token stream with splitThinking only when the
    // active preset declares it can emit reasoning blocks. For
    // non-thinking models the wrapper would still work (no tags =
    // pass-through) but adds a layer of buffering for no benefit;
    // skipping it keeps the simpler path tight.
    //
    // Tag format is preset-declared (DeepSeek: `<think>...</think>`;
    // Gemma 4: `<|channel>thought\n...\n<channel|>`). When the
    // preset declares `enableThinking` via opts, the engine ALSO
    // passes `enable_thinking: true` to the chat template and
    // preserves the model's channel-marker special tokens in the
    // output stream so splitThinking can see them.
    const rawStream = engine.generate(messages, {
      maxNewTokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(thinkingMode ? { enableThinking: true } : {}),
    });
    const stream = thinkingMode
      ? splitThinking(rawStream, engine.capabilities.thinkingTags ?? {})
      : rawStream;
    for await (const evt of stream) {
      if (evt.kind === 'token') {
        outputEl.textContent += evt.text;
        continue;
      }
      if (evt.kind === 'thinking') {
        thinkingEl.textContent += evt.text;
        continue;
      }
      if (evt.kind === 'usage') {
        const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
        const tps = (evt.outputTokens / (evt.decodeMs / 1000)).toFixed(1);
        // If outputTokens hit the cap, the decode was truncated rather
        // than terminated by an EOS token. Surface that visually so
        // the user knows to retry with a higher maxTokens.
        const truncated = evt.outputTokens >= maxTokens;
        const cap = truncated
          ? ` ⚠️ hit ${maxTokens}-token cap — append ?maxTokens=N to extend`
          : '';
        usageEl.textContent = `${evt.promptTokens} in / ${evt.outputTokens} out — ${elapsed}s wall (${tps} tok/s decode)${cap}`;
        continue;
      }
      if (evt.kind === 'error') {
        setStatus(evt.message, 'error');
        return;
      }
    }
    setStatus('ready');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    buttonEl.textContent = 'Generate';
    setBusy(false);
  }
});

buttonEl.textContent = 'Load + generate';
buttonEl.disabled = false;
setStatus(
  'click Load + generate to start. First load fetches weights from the HF Hub: ~180 MB for smollm2_360m, ~3 GB for gemma4_e2b. Cached after first run.',
);
