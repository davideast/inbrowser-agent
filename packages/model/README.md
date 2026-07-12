# @inbrowser/model

The model layer for the stack. It owns the one model-call contract —
`ModelClient` — plus the cloud providers that implement it and the
on-device LLM engine. `@inbrowser/relay` (transport) and
`@inbrowser/agent` (runtime) both consume a `ModelClient`, so this is the
single shared definition of "an LLM" for everything downstream.

Two halves, one package:

- **The contract + cloud providers.** `@inbrowser/model`
  defines `ModelClient` / `ModelRequest` / `ModelEvent`. The cloud
  providers (`geminiModelClient`, `openrouterModelClient`,
  `requestyModelClient`, `anthropicModelClient`, `openaiCompatModelClient`,
  `ollamaModelClient`, `llamaServerModelClient`, `claudeCliModelClient`,
  `claudeCodeModelClient`) and the Firebase AI Logic constructed-model
  adapter (`createFirebaseAiLogicModelClient`) each return a `ModelClient`.
  `withRetry` decorates one.
- **The on-device engine.** `createEngine` loads ONNX models in the
  browser via `@huggingface/transformers` + ONNX Runtime Web (WebGPU /
  WASM) and exposes them behind a narrow `Engine` surface that streams
  `EngineEvent`s.

> **Status.** Contract + cloud providers are the live integration path:
> relay and agent both consume a `ModelClient`. `createEngine` loads a
> model through `@huggingface/transformers` and `generate()` streams real
> tokens (the end-to-end load path runs in `examples/local-llm-poc`,
> headless-verified). The engine is now a `ModelClient` too, via
> `createEngineModelClient` (root),
> which widens the engine's `EngineEvent` stream to the contract's
> `ModelEvent`. The old `@inbrowser/model/relay` and
> `@inbrowser/model/agent` adapter subpaths have been removed.
> Known gaps: `GenerateOpts.stop` sequences are accepted but not yet
> enforced, and the site's in-browser docs-chat path that drives a local
> engine through the agent is still forthcoming (the adapter exists; the
> site toggle does not).

## A cloud model as a `ModelClient`

```ts
import { geminiModelClient } from '@inbrowser/model';

const client = geminiModelClient({ apiKey: process.env.GEMINI_KEY, model: 'gemini-3.5-flash' });

for await (const evt of client.chat(
  {
    messages: [{ role: 'user', text: 'Explain WebGPU in one paragraph.' }],
    tools: [],
    toolUseEnabled: false,
  },
  new AbortController().signal,
)) {
  if (evt.kind === 'text') process.stdout.write(evt.text);
  else if (evt.kind === 'usage') console.error(evt.usage);
}
```

The turn ends when the iterable returns; a `usage` event (or a terminal
`error` event) is the last thing emitted. There is no `turn_complete`
event.

## Firebase AI Logic from an existing Firebase app

Firebase AI Logic uses the Firebase app that the host already configured. The
host owns Firebase initialization, App Check, backend selection, Vertex AI
location, and construction of the `GenerativeModel`; this package only adapts
that model to `ModelClient`:

```ts
import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
import { createFirebaseAiLogicModelClient } from '@inbrowser/model';

const app = initializeApp(firebaseConfig);
// Initialize App Check for `app` before making production AI requests.
const ai = getAI(app, { backend: new GoogleAIBackend() });
const firebaseModel = getGenerativeModel(ai, { model: 'gemini-3.5-flash' });
const client = createFirebaseAiLogicModelClient(firebaseModel);
```

The adapter streams text and thinking, translates caller-run custom function
calls (including thought-signature replay), maps sampling and usage, forwards
cancellation, and normalizes Firebase errors. It has no `firebase` dependency:
the constructed model crosses a small structural interface. Live API, Imagen,
server templates, Firebase built-in/automatic tools, multimodal events,
structured-output configuration, token counting, and hybrid lifecycle control
are intentionally outside this adapter. See the
[Firebase AI Logic reference](docs/reference/firebase-ai-logic.md).

## A local OpenAI-compatible server

Ollama, llama.cpp's `llama-server`, vLLM, LM Studio, LocalAI, and friends all
expose the same OpenAI `POST /v1/chat/completions` wire shape. One generic
factory talks to any of them; two named presets carry the right defaults for
the common local servers:

```ts
import {
  openaiCompatModelClient, // any OAI server — set baseUrl (or endpoint)
  ollamaModelClient,       // preset: defaults to http://localhost:11434, no auth
  llamaServerModelClient,  // preset: defaults to http://localhost:8080
} from '@inbrowser/model';

// Generic: point at any OAI-compatible server. `apiKey` becomes a Bearer token.
const vllm = openaiCompatModelClient({ baseUrl: 'http://gpu.local:8000', model: 'qwen2.5' });

// llama.cpp llama-server. `--api-key` is optional; pass it as `apiKey`.
const llama = llamaServerModelClient({ model: 'qwen2.5-coder', apiKey: process.env.LLAMA_KEY });
```

