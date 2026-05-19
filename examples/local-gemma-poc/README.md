# local-gemma-poc

End-to-end demo of `@inbrowser/model` — loads a local LLM in the
browser via WebGPU (or WASM) and streams a response from a prompt.

Two paths through the demo:

1. **SmolLM2 360M (default)** — fast, works headless, no GPU required.
   The right pick for verification and CI.
2. **Gemma 4 E2B** — needs a real desktop browser with a real GPU.
   The "real" demo of on-device inference; see the dedicated section
   below.

## Quick start (SmolLM2)

```bash
bun install
bun run --cwd examples/local-gemma-poc dev
```

Open <http://localhost:5175>, click Load + generate. Expect ~180 MB
download, ~8s to first token on first run, near-instant on reloads.

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
bun run --cwd examples/local-gemma-poc dev
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

The same end-to-end test can be run headless via the verify script —
but as noted, it can't actually decode Gemma 4 because headless
WebGPU on Linux is feature-poor. It's useful for verifying everything
*up to* the inference call:

```bash
# Verify SmolLM2 end-to-end (works headless)
bun run --cwd examples/local-gemma-poc verify

# Verify Gemma 4 fetch + cache (will hit GPU limits at inference)
bun run --cwd examples/local-gemma-poc verify --preset gemma4_e2b --backend wasm
```

See `scripts/verify.ts` for the report shape.

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
