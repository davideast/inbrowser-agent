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
  createEngine,
  type Backend,
  type Engine,
  type LoadProgress,
  type ModelPreset,
} from '@inbrowser/model';
import {
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
    setStatus(`decoding (${engine.capabilities.contextWindow.toLocaleString()} ctx)`);

    const messages = [
      { role: 'user' as const, text: promptEl.value },
    ];

    const startedAt = performance.now();
    for await (const evt of engine.generate(messages, { maxNewTokens: 512 })) {
      if (evt.kind === 'token') {
        outputEl.textContent += evt.text;
        continue;
      }
      if (evt.kind === 'usage') {
        const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
        const tps = (evt.outputTokens / (evt.decodeMs / 1000)).toFixed(1);
        usageEl.textContent = `${evt.promptTokens} in / ${evt.outputTokens} out — ${elapsed}s wall (${tps} tok/s decode)`;
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
