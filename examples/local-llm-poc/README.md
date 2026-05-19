# local-llm-poc

End-to-end demo of `@inbrowser/model` — loads a local LLM in the
browser via WebGPU (or WASM) and streams a response from a prompt.

## Available presets

| Preset | Download (q4f16) | Headless WASM | Real-GPU WebGPU | Notes |
|---|---|---|---|---|
| `smollm2_360m` | ~180 MB | ✅ verified end-to-end | ✅ | Default. The verification canary. |
| `qwen2_5_coder_1_5b` | ~1.28 GB | ❌ ORT shape bug | ✅ | Code/FIM focus; Qwen2.5 lineage |
| `qwen3_1_7b` | ~1.36 GB | ❌ WASM heap OOM | ✅ | Current frontier-for-size general model |
| `deepseek_r1_qwen_1_5b` | ~1.37 GB | ❌ (same band) | ✅ | **Reasoning model.** Emits `<think>…</think>` blocks before the answer; the UI splits them into a collapsible pane via `splitThinking`. |
| `gemma4_e2b` | ~3 GB | ❌ hangs | ✅ (with caveats) | Multimodal-capable; needs 1.2 GiB `maxBufferSize` + `shader-f16` |
| `gemma4_e4b` | ~6 GB | ❌ | ✅ (real discrete GPU) | Bigger Gemma; same constraints, 2× the budget |

**Headless WASM ceiling** is around ~500 MB at q4f16 on this Playwright
setup. Models above that load fine but ORT-Web hits buffer-reuse bugs or
the V8 WASM heap (~4 GB) during session creation. Everything ≥1 GB
needs a real GPU + real browser.

## Quick start (SmolLM2)

```bash
bun install
bun run --cwd examples/local-llm-poc dev
```

Open <http://localhost:5175>, click Load + generate. Expect ~180 MB
download, ~8s to first token on first run, near-instant on reloads.

## Reasoning models — `deepseek_r1_qwen_1_5b`

DeepSeek R1 Distill (and similar reasoning models) emit their
chain-of-thought inside literal `<think>…</think>` tags before the
final answer. The example wraps the engine's stream with
`splitThinking` from `@inbrowser/model` when the active preset
declares `supportsThinking: true`, then routes the two event kinds
to separate panes:

- A collapsible **"💭 Reasoning trace"** section above the output —
  default-open while a thinking model is decoding so the trace is
  visible immediately; click to collapse.
- The main **Output** pane — only the post-`</think>` answer.

Try a math or logic prompt to see the difference. Suggested first
prompts:

> "If a train leaves station A at 9 AM going 60 mph and another
> leaves station B (180 miles away) at 10 AM going 40 mph toward
> A, when do they meet?"
>
> "Prove that sqrt(2) is irrational."

The reasoning trace will typically be 5–20× longer than the answer.
For non-thinking presets the section is hidden entirely.

URL: `?preset=deepseek_r1_qwen_1_5b&backend=webgpu`

## Testing Qwen presets in a real browser

