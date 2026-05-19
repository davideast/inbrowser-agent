# `@inbrowser/model` POC — debugging notes

Captured 2026-05-18 from the session that scaffolded the package, wired the
engine, and brought up the `local-gemma-poc` example with headless
verification. Written for future-us when one of these gotchas bites again.

## TL;DR

| Finding | Where it hurt | Fix |
|---|---|---|
| `AutoProcessor` 404s on text-only models | `engine.ts` load path | Switch to `AutoTokenizer`; the processor pulls `preprocessor_config.json` which only multimodal repos ship |
| Headless Playwright Cache API quota ≈ 1 GB | Anything fetching >1 GB of weights | `chromium.launchPersistentContext()` with a path on a real (non-ephemeral) disk; quota jumps ~13× |
| Headless WebGPU (SwiftShader) can't run q4f16 models | Any GPU-path verification | Hard `maxBufferSize` 1 GiB cap + missing `shader-f16` feature; use WASM backend for headless |
| Threaded WASM needs COOP/COEP | Multi-thread ORT-Web init | `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` on the dev server |
| Gemma 4 E2B is ~3 GB at q4f16, not 500 MB | Documentation, capacity planning | Read the actual `*.onnx_data` file sizes from the HF Hub manifest; never trust prose claims |
| Real-GPU-only models still need a verifiable surrogate | CI / on-the-go testing | Ship a small preset (`smollm2_360m`) that exercises every code path on headless WASM |
| Hardcoded `maxNewTokens: 512` truncates real prompts silently | Demo UX — looked like a model defect | Default 2048; `?maxTokens=N` URL override; visible `⚠️ hit cap` marker when reached |
| Vite 7 `allowedHosts` blocks non-localhost Host headers | Tailscale / LAN access to dev server | `server.allowedHosts: true` on the dev server (never carry into production) |

## Findings in detail

### 1. `AutoProcessor` is the wrong default

**Symptom:** clicking Generate against `HuggingFaceTB/SmolLM2-360M-Instruct`
emitted `Could not locate file: ".../preprocessor_config.json"` within ~800ms.

**Cause:** Transformers.js's `AutoProcessor.from_pretrained` is designed for
*multimodal* pipelines — it loads an image/audio preprocessor alongside the
tokenizer and requires `preprocessor_config.json`. Text-only models don't ship
that file. The Gemma 4 ONNX repo happens to have it (because the model
supports audio); SmolLM2 does not.

**Fix:** use `AutoTokenizer.from_pretrained` instead. The tokenizer:

- Exposes `apply_chat_template` directly (Processor was just delegating).
- Returns a `BatchEncoding` when called as a function — same shape we needed.
- Works for every text-capable model in the registry, multimodal or not.

The original code only ever worked by accident. Multimodal use (Gemma 4
audio in particular) will need a separate code path that does load
`AutoProcessor`, but that's a feature, not the default.

### 2. Headless Cache API quota is governed by the user-data-dir, not the disk

**Symptom:** model fetch hit `QuotaExceededError: Quota exceeded` at ~1 GB
cached, even on a machine with 910 GB free disk.

**Cause:** `chromium.launch()` (non-persistent) creates an ephemeral
user-data-dir in `/tmp/playwright_chromiumdev_profile-XXXX/`. Chromium's
StorageManager calculates per-origin quota off the user-data-dir's host
filesystem, *and* gives ephemeral profiles a tighter slice — roughly 1 GB on
the box tested, regardless of disk capacity.

**Fix:** `chromium.launchPersistentContext(userDataDir, opts)` with `userDataDir`
on the real disk (e.g., `~/.cache/inbrowser-playwright`). Probe via
`navigator.storage.estimate()`:

| Setup | `quota` observed |
|---|---|
| `chromium.launch()` (ephemeral) | ~1 GB |
| `chromium.launchPersistentContext('~/.cache/...')` | **13.2 GB** |

Bonus: persistent context keeps the model cache across runs. First run
downloads 3 GB; second run is instant.