> **Tool calling on `llama-server` needs `--jinja`.** The server only honors the
> OpenAI `tools` array when launched with `--jinja` (so it applies a tool-aware
> chat template); without it, tool calls never stream back. Auth is off unless
> you start it with `--api-key KEY`.

The presets delegate to `openaiCompatModelClient`; reach for the generic factory
directly for any server without a named preset.

## An on-device model via the engine

```ts
import { createEngine, gemma4_E2B } from '@inbrowser/model';

const engine = createEngine(gemma4_E2B);
await engine.ensureReady();

for await (const evt of engine.generate([
  { role: 'user', text: 'Explain WebGPU in one paragraph.' },
])) {
  if (evt.kind === 'token') process.stdout.write(evt.text);
}
```

The engine speaks `EngineEvent` (`token` / `thinking` / `tool_call` /
`usage` / `error`), not `ModelEvent`. To use it as a `ModelClient` —
e.g. to hand it to the agent — wrap it with `createEngineModelClient`:

```ts
import { createEngine, createEngineModelClient, smollm2_360m } from '@inbrowser/model';

const engine = createEngine(smollm2_360m);
const client = createEngineModelClient(engine); // a ModelClient

for await (const evt of client.chat(
  { messages: [{ role: 'user', text: 'Hello' }], tools: [], toolUseEnabled: false },
  new AbortController().signal,
)) {
  if (evt.kind === 'text') process.stdout.write(evt.text);
}
```

The adapter maps `token` → `text`, folds the engine's terminal `usage`
into a `ModelEvent` `usage`, passes `tool_call`s through (no signature),
and drops the engine-only extras (`decodeMs`, `recoverable`). Wiring a
local model into the docs-chat site through the agent is forthcoming;
the `createEngineModelClient` building block it needs now exists.

## Surface

Everything is imported from the package root `@inbrowser/model`.

| Export | What it gives you |
|---|---|
| `ModelClient`, `ModelRequest`, `ModelEvent`, `ModelMessage`, `ModelUsage`, `ToolSpec`, `ReasoningEffort` | The shared contract (type-only) |
| `geminiModelClient`, `openrouterModelClient`, `requestyModelClient`, `anthropicModelClient`, `openaiCompatModelClient`, `ollamaModelClient`, `llamaServerModelClient`, `claudeCliModelClient`, `claudeCodeModelClient` | Cloud + local provider factories; each returns a `ModelClient` |
| `createFirebaseAiLogicModelClient(model, opts?)` | Wraps a caller-constructed Firebase AI Logic `GenerativeModel`; Firebase/App Check lifecycle stays with the host |
| `OpenAiCompatConfig`, `OllamaConfig`, `LlamaServerConfig` | Config shapes for the OpenAI-compatible factory and its local presets |
| `withRetry(client, opts?)` | Decorator that retries transient upstream errors while nothing has streamed |
| `CloudProviderConfig`, `ModelClientFactory` | Shared provider config + the factory type the relay routes on |
| `createEngine(preset)` | Runtime `Engine` — owns load state + decode loop, streams `EngineEvent` |
| `createEngineModelClient(engine, id?)` | Wraps an `Engine` as a `ModelClient` (maps `EngineEvent` → `ModelEvent`) |
| `definePreset(p)` | Type-safe identity helper for community presets |
| `parseToolCalls`, `splitThinking` | Stream transformers over an `EngineEvent` stream |
| `ModelPreset`, `Engine`, `EngineEvent`, … | Public engine types |
| `gemma4_E2B`, `gemma4_E4B`, `qwen2_5_coder_1_5b`, `qwen3_1_7b`, `deepseek_r1_qwen_1_5b`, `smollm2_360m` | The six bundled presets |
| `hostEngineInWorker(self)`, `connectWorkerEngine(opts)` | Worker host/connect helpers |

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
- `EngineEvent` is narrower than the contract's `ModelEvent` (no
  cost, no `thoughtSignature`). `createEngineModelClient` is the place
  that widens it — translate at that boundary, not in the engine.
- Worker subpath returns the same `Engine` shape; a consumer cannot
  tell whether it holds a direct or remote engine.
- Tool calling is not native to Gemma 4. The polyfill (prompt-engineered
  tool calling + structured-output parsing) lives in `@inbrowser/agent`,
  not here.