The Qwen presets (`qwen2_5_coder_1_5b`, `qwen3_1_7b`) need a real GPU
because of the headless-WASM ceiling described above — not because of
WebGPU feature gaps. Their embedding tables fit under the 1 GiB
`maxBufferSize` cap (Qwen uses a 152K vocabulary, much smaller than
Gemma 4's 256K), so they run on a much broader range of GPUs than
Gemma 4 does.

### Hardware bar (Qwen presets)

| Resource | Minimum | Notes |
|---|---|---|
| GPU | ~2 GB VRAM | Integrated GPUs from ~2020+ usually qualify |
| GPU features | `shader-f16` | Same f16-shader requirement as Gemma; required for q4f16 |
| `maxBufferSize` | ≥600 MiB | Most modern GPUs ship with ≥1 GiB |
| Disk | ~1.5 GB free | Per preset |

### Run

```bash
# Coder model — `?prompt=` not supported on the page; type your prompt
# in the textarea. Suggested first prompt: a small coding question.
bun run --cwd examples/local-llm-poc dev
# → open http://localhost:5175/?preset=qwen2_5_coder_1_5b&backend=webgpu

# Qwen 3 general
# → open http://localhost:5175/?preset=qwen3_1_7b&backend=webgpu
```

Expected first-load timings on real hardware:

- **Fetch**: 1.3 GB at network rate (cached for subsequent runs).
- **ORT init**: a few seconds (WebGPU shader compilation).
- **First token**: typically <1s after init on discrete GPUs, 1–3s on integrated.
- **Decode**: 25–60 tok/s on Apple Silicon / RTX 30xx+, 10–25 tok/s on integrated.

For Qwen 2.5 Coder, prompts that exercise the strength of the model:

> "Write a TypeScript function that debounces another function with a configurable wait."
>
> "Given this Python function, identify the bug:\n```py\ndef sum_evens(nums):\n  return sum(n for n in nums if n % 2)\n```"

For Qwen 3, the "thinking mode" is off by default in our preset; flip
it on by spreading a custom `chatTemplate` (passes `enable_thinking: true`
to `apply_chat_template`) if you want to compare modes.

## Testing Gemma 4 in a real browser

Headless WebGPU on Linux (SwiftShader) **cannot** run Gemma 4 — it
caps `maxBufferSize` at 1 GiB and lacks the `shader-f16` feature, both
of which Gemma 4 needs. You need a real machine + real browser.

### Hardware prerequisites

| Resource | Minimum | Notes |
|---|---|---|
| GPU | ~6 GB VRAM | Apple Silicon (M1+), recent Nvidia (RTX 20xx+), AMD RDNA2+, Intel Arc / Iris Xe |
| GPU features | `shader-f16` + ≥1.2 GiB `maxBufferSize` | Almost any GPU shipped in the last 4 years has both |
| Disk | ~3.5 GB free | For the cached weights |
| RAM | 8 GB | The browser tab will sit at ~3 GB while loaded |
| Network (first run) | A few GB at a stable rate | 3 GB download from HF Hub |

Integrated GPUs from before ~2020 will likely fail with
`maxBufferSize exceeded`.

### Browser prerequisites

| Browser | Status | Setup |
|---|---|---|
| **Chrome 113+ desktop** | ✅ Best target | Works out of the box on macOS / Linux / Windows |
| **Edge 113+ desktop** | ✅ Same engine | Works out of the box |
| **Safari Tech Preview** | ✅ Working | Standard Safari may not enable WebGPU yet |
| **Firefox** | ⚠️ Behind flag | `about:config` → `dom.webgpu.enabled = true` (still rough) |
| **Mobile** | ⚠️ Patchy | WebGPU support varies; fallback to WASM works but slow |

### Step-by-step

```bash
# 1. Clone + install (one time)
bun install
bun run --cwd packages/resumable build
bun run --cwd packages/relay build
bun run --cwd packages/agent build
bun run --cwd packages/model build

# 2. Start the dev server
bun run --cwd examples/local-llm-poc dev
# → "Local: http://localhost:5175/"

# 3. Open the URL with the Gemma 4 preset selected
#    http://localhost:5175/?preset=gemma4_e2b&backend=webgpu
```

The `?preset=gemma4_e2b&backend=webgpu` query string forces the
Gemma path (default is SmolLM2 for safety). Without it the page
loads SmolLM2.

### What you should see

| Phase | Visible | Wall-clock (first run) | Wall-clock (cached) |
|---|---|---|---|
| Page load | UI renders, "click Load + generate" status | <100 ms | <100 ms |
| Click Generate | Status: "creating engine (preset=gemma4_e2b, backend=webgpu)" | instant | instant |
| Fetch | Status: "fetching onnx/..." + progress bar | **~3 GB at network rate** | ~6 s (from cache) |
| Init | Status: "initializing ORT (webgpu)…" | a few seconds | a few seconds |
| Decode | Tokens stream into the output `<pre>` | starts within seconds of init | same |
| Done | Usage line: `N in / M out — Xs wall (Y tok/s decode)` | depends on prompt + GPU | same |

Expected decode rate:

- **Apple Silicon M2/M3 Pro/Max, RTX 3070+, RDNA3** — 20–40 tok/s
- **M1 base, RTX 2060, Iris Xe Gen 12** — 8–20 tok/s
- **Older integrated GPUs that meet the bar** — 3–10 tok/s

### Verifying it's actually using WebGPU

Open DevTools → Console. Right before the first token, ONNX Runtime
Web logs the execution provider it picked. Look for `webgpu` in the
init logs — not `wasm`.

You can also probe from the console while a generate is in flight:

```js
await navigator.gpu.requestAdapter().then(a => a?.info)
// → { vendor: "nvidia", architecture: "ada-lovelace", … }
```

If `navigator.gpu` is undefined, the page already silently fell back
to WASM. Re-check the URL has `&backend=webgpu` (otherwise auto-detect
runs, and if the auto-detect saw `navigator.gpu` truthy but the
device failed real allocation, the error surfaces mid-decode).

### Common failure modes

**`Buffer size (... ) exceeds the max buffer size limit (1073741824)`**

Your GPU advertises WebGPU but caps `maxBufferSize` at 1 GiB. The
embedding table doesn't fit. Diagnosis:

```js
(await navigator.gpu.requestAdapter()).limits.maxBufferSize
// Need ≥ 1300000000 (~1.21 GiB) for Gemma 4 E2B
```

No workaround on the user side — this is a hardware/driver gap. Try a
different machine, or switch to `?preset=smollm2_360m`.

**`GatherBlockQuantized requires f16 but the device does not support it`**

GPU lacks the `shader-f16` WebGPU feature. Diagnosis:

```js
[...((await navigator.gpu.requestAdapter()).features)]
// Should include "shader-f16"
```

Workaround: ensure GPU drivers are current. On Linux, Mesa 23.0+
exposes this on most modern hardware. On Chrome, you may need
`chrome://flags/#enable-unsafe-webgpu` to enable optional features.

**`QuotaExceededError: Quota exceeded.` during fetch**

The browser's per-origin Cache API quota is too small for the 3 GB of
weights. Diagnosis:

```js
await navigator.storage.estimate()
// quota should be > 4_000_000_000 for headroom
```

Workaround: call `navigator.storage.persist()` in DevTools before
clicking generate; Chrome usually auto-grants it for localhost. If
not, the issue is profile-related — try a normal user profile (not
an Incognito window, not a Playwright ephemeral profile).

**Page freezes for 10+ minutes with no progress**

You're probably on the WASM backend with a too-large model. Verify
backend selection (see "Verifying" above). Either:

- Use `?backend=webgpu` (the default `auto` should already pick
  this when `navigator.gpu` is present, but the override is explicit).
- Switch to `?preset=smollm2_360m` if no real GPU is available.

**Fetch stalls mid-download**

Usually flaky network or HF Hub rate limiting. The relay client's
reconnect logic doesn't apply here (Transformers.js manages the
fetch). Refresh the tab; previously-completed shards are already in
Cache API and won't re-download.