WSL2 tmpfs was *not* the cause on this box (`/tmp` is on `/dev/sdd`, the real
disk). The variable was ephemeral-vs-persistent, not the path.

### 3. Headless WebGPU is misleading — `navigator.gpu` lies

**Symptom:** `webgpu detected: true` in the verify report, but the first
forward pass exploded with:

```
Buffer size (1174405120) exceeds the max buffer size limit (1073741824)
GatherBlockQuantized requires f16 but the device does not support it
```

**Cause:** Playwright Chromium with `--enable-unsafe-webgpu` exposes
`navigator.gpu` backed by **SwiftShader** (Vulkan-on-CPU). SwiftShader
advertises a WebGPU device but:

- Caps `maxBufferSize` at exactly **1 GiB** (2³⁰ bytes) — this is the WebGPU
  spec ceiling; no flag relaxes it. Gemma 4's embedding table is 1.17 GiB,
  one byte too big for the cap.
- Doesn't enable the **`shader-f16`** feature. q4f16 quantization uses fp16
  activations; the `GatherBlockQuantized` shader requires `enable f16`.

Both are device-capability gaps, not implementation bugs. Real desktop GPUs
(Apple Silicon, recent Nvidia/AMD/Intel) ship both and run the model fine.

**Implication:** never trust `navigator.gpu` truthiness alone. For headless
verification, force WASM (`?backend=wasm` in our example). On a real
machine in a real browser, the WebGPU path works as designed.

### 4. Single-threaded WASM is unfit for 3 GB models

**Symptom:** WASM backend selected, weights fetched and cached in 6.8s, then
**silence for 10 minutes**. No errors, no progress events. Identical
behavior with `--enable-unsafe-webgpu` flags off, with or without COOP/COEP.

**Cause:** ORT-Web compiles the ONNX graph (operator fusion, kernel
selection, memory planning) once before the first inference. On
single-threaded WASM, a ~3 GB Gemma 4 graph takes 10+ minutes — sometimes
hangs entirely due to OOM-like pressure that doesn't surface as a console
error.

**Partial fix attempted:** enable `SharedArrayBuffer` via COOP/COEP headers
to unlock multi-threaded WASM. Confirmed `crossOriginIsolated=true` and
`sharedArrayBuffer=true` in the page. **Did not help** for Gemma 4 — same
hang at the same point.

**Actual fix:** use a smaller model for headless verification (see §6).
Gemma 4 on WASM is not a practical headless path regardless of threading.

The COOP/COEP setup is still valuable: it'd matter for medium-sized models
(1–2 GB) where threading might be the difference between a 1-minute and a
20-minute load.

### 5. Model size claims in marketing copy are unreliable

The reference guide we were given for Gemma 4 E2B claimed "~500 MB" on-device
download. Reality, observed from the actual fetch:

```
onnx/decoder_model_merged_q4f16.onnx_data    1449.3 MB
onnx/embed_tokens_q4f16.onnx_data            1517.0 MB
                                          + small files
                                          ─────────────
                                            ~3,000 MB
```

The 500 MB figure may refer to a different quantization (e.g., q4 with no
separate embed_tokens file) or a different model variant. Read the actual
file sizes from the HF Hub repo manifest before sizing infrastructure.

For napkin math at q4f16: roughly **0.6 bytes per effective parameter**.
- E2B (2.3B eff. params) → ~1.4 GB decoder + ~1.5 GB embed = ~3 GB
- E4B (4.5B eff. params) → roughly double

### 6b. Headless WASM has a hard practical ceiling around ~500 MB at q4f16

**Symptom:** when adding Qwen presets (~1.3 GB each), headless WASM verify
failed in two different model-specific ways at session create / first decode,
not just on Gemma 4's 3 GB graph.

