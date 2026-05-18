# @inbrowser/model

On-device LLM engine. Loads ONNX models in the browser via
`@huggingface/transformers` + ONNX Runtime Web (WebGPU / WASM), and
exposes them behind a narrow `Engine` surface.

> **Status: POC stub.** Types, presets, adapter surface, and worker
> RPC frames are in place. The `@huggingface/transformers` wiring
> inside `createEngine` is not yet implemented — `generate()` yields
> an `error` event today. See `src/engine.ts`.

## One-liner

```ts
import { createEngine } from '@inbrowser/model';
import { gemma4_E2B } from '@inbrowser/model/presets';

const engine = createEngine(gemma4_E2B);
await engine.ensureReady();

for await (const evt of engine.generate([
  { role: 'user', text: 'Explain WebGPU in one paragraph.' },
])) {
  if (evt.kind === 'token') process.stdout.write(evt.text);
}
```

## Surface

| Export | What it gives you |
|---|---|
| `createEngine(preset)` | Runtime `Engine` — owns load state + decode loop |
| `definePreset(p)` | Type-safe identity helper for community presets |
| `ModelPreset`, `Engine`, `EngineEvent`, … | Public types |
| `@inbrowser/model/presets` | `gemma4_E2B`, `gemma4_E4B` |
| `@inbrowser/model/relay` | `createLocalInferenceProvider(engine)` → relay `InferenceProvider` |
| `@inbrowser/model/agent` | `createLocalLlmClient(engine, id)` → agent `LlmClient` |
| `@inbrowser/model/worker` | `hostEngineInWorker(self)` + `connectWorkerEngine(opts)` |

## Vocabulary anchor

- **ONNX** — model file format. **ONNX Runtime Web** is the execution
  engine (`onnxruntime-web`); WebGPU and WASM are its **backends**.
- **`dtype`** — weight/activation precision selection (`q4f16`, `q8`,
  `fp16`, `fp32`). Distinct from parameter count.
- **`ModelRef`** — bare locator (HF Hub `modelId` + `revision`).
- **`ModelPreset`** — locator + dtype + backend + capabilities. Static.
- **`Engine`** — runtime object owning a loaded model. Dynamic.
- **Cold start** — fetch + init + warmup. **Warm decode** — subsequent
  calls on a ready engine.

## Design notes

- One factory (`createEngine`), many presets. No `createGemmaEngine`.
- `capabilities` is on the preset, not the engine — interrogable
  pre-load (`gemma4_E2B.capabilities.contextWindow`).
- `EngineEvent` is narrower than `InferenceEvent`/`ChatEvent`.
  Adapters widen.
- Worker subpath returns the same `Engine` shape; the agent runtime
  cannot tell whether it holds a direct or remote engine.
- Tool calling is not native to Gemma 4. The polyfill (prompt-engineered
  tool calling + structured-output parsing) lives in `@inbrowser/agent`,
  not here.
