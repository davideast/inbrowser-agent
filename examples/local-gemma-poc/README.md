# local-gemma-poc

End-to-end demo of `@inbrowser/model` — loads Gemma 4 E2B in the
browser via WebGPU and streams a response from a prompt.

## Run

```bash
bun install
bun run --cwd examples/local-gemma-poc dev
```

Opens at <http://localhost:5175>.

## What to expect

1. **First click** triggers the model fetch — about **500 MB** of ONNX
   weights from the Hugging Face Hub. The browser stores them in the
   Cache API; reloads after the first run are instant.
2. **Initialization** (compiling the ONNX graph for WebGPU) takes a few
   seconds on first cold start.
3. **Decode** runs on the GPU. Expect ~15–40 tokens/sec on a modern
   discrete GPU, ~5–15 tok/s on a recent integrated GPU.

## Browser support

| Browser | WebGPU | Notes |
|---|---|---|
| Chrome 113+ desktop | ✅ | Best target. |
| Edge 113+ desktop | ✅ | Same engine as Chrome. |
| Safari Tech Preview | ✅ | Working but lagging. |
| Firefox | ⚠️ | Requires `dom.webgpu.enabled` flag today. |
| Mobile | ⚠️ | WebGPU support is patchy; expect fallback to WASM. |

If WebGPU is unavailable, the engine falls back to WASM/CPU. Decode is
5–20× slower but the demo still runs.

## What's wired

- `createEngine({ ...gemma4_E2B, backend: 'webgpu' })` — spread the
  preset, override the backend, attach an `onLoadProgress` callback.
- `engine.ensureReady()` — first call triggers the fetch + init.
- `engine.generate(messages)` — async iterator of `EngineEvent`s:
  `{ kind: 'token' }` per decoded chunk, terminal `{ kind: 'usage' }`
  with token counts and wall-clock decode time.

## What's not

- No worker — the model loads on the main thread. The tab will freeze
  briefly during ONNX graph compilation. `@inbrowser/model/worker`
  fixes this; a follow-up example will exercise it.
- No tool calling — Gemma 4 doesn't natively support tools, and the
  prompt-engineered polyfill lives in `@inbrowser/agent`. Out of scope
  for this POC.
- No multi-turn — the demo sends a single user message per click.