| Preset | Size | Failure mode |
|---|---|---|
| `smollm2_360m` | ~180 MB | ✅ end-to-end success |
| `qwen2_5_coder_1_5b` | ~1.28 GB | `Shape mismatch attempting to re-use buffer. {1,1,1536} != {1,40,1536}` on first decode |
| `qwen3_1_7b` | ~1.36 GB | `Can't create a session. ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc` |
| `gemma4_e2b` | ~3 GB | hangs >10 min, no error surfaces |

**Cause:** V8's WASM heap is bounded at ~4 GB total; ORT-Web's per-session
scratch + KV cache + intermediate tensors compete for that budget. Different
models hit different failure modes — Qwen 3 OOMs immediately, Qwen 2.5 Coder
loads but ORT's buffer-reuse optimization breaks under memory pressure,
Gemma 4 grinds without ever returning.

The shape-mismatch on Qwen 2.5 Coder is the most interesting one: it's a
real bug in ORT-Web's buffer-reuse when the prefill (40 tokens, shape
`{1, 40, 1536}`) and decode (1 token, shape `{1, 1, 1536}`) reuse the same
buffer slot. Surfaces only on WASM EP; WebGPU doesn't reuse buffers the
same way.

**Implication for `@inbrowser/model`:** the verification canary stays
SmolLM2 360M. The Qwen + Gemma 4 presets are documented as "real-GPU only."
A future small Qwen variant (e.g., 0.5B Coder at ~300 MB) could fill the
verifiable-Qwen slot if needed.

### 6. A small verifiable preset is non-negotiable for headless CI

`gemma4_E2B` cannot be exercised end-to-end without a real GPU. To prove the
engine works at all on commodity hardware (or in CI, or on a plane), we
needed a model that:

- Fits in WebGPU's 1 GiB `maxBufferSize` cap (so the GPU path also works
  headless when SwiftShader does support f16).
- Compiles fast enough on single-threaded WASM (~seconds, not minutes).
- Has a chat template + tokenizer that exercises `apply_chat_template`.

**`onnx-community/SmolLM2-360M-Instruct`** fits all three. End-to-end run:

```
preset:    smollm2_360m
backend:   wasm
outcome:   SUCCESS
first tok: +8.00s
usage:     37 in / 10 out — 1.75s wall (5.8 tok/s decode)
```

Every layer of `@inbrowser/model` got exercised. This is the "is the engine
broken?" canary; Gemma 4 is the "is the model fast enough?" benchmark.
Different questions, different tools.

### 7. Silent decode truncation looks like a model bug

**Symptom:** Gemma 4 E2B on real WebGPU, prompt "Write fibonacci in
TypeScript". Output cut off mid-line at `a = b;` inside an iterative loop.
Usage line: `15 in / 512 out — 16.34s wall (31.4 tok/s decode)`.

**Cause:** the example UI hardcoded `maxNewTokens: 512`. Gemma's reply for
that prompt typically wants ~700–1500 tokens (code blocks + commentary on
two approaches). The model didn't stop because it was done; it stopped
because we capped it. The `512`-exact `outputTokens` was the only
visible signal.

**Fix:** three layered, all in `examples/local-gemma-poc/src/main.ts`.

1. **Bumped default** from 512 → 2048 (covers most realistic prompts).
2. **`?maxTokens=N` URL override** for code-heavy prompts that need more.
3. **Truncation indicator** appended to the usage line when
   `outputTokens >= maxTokens`: `⚠️ hit N-token cap — append ?maxTokens=N
   to extend`. Silent truncation was the actual UX bug, not the cap value.

The same pass also wired **`?temperature=N`** through to `GenerateOpts`.
Default behavior (omitted) leaves the engine in greedy decode — matches
prior runs. Setting `?temperature=0.2` (or any non-negative number) flips
on sampling. Surfaced in the status line as `temp=0.2` / `greedy` so the
mode is visible per-run.

**General lesson:** any bounded budget in the demo — token cap, time cap,
buffer cap — needs a visible cue when it bites. Otherwise the bound looks
like a model defect. Cheap to add (`evt.outputTokens >= maxTokens` is a
one-liner), high signal.

