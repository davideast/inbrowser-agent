# Bundling guide — running large LLMs in the browser via `@inbrowser/model`

This document is the field manual for getting an on-device LLM to run in
a real browser tab. If your Gemma 4 demo "isn't working" and you don't
know why, start here. The intended audience is somebody integrating
`@inbrowser/model` for the first time and hitting one of the many paper
cuts the POC team already paid for.

It is a teaching document, not an archaeology one. The blow-by-blow of
how each finding was originally cornered lives in
[`plans/model-poc-debugging-notes.md`](../../../plans/model-poc-debugging-notes.md);
that's the source of truth. The status callouts in the example
[`README.md`](../README.md) are the canonical preset matrix and run
commands; this guide assumes you've at least skimmed it.

Conventions used below:

- **verified** — observed end-to-end in this repo (Playwright run,
  user-reported real-browser run, or both).
- **expected** — the path is wired but hasn't been exercised on the
  setups we have. Treat as a prediction.
- **❌ won't work** — observed to fail today; either the cause is a
  hardware/driver limitation, an upstream bug, or a feature that isn't
  implemented.

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Choosing a preset](#2-choosing-a-preset)
3. [First-run experience](#3-first-run-experience)
4. [Common errors and what they mean](#4-common-errors-and-what-they-mean)
5. [Headless verification (CI)](#5-headless-verification-ci)
6. [Networking gotchas](#6-networking-gotchas)
7. [When to expect things to "just work"](#7-when-to-expect-things-to-just-work)

---

## 1. Prerequisites

### Browser

| Browser | Status | Setup |
|---|---|---|
| Chrome 113+ (desktop) | ✅ best target | Works out of the box on macOS / Linux / Windows |
| Edge 113+ (desktop) | ✅ same engine | Works out of the box |
| Safari Tech Preview | ✅ working | Standard Safari may not enable WebGPU yet |
| Firefox | ⚠️ behind flag | `about:config` → `dom.webgpu.enabled = true` (still rough) |
| Mobile | ⚠️ patchy | WebGPU support varies; WASM fallback works but is slow |

Anything older than Chrome 113 lacks the stable WebGPU API and will
silently fall back to WASM, which has its own ceiling (see §4).

### Hardware shape

The single biggest variable is whether you have a **real** GPU exposed
to the browser:

- **Real GPU** (Apple Silicon, recent Nvidia / AMD / Intel, integrated
  Intel from ~2020+) — the WebGPU path is fast and stable for models up
  to a few GB.
- **Integrated / older GPU** — WebGPU may be present but with reduced
  feature sets. Capability-check before assuming Gemma 4 will load
  (see below).
- **Headless / virtualized (SwiftShader, llvmpipe, …)** — `navigator.gpu`
  is exposed but the device is software-rendered. Caps are tight and
  `shader-f16` is typically missing. Treat as "WASM only" for anything
  bigger than ~500 MB at q4f16.

### A 30-second capability check

Open DevTools on the page where you want to run the model, paste this
into the console, and read the output:

```js
const a = await navigator.gpu?.requestAdapter();
if (!a) { console.log('No WebGPU adapter — WASM only'); }
else {
  console.log({
    info: a.info,                                  // vendor, architecture
    maxBufferSize: a.limits.maxBufferSize,         // need ≥ 1.3 GB for Gemma 4
    shaderF16: a.features.has('shader-f16'),       // need true for q4f16
    cores: navigator.hardwareConcurrency,
    crossOriginIsolated,                           // true → multi-thread WASM
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  });
}
```

Read the result against the preset hardware bars in §2 before you click
Generate. This snippet is the same probe `scripts/verify.ts` runs from
Node-side Playwright.

Useful thresholds:

- `maxBufferSize ≥ 1_300_000_000` (~1.21 GiB) — required for Gemma 4
  E2B. The embedding table is 1.17 GiB and the buffer must hold it
  whole.
- `maxBufferSize ≥ 600_000_000` (~600 MiB) — covers the Qwen 1.5B / 1.7B
  presets. Most modern GPUs ship with ≥ 1 GiB.
- `shader-f16` — required by `q4f16`-quantized models. Without it the
  `GatherBlockQuantized` shader fails.
- `crossOriginIsolated === true` — your page sent the right COOP/COEP
  headers and ORT-Web's WASM backend can use multiple threads. Without
  it, threading falls back to 1, and large-model init on WASM can take
  10+ minutes (or hang).

### Disk / RAM / network

| Preset | Disk (cached weights) | RAM (loaded tab) | Network (first run) |
|---|---|---|---|
| `smollm2_360m` | ~200 MB | < 1 GB | ~180 MB |
| `qwen2_5_coder_1_5b` | ~1.5 GB | ~2 GB | ~1.28 GB |
| `qwen3_1_7b` | ~1.5 GB | ~2 GB | ~1.36 GB |
| `deepseek_r1_qwen_1_5b` | ~1.5 GB | ~2 GB | ~1.37 GB |
| `gemma4_e2b` | ~3.5 GB | ~3 GB | ~3 GB |
| `gemma4_e4b` | ~7 GB | ~6 GB | ~6 GB |

Sizes for the Gemma / SmolLM2 / Qwen rows come from the on-disk
`*.onnx_data` file sizes documented in
[`model-poc-debugging-notes.md` §5](../../../plans/model-poc-debugging-notes.md);
the RAM figures are observed (Gemma 4) or expected (others).

---

## 2. Choosing a preset

The five-plus bundled presets are exported from `@inbrowser/model/presets`.
For the full per-preset rationale see
[`packages/model/src/presets.ts`](../../../packages/model/src/presets.ts);
the table below is the "which one do I pick" view.

| Preset | Size (q4f16) | Real GPU | Headless WASM | Best for |
|---|---|---|---|---|
| `smollm2_360m` | ~180 MB | ✅ | ✅ verified end-to-end | The canary. CI, planes, demos with no GPU. |
| `qwen2_5_coder_1_5b` | ~1.28 GB | ✅ | ❌ ORT shape-reuse bug | Code completion, fill-in-the-middle. |
| `qwen3_1_7b` | ~1.36 GB | ✅ | ❌ `std::bad_alloc` | Current frontier-for-size general model. |
| `deepseek_r1_qwen_1_5b` | ~1.37 GB | ✅ | ❌ (same band as Qwen) | Reasoning. Emits `<think>…</think>` blocks. |
| `gemma4_e2b` | ~3 GB | ✅ (with caveats) | ❌ hangs | Multimodal-capable. Needs `shader-f16` + ≥1.2 GiB buffer cap. |
| `gemma4_e4b` | ~6 GB | ✅ (discrete GPU) | ❌ | Bigger Gemma; same constraints, doubled. |

A few rules of thumb:

- **Start with `smollm2_360m`.** It exercises every code path in the
  engine (`apply_chat_template`, ORT-Web, decode loop, usage event) and
  loads in seconds. If SmolLM2 doesn't work on your setup, no other
  preset will either — and you've saved a multi-GB download finding out.
- **For a real demo on a real machine, use Gemma 4 E2B.** That's the
  preset the POC was sized around; it's also the only one with a
  user-reported decode rate in this repo (31.4 tok/s on a real
  desktop GPU; greedy sampling).
- **For reasoning UX, use `deepseek_r1_qwen_1_5b`.** It emits its
  chain-of-thought inside literal `<think>…</think>` tags; wrap the
  engine's event stream with `splitThinking` from `@inbrowser/model` to
  route reasoning to a separate pane (see the example's main.ts).
- **For code tasks, use `qwen2_5_coder_1_5b`.** It targets the same
  hardware band as the other Qwen but specializes in code / FIM.
- **Avoid the Qwen and DeepSeek presets on headless WASM.** They fetch
  and load fine, but inference fails for model-specific reasons
  (ORT-Web buffer-reuse bug, V8 WASM heap OOM). Use a real GPU.

### Hardware bar per preset

| Preset | Minimum GPU | `maxBufferSize` | Other |
|---|---|---|---|
| `smollm2_360m` | none (WASM is fine) | n/a | Anything with ~512 MB RAM headroom |
| Qwen 1.5B / 1.7B / DeepSeek | ~2 GB VRAM | ≥ 600 MiB | `shader-f16` |
| `gemma4_e2b` | ~6 GB VRAM | ≥ 1.2 GiB | `shader-f16` |
| `gemma4_e4b` | discrete GPU (~12 GB VRAM expected) | ≥ 1.2 GiB | `shader-f16` |

Older integrated GPUs (pre-~2020) tend to cap `maxBufferSize` at
exactly 1 GiB and will fail Gemma 4 with the `Buffer size exceeds` error
(§4).

### Custom presets

`@inbrowser/model` exports a `definePreset` helper for community
presets — see
[`packages/model/README.md`](../../../packages/model/README.md). Adding
a model is one new preset entry, not a new factory. If your model is
Qwen2-architecture (Qwen 2.5 family, DeepSeek R1 distills, …) it'll use
the existing code path; other architectures may need engine work.

---

## 3. First-run experience

A cold load of `@inbrowser/model` walks through four phases. The
example UI surfaces each phase in its status line — track that line as
your progress indicator.

```
idle
  → click Load + generate
creating engine (preset=…, backend=…)
  → ensureReady() begins
fetching onnx/decoder_model_merged_q4f16.onnx_data — X.X / Y.Y MB
  → the long one. Cached after first run.
initializing ORT (webgpu|wasm)…
  → ORT-Web compiles the ONNX graph (operator fusion, kernel selection)
warmup decode (N tokens)
  → engine runs a single-token decode to warm caches
ready
  → engine.generate() is ready
decoding (CTX ctx, greedy|temp=N, maxTokens=M)
  → tokens stream into the output pane
N in / M out — Xs wall (Y tok/s decode)
  → terminal usage event
```

### Approximate timings

These are the numbers actually mentioned in `plans/model-poc-debugging-notes.md`
or `examples/local-llm-poc/README.md`. Everything else in this section
is marked **expected**.

**`smollm2_360m` on headless WASM** (verified, single Playwright run):

| Phase | Wall-clock |
|---|---|
| Fetch (first run, ~180 MB) | network-bound |
| Init + warmup | a few seconds |
| First token | +8.00s from page load (cold) |
| Decode | 5.8 tok/s on the Playwright headless setup |
| Total for "Say hello in one short sentence." | 1.75s of decode after first token |

**`gemma4_e2b` on real desktop WebGPU** (user-reported, single run):

| Phase | Wall-clock |
|---|---|
| Fetch (first run, ~3 GB) | network-bound |
| Init | a few seconds |
| Decode | 31.4 tok/s greedy |

**`gemma4_e4b` on real desktop WebGPU** (user-reported): 12 tok/s
decode. No other phase timing measured.

**Anything else** — expected to fall between SmolLM2 and Gemma 4 on
matching hardware. The example README's
["Testing Qwen presets in a real browser"](../README.md#testing-qwen-presets-in-a-real-browser)
section gives ranges (25–60 tok/s on Apple Silicon / RTX 30xx+,
10–25 tok/s on integrated) — those are predictions, not measurements
made in this repo.

### What's cached vs. re-downloaded

The fetch phase pulls weights through `fetch()` and `@huggingface/transformers`
stores the response in the browser's **Cache API**, keyed by the HF
Hub URL. On a normal user profile with default storage:

- **First run:** full download.
- **Second run on the same origin and the same browser profile:**
  near-instant — cached weights are served locally, ORT re-compiles
  the graph but doesn't re-fetch.

If your "instant on reload" isn't happening, the most likely cause is
storage quota (§4, `QuotaExceededError`) or a clean Incognito / ephemeral
profile (cache evicted between runs).

### Greedy vs. sampling

By default the example UI runs **greedy** decode — the model picks the
single most-likely next token at every step. Outputs are deterministic
across runs. Pass `?temperature=N` in the URL to enable sampling:

| Value | Behavior |
|---|---|
| (omitted) | greedy / deterministic |
| `0.2` | focused — good for code |
| `0.7` | balanced (most chat-UI defaults) |
| `1.0+` | creative / divergent |

The status line displays `greedy` or `temp=N` per-run so the active
mode is visible. See `examples/local-llm-poc/src/main.ts` for how
`pickTemperature()` translates the URL param into `GenerateOpts`.

---

## 4. Common errors and what they mean

These are the failure modes the POC encountered. For each:
**symptom** (the error string or behavior the user actually sees),
**what's going on** (the underlying cause), **diagnose** (a probe you
can run), and **fix** (what to do about it). Most of these trace back
to one of the eight findings in
[`plans/model-poc-debugging-notes.md`](../../../plans/model-poc-debugging-notes.md).

### `Buffer size (NNN) exceeds the max buffer size limit (1073741824)`

**Symptom.** Page initializes, fetch completes, ORT init starts on
WebGPU, then explodes mid-init or on first forward pass with a
buffer-size error. The number after `limit` is exactly `2^30` (1 GiB).

**What's going on.** WebGPU specifies a `maxBufferSize` per-adapter
limit. SwiftShader (headless Chromium's CPU-backed WebGPU) caps it at
exactly 1 GiB; many integrated GPUs cap it there too. Gemma 4 E2B's
embedding table is 1.17 GiB — one byte too big.

**Which presets are bitten.** `gemma4_e2b` (1.17 GiB embedding),
`gemma4_e4b` (larger). Qwen and SmolLM2 use a smaller vocabulary
(~152K vs. Gemma 4's 256K) and stay under 1 GiB.

**Diagnose.**

```js
(await navigator.gpu.requestAdapter()).limits.maxBufferSize
// Need ≥ 1_300_000_000 (~1.21 GiB) for Gemma 4 E2B.
```

**Fix.** No user-side workaround — this is a hardware/driver gap. Try
a different machine (Apple Silicon, RTX 20xx+, RDNA2+, Intel Arc all
work), or switch to `?preset=smollm2_360m` or one of the Qwen presets
which don't need the larger cap.

### `GatherBlockQuantized requires f16 but the device does not support it`

**Symptom.** WebGPU backend selected, ORT init proceeds, then fails on
the first decode step. Sometimes appears as a generic
"shader compilation failed" depending on driver.

**What's going on.** All our q4f16-quantized presets — every preset
this package ships — use fp16 activations. The `GatherBlockQuantized`
shader needs the WebGPU `shader-f16` feature. Headless SwiftShader
doesn't enable it; some older integrated GPUs don't either.

**Diagnose.**

```js
[...((await navigator.gpu.requestAdapter()).features)]
// Should include "shader-f16"
```

**Fix.**

- Update GPU drivers. On Linux, Mesa 23.0+ exposes `shader-f16` on most
  modern hardware.
- On Chrome, the feature may be gated behind
  `chrome://flags/#enable-unsafe-webgpu` on older builds.
- For headless / SwiftShader, fall back to the WASM backend
  (`?backend=wasm`) — but be aware of the WASM size ceiling below.

### `QuotaExceededError: Quota exceeded.` during fetch

**Symptom.** Fetch progresses, then dies at the first multi-hundred-MB
shard with `QuotaExceededError`. Disk has plenty of space.

**What's going on.** Chromium's `StorageManager` calculates per-origin
Cache API quota off the user-data-dir's host filesystem **and** gives
ephemeral profiles a tighter slice. Observed: ~1 GB on an ephemeral
Playwright profile vs. 13.2 GB on a persistent one.

**Diagnose.**

```js
await navigator.storage.estimate()
// quota should be > 4_000_000_000 for headroom on Gemma 4
```

If `quota` is around 1 GB, you're on an ephemeral profile (Incognito,
fresh container, Playwright `chromium.launch()` default).

**Fix.**

- For real users on a normal profile, call `navigator.storage.persist()`
  in DevTools before clicking Generate. Chrome auto-grants it for
  localhost in most cases.
- For Playwright, use `chromium.launchPersistentContext(userDataDir, …)`
  with `userDataDir` on the real disk. See §5.
- For Incognito, expect ~1 GB quota — use `smollm2_360m` only.

### WebGPU detected, model fails mid-decode

**Symptom.** Page loads, `webgpu: true`, fetch and init complete, then
the first generate explodes with a shader / buffer / shape error
that's specific to the model.

**What's going on.** `navigator.gpu` truthiness is misleading. A device
can advertise WebGPU but lack the features or limits the model needs.
The common gaps:

- `maxBufferSize < 1.2 GiB` → Gemma 4 buffer error.
- `shader-f16` missing → `GatherBlockQuantized` error.
- Implementation bugs in ORT-Web's WebGPU EP (rare but real).

**Diagnose.** Run the 30-second capability check from §1 *before*
clicking Generate. If `shader-f16` is missing or `maxBufferSize` is too
small, you'll hit the model at a later phase.

**Fix.** The example UI accepts `?backend=wasm` to force the WASM EP
regardless of what `navigator.gpu` claims. That moves the bottleneck
from "GPU caps" to "model size" (see next entry) but at least gives a
deterministic answer.

### WASM init hangs for 5+ minutes after fetch completes

**Symptom.** WASM backend selected, weights fetched and cached in
seconds. Then **silence** — no progress events, no errors, no console
output. The tab is unresponsive.

**What's going on.** ORT-Web compiles the ONNX graph once before the
first inference (operator fusion, kernel selection, memory planning).
On single-threaded WASM, a ~3 GB Gemma 4 graph takes 10+ minutes —
sometimes hangs entirely under OOM-like pressure that doesn't surface
as a console error. The V8 WASM heap is bounded at ~4 GB total and
ORT-Web's per-session scratch + KV cache + intermediates compete for
that budget.

**Which presets are bitten.** Anything ≥ ~500 MB at q4f16 on WASM. In
practice:

| Preset | WASM failure mode |
|---|---|
| `qwen2_5_coder_1_5b` | `Shape mismatch attempting to re-use buffer. {1,1,1536} != {1,40,1536}` on first decode |
| `qwen3_1_7b` | `Can't create a session. ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc` |
| `deepseek_r1_qwen_1_5b` | Same band as Qwen — expected to OOM or buffer-mismatch |
| `gemma4_e2b` | Hangs >10 min, no error surfaces |

The Qwen 2.5 shape-mismatch is the most interesting one: it's a real
bug in ORT-Web's buffer-reuse when the prefill and decode reuse the
same buffer slot. The WebGPU EP doesn't reuse buffers the same way, so
it's WASM-only.

**Diagnose.** If `crossOriginIsolated === false`, you don't have
multi-threaded WASM and large-model init **will** hang. Even with
threading, the WASM ceiling at q4f16 is around ~500 MB.

**Fix.** Use the WebGPU backend with a real GPU. WASM is for the
SmolLM2-class verification canary, not Gemma 4. Multi-threaded WASM
(COOP/COEP enabled — see vite.config.ts and §6) helps medium models
(1–2 GB band) but doesn't unlock anything bigger.

### Tab freezes during ONNX graph compilation

**Symptom.** Fetch completes, page becomes unresponsive for several
seconds to a minute, then comes back and decode begins.

**What's going on.** The example runs the engine on the **main thread**
today. ORT-Web's graph compilation is synchronous (or close to it) for
big chunks and blocks the event loop while it runs. Not a bug — a
known limitation of the POC.

**Fix.** Wait. The freeze is finite for any preset that can actually
run end-to-end on your hardware. The `@inbrowser/model/worker` subpath
is typed but unimplemented as of this writing
([`packages/model/README.md`](../../../packages/model/README.md)
status); landing it would move compilation off the UI thread.

### Decode stops mid-sentence at exactly 512 tokens (or 2048)

**Symptom.** Output cuts off cleanly mid-line. Usage line shows
`outputTokens` equal to the exact cap. Looks like a model defect — the
reply makes sense up to the cut.

**What's going on.** The example UI applies a `maxNewTokens` cap to
every generate to prevent runaway. The current default is **2048**; an
older version used 512. If the model wanted to say more, this caps it.

**Diagnose.** Watch the status line. When `outputTokens >= maxTokens`,
the example surfaces this:

```
N in / M out — Xs wall (Y tok/s decode) ⚠️ hit 2048-token cap — append ?maxTokens=N to extend
```

**Fix.**

- Append `?maxTokens=N` to the URL to raise the ceiling for that run.
- For code-heavy prompts a value like `?maxTokens=4096` is usually
  enough; reasoning-model prompts (`deepseek_r1_qwen_1_5b`) can want
  considerably more because the `<think>` block is included in the
  count.
- Raising the cap doesn't force the model to talk longer; it just
  raises the ceiling. EOS still terminates the reply at the natural
  point.

### Garbled output / wrong precision behavior

**Symptom.** Decode runs, but the text is nonsense, or audio output (in
a multimodal path) is garbled.

**What's going on.** dtype-vs-backend incompatibility — the most common
form is asking for `q4f16` on a device that doesn't support
`shader-f16`, where ORT-Web sometimes silently falls back to fp32 math
on quantized weights and produces wrong numbers. **Expected** —
documented in the debugging-notes summary as a class of failure; not
specifically reproduced in this repo against the bundled text presets.

**Fix.**

- Run the capability check (§1) — confirm `shader-f16` is present.
- If you've authored a custom preset, double-check the `dtype` matches
  what the ONNX repo actually shipped. Don't assume `q4f16` works just
  because the model was quantized "to 4 bits" — `q4`, `q4f16`, `q4f32`
  are different exports.
- If you're hitting this on a text preset bundled with `@inbrowser/model`,
  it's likely the same root cause as the `GatherBlockQuantized` error
  above; treat it as a hardware/driver gap.

### Fetch stalls mid-download

**Symptom.** Progress bar stalls at e.g. 47% and never resumes. Network
tab shows the request idle.

**What's going on.** Flaky network or HF Hub rate-limiting. Transformers.js
manages this fetch itself, so the relay client's resume logic doesn't
apply.

**Fix.** Refresh the tab. Previously-completed shards are already in
the Cache API and won't re-download; the partial shard restarts from
zero. If it keeps happening on the same shard, try a different network
(home WiFi vs. mobile hotspot has been the difference in practice).

---

## 5. Headless verification (CI)

The example ships
[`scripts/verify.ts`](../scripts/verify.ts), a Playwright-driven
end-to-end check. It's the script that surfaces every failure mode
above. Run it from the repo root:

```bash
# Start the dev server first (terminal 1)
bun run --cwd examples/local-llm-poc dev

# Run verify against the running server (terminal 2)
bun run --cwd examples/local-llm-poc verify
```

Defaults:

- `--url http://localhost:5175`
- `--timeout 120000` (120s)
- `--backend wasm`
- `--preset smollm2_360m`
- `--user-data-dir ~/.cache/inbrowser-playwright`

Override any with `--flag value` on the command line.

### What the script does

In order:

1. Launches **persistent** Chromium with `chromium.launchPersistentContext`
   pointed at `--user-data-dir` on the real disk. **This is the key
   detail** — using ephemeral `chromium.launch()` caps Cache API quota
   at ~1 GB regardless of available disk. Persistent jumps the quota to
   ~13 GB on the box tested.
2. Navigates to the dev server URL with `?backend=…&preset=…` query
   strings forwarded.
3. Probes `navigator.gpu`, `crossOriginIsolated`, `SharedArrayBuffer`,
   `navigator.storage.estimate()` and logs them.
4. Fills the prompt, clicks Generate, polls the UI for status changes,
   progress, output, usage.
5. Prints a single-screen report with outcome (`SUCCESS` / `ERROR` /
   `TIMEOUT`) and distinct exit codes:

   | Exit code | Meaning |
   |---|---|
   | `0` | `SUCCESS` — usage event received |
   | `1` | `ERROR` — page or console error surfaced |
   | `2` | script crashed (couldn't reach the dev server, etc.) |
   | `3` | `TIMEOUT` — no terminal event before the deadline |

CI / shell scripts can branch on these without parsing output.

### The COOP/COEP dance

The example's [`vite.config.ts`](../vite.config.ts) sets two response
headers on every dev-server response:

```ts
headers: {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}
```

These make the page **cross-origin-isolated**, which is the gate for
`SharedArrayBuffer` and therefore for ORT-Web's multi-threaded WASM
backend. Without them, threading silently falls back to 1, and on a
3 GB Gemma 4 graph model init takes 10+ minutes.

The strict `require-corp` value means every cross-origin subresource
(including the HF Hub CDN responses for weights) must send
`Cross-Origin-Resource-Policy: cross-origin`. The HF Hub does; many
other CDNs don't. If you swap in a model whose host doesn't send CORP,
switch to `'credentialless'` instead — it's the same isolation gate
with a more forgiving cross-origin model.

To confirm both headers landed at runtime:

```js
crossOriginIsolated                  // true
typeof SharedArrayBuffer              // 'function'
```

The verify script prints both as `cross-origin iso: true (SAB=true)` in
its report.

### What "passing verify" actually proves

The verify run today exercises `smollm2_360m` end-to-end on headless
Chromium + WASM. That's **the engine itself works** — fetch, tokenizer
load, model load, ORT init, decode, usage event, error pass-through.

It does **not** prove:

- That Gemma 4 / Qwen 1.5B+ / DeepSeek decode correctly. Those need a
  real GPU; see the example README's
  "[Testing Gemma 4 in a real browser](../README.md#testing-gemma-4-in-a-real-browser)"
  section.
- That the worker transport works. `@inbrowser/model/worker` is typed
  but unimplemented.
- That sample sequences, stop sequences, or mid-decode cancellation
  work. The engine fields are wired but not yet honored.

The split is intentional: SmolLM2 is the **"is the engine broken?"**
canary; Gemma 4 is the **"is the model fast enough?"** benchmark.
Different questions, different tools.

### Regression-testing the fetch layer separately

Even when the chosen preset can't run end-to-end headless, the **fetch
+ cache + load** phases are useful in isolation:

```bash
# Won't reach SUCCESS (WASM heap OOM at decode), but the fetch and
# storage paths get exercised — useful for catching regressions in
# the cache layer.
bun run --cwd examples/local-llm-poc verify --preset qwen3_1_7b
bun run --cwd examples/local-llm-poc verify --preset gemma4_e2b
```

Exit code 1 (`ERROR`) with the expected error message means the fetch
layer is still healthy; only the inference step failed where we already
expected it to.

---

## 6. Networking gotchas

These are local-development-only issues — they don't affect production
deployments.

### Vite 7 rejects non-localhost Host headers

**Symptom.** Dev server starts, you point your phone (or another
machine over Tailscale / LAN) at `http://your-host:5175`, and Vite
responds with a 403 "blocked because of allowedHosts" page.

**What's going on.** Vite 7 added DNS-rebinding protection that rejects
any `Host:` header that isn't `localhost`. Tailscale, LAN IPs, and
custom hostnames all trip it.

**Fix.** The example's vite.config.ts sets:

```ts
server: {
  host: '0.0.0.0',
  port: 5175,
  strictPort: true,
  allowedHosts: true,   // accepts any Host header
  ...
}
```

`allowedHosts: true` disables the check entirely. This is **fine for a
dev server** but never carry it into production — DNS rebinding is a
real attack class against production hosts.

### WSL2 ↔ Windows port forwarding

**Symptom.** Vite dev server is bound to `0.0.0.0:5175` inside WSL2,
but Windows host (and devices on the Windows host's LAN) can't reach
it.

**What's going on.** Windows treats WSL2 as a separate VM with its own
NAT'd network. Ports bound inside WSL2 aren't automatically forwarded
to the Windows host's network stack.

**Fix (expected — not reproduced in this repo).** From an elevated
PowerShell prompt:

```powershell
netsh interface portproxy add v4tov4 listenport=5175 listenaddress=0.0.0.0 connectport=5175 connectaddress=$(wsl hostname -I)
```

Or rely on Tailscale (next section), which routes around the issue by
giving the WSL2 host its own peer address on the tailnet.

### Tailscale to the dev server

**Symptom.** Other devices on your tailnet can reach the WSL2 host but
hit the Vite `allowedHosts` rejection.

**Fix.** `allowedHosts: true` (see above). Once Vite accepts the Host
header, Tailscale routing handles the rest — no extra config needed on
the Vite side.

The example's dev server is bound to `0.0.0.0` (not `127.0.0.1`), so
any reachable address on the host works. Port `5175` is `strictPort:
true` so if it's in use the server fails fast rather than silently
choosing a different port that other devices won't know about.

---

## 7. When to expect things to "just work"

The team has been deliberate about what's actually been verified vs.
what's plausible-but-untested. This list is the ground truth.

### ✅ Verified working

- **Headless Chromium + WASM + SmolLM2 360M.** End-to-end. The CI
  canary. SUCCESS in ~8s wall-clock on the test box.
- **Real desktop Chrome + WebGPU + Gemma 4 E2B.** User-reported.
  31.4 tok/s decode with greedy sampling.
- **The COOP/COEP setup.** `crossOriginIsolated === true` and
  `typeof SharedArrayBuffer === 'function'` confirmed on the dev
  server in headless verify.
- **Persistent Chromium profile fixes the Cache API quota.** Observed
  ~1 GB → 13.2 GB on the test box.
- **The `?maxTokens` truncation indicator.** Surfaces visibly when the
  cap is hit.
- **The `splitThinking` wrapper for reasoning models.** Wraps the raw
  engine stream and routes `<think>` content to a separate event kind;
  the example's UI separates the two streams into different panes.

### 🟡 Expected to work (not verified in this repo)

- **Real-browser WebGPU on a sufficient GPU** for the Qwen 1.5B / 1.7B
  / DeepSeek presets. Their embedding tables fit under the 1 GiB
  `maxBufferSize` cap, they use the same Qwen2 architecture code path
  that runs Qwen 2.5 Coder, and the failure modes that bite them on
  headless WASM are WASM-specific.
- **`gemma4_e4b` on a discrete GPU with ≥ 12 GB VRAM.** Same code path
  as E2B, doubled budget. User-reported decode rate is 12 tok/s.
- **Multi-threaded WASM helping for medium models** in the 1–2 GB band.
  We have COOP/COEP set up, but on this test box even threaded WASM
  doesn't run Gemma 4 (3 GB graph is too big regardless of threading).
- **Self-hosted weights** via `EngineHooks.weightsBaseUrl`. Typed on
  the engine surface but not wired into `from_pretrained` calls today.

### 🔴 Known not to work today

- **Headless Chromium + WebGPU.** SwiftShader caps `maxBufferSize` at
  1 GiB and lacks `shader-f16`. Any q4f16 preset will fail. Use WASM
  for headless verification, or run on real hardware.
- **Headless Chromium + WASM + any preset above ~500 MB at q4f16.**
  Hits the V8 WASM heap ceiling, ORT-Web buffer-reuse bugs, or both.
  Each preset above the band fails differently — see §4.
- **Worker transport.** `connectWorkerEngine` is stubbed. The model
  loads on the main thread today; ONNX graph compilation can freeze
  the tab briefly.
- **Native tool calling.** None of the bundled presets have native tool
  support. A prompt-engineered polyfill lives in `@inbrowser/agent`,
  not in `@inbrowser/model`.
- **Multimodal inputs.** `EngineMessage.media` is typed but dropped at
  chat-template rendering. The Gemma 4 audio path needs a separate
  `AutoProcessor` code path that isn't wired yet.
- **Mid-decode cancellation and stop sequences.** `GenerateOpts.signal`
  and `GenerateOpts.stop` are plumbed through the type surface but not
  honored by the engine yet.

---

## Where to go next

- [`examples/local-llm-poc/README.md`](../README.md) — example overview,
  preset matrix, run commands, real-browser instructions for each
  preset.
- [`plans/model-poc-debugging-notes.md`](../../../plans/model-poc-debugging-notes.md)
  — the source-of-truth retrospective. Eight findings, methodology
  notes, open follow-ups.
- [`packages/model/README.md`](../../../packages/model/README.md) —
  package surface, vocabulary anchor, design notes.
- [`packages/model/src/presets.ts`](../../../packages/model/src/presets.ts)
  — per-preset rationale and `definePreset` usage for custom presets.
- [`examples/local-llm-poc/scripts/verify.ts`](../scripts/verify.ts) —
  the headless Playwright verifier this guide keeps referencing.
- [`examples/local-llm-poc/vite.config.ts`](../vite.config.ts) — the
  COOP/COEP setup, `allowedHosts`, port pinning.