### Reproducible verification (Playwright)

The same end-to-end test can be run headless via the verify script.
Headless WebGPU on Linux is feature-poor, so verify defaults to
WASM. The WASM backend has its own size ceiling around ~500 MB at
q4f16, so only `smollm2_360m` runs end-to-end headless today.

```bash
# Verify SmolLM2 end-to-end (works headless, ~8s wall)
bun run --cwd examples/local-llm-poc verify

# Verify a larger preset's fetch + cache + load path (will fail at
# the inference step due to the WASM size ceiling — useful for
# regression-testing the fetch/storage/load layers)
bun run --cwd examples/local-llm-poc verify --preset qwen2_5_coder_1_5b
bun run --cwd examples/local-llm-poc verify --preset qwen3_1_7b
bun run --cwd examples/local-llm-poc verify --preset gemma4_e2b
```

Each run reports outcome (`SUCCESS` / `ERROR` / `TIMEOUT`) with
distinct exit codes (0 / 1 / 3) for CI. See `scripts/verify.ts` for
the report shape and what each phase exercises.

## What's wired

- `createEngine({ ...preset, backend, onLoadProgress })` — preset spread,
  backend override, progress callback.
- `engine.ensureReady()` — first call triggers fetch + tokenizer
  load + model load + ORT init.
- `engine.generate(messages)` — async iterator of `EngineEvent`s:
  `{ kind: 'token' }` per decoded chunk, terminal `{ kind: 'usage' }`
  with token counts and wall-clock decode time.

## What's not

- **No worker.** The model loads on the main thread. The tab will
  freeze briefly during ONNX graph compilation.
  `@inbrowser/model/worker` is typed but unimplemented; landing it is
  the next step.
- **No tool calling.** Native tool support isn't in Gemma 4 or
  SmolLM2; the prompt-engineered polyfill lives in `@inbrowser/agent`,
  not here.
- **No multi-turn.** The demo sends a single user message per click;
  history is not retained between generates.
- **No multimodal.** `EngineMessage.media` is typed but dropped at
  chat-template rendering. The Gemma 4 audio path needs a separate
  `AutoProcessor` code path.