Engine fields wired engine-side but not yet exposed in the UI:
`topP`, `topK`, `stop`, `signal`. Stop sequences + mid-decode cancellation
still need engine-level work — see "Open follow-ups."

## Debugging methodology that worked

The session's most useful discipline was **one variable per probe**. Each
re-run changed exactly one thing, so each finding was attributable. The
sequence:

1. Run as-is → fetch hangs at 1 GB → confirm `QuotaExceededError`.
2. Hypothesize quota cause (tmpfs vs ephemeral profile vs per-origin cap).
3. Probe with `navigator.storage.estimate()` to make the quota *visible*
   before doing anything else.
4. Change *only* the user-data-dir → quota goes 1 GB → 13 GB → cause
   isolated to ephemeral profile.
5. Re-run → fetch completes, new error appears → it's a different problem.
6. Repeat.

The wrong approach would have been "add persistent context + COOP/COEP +
disk-cache-size + unlimited-storage all at once" — it would have worked but
we'd have no idea which flag mattered, or what to recommend to users.

Specific probes that paid for themselves in 5 lines of code each:

- `navigator.storage.estimate()` → reveals quota before fetch starts.
- `typeof crossOriginIsolated` + `typeof SharedArrayBuffer` → confirms
  COOP/COEP applied.
- Distinct exit codes (`0` success, `1` error, `3` timeout) → CI / shell
  scripts can act on outcome without parsing output.

## Surface area we now know is real

The `@inbrowser/model` POC is verifiably end-to-end working on:

- ✅ Headless Chromium + WASM + small models (SmolLM2 360M tested)
- ✅ Real desktop Chrome + WebGPU + Gemma 4 E2B (user-confirmed; 31.4 tok/s
  decode with greedy sampling)
- 🟡 Headless Chromium + WebGPU — blocked by SwiftShader caps; needs real GPU
- 🟡 Headless Chromium + WASM + large models (Gemma 4, Qwen 1.5B+) —
  fetches/caches fine; ORT-Web hits buffer-reuse bugs or `std::bad_alloc`
  at the ~1 GB scale; needs real GPU

Untested but reasonably expected to work:

- Service-worker-hosted engine via `@inbrowser/model/worker` (stub only today)
- Qwen 2.5 Coder 1.5B + Qwen 3 1.7B on real WebGPU (smaller embedding tables
  than Gemma 4; should run on more GPUs)

## Files touched in this session

- `packages/model/src/engine.ts` — `AutoProcessor` → `AutoTokenizer`
- `packages/model/src/presets.ts` — `smollm2_360m`, `qwen2_5_coder_1_5b`,
  `qwen3_1_7b` presets
- `examples/local-gemma-poc/` — entire example app (UI, Vite config, README)
- `examples/local-gemma-poc/scripts/verify.ts` — Playwright headless verifier
- `examples/local-gemma-poc/vite.config.ts` — COOP/COEP, `allowedHosts: true`
  for Tailscale, `strictPort: true`
- `examples/local-gemma-poc/src/main.ts` — `?preset`, `?backend`,
  `?maxTokens`, `?temperature` URL overrides; truncation indicator

## Open follow-ups

- **Worker transport** — `connectWorkerEngine` is still stubbed. Headless
  verification would benefit (today the WASM init blocks the UI thread).
- **Tool-use polyfill in `@inbrowser/agent`** — sketched in design notes; not
  yet implemented. Required for SmolLM2 / Gemma 4 to slot into the agent
  runtime's tool-using path.
- **Mid-decode signal cancellation** — `GenerateOpts.signal` is plumbed
  through but not honored by `model.generate`. Needs `StoppingCriteria`.
- **Stop sequences** — `GenerateOpts.stop` accepted, not honored. Same.
- **Multimodal `EngineMessage.media`** — typed, dropped at chat-template
  rendering. Need an `AutoProcessor` code path gated on a preset flag.
- **Self-hosted weights via `weightsBaseUrl`** — typed on `EngineHooks`,
  not wired into `from_pretrained` calls. Would help verify-without-internet.
