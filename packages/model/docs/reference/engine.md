# Engine Reference

This page describes the opt-in `@inbrowser/model/local` export: the engine factory,
the `Engine` surface, the event vocabulary, and the stream transformers.

For preset data and the shared static types they carry, see
[./presets.md](./presets.md). For the worker helpers, see
[./adapters-and-worker.md](./adapters-and-worker.md).

This page covers the on-device engine. The same package also owns the cloud
providers and the shared `ModelClient` contract — see the package
[README](../../README.md) and [contract source](../../src/contract.ts) for
those.

## Exports

Everything on this page is imported from `@inbrowser/model/local`.

| Symbols | What they are |
| --- | --- |
| `createEngine`, `definePreset`, `parseToolCalls`, `splitThinking`, and engine types | The on-device engine surface |
| The six bundled presets | `deepseek_r1_qwen_1_5b`, `gemma4_E2B`, `gemma4_E4B`, `qwen2_5_coder_1_5b`, `qwen3_1_7b`, `smollm2_360m`. See [./presets.md](./presets.md). |
| `createEngineModelClient` | Wraps an `Engine` as a `ModelClient`. See [./adapters-and-worker.md](./adapters-and-worker.md). |
| `hostEngineInWorker`, `connectWorkerEngine` | Worker host/connect helpers. See [./adapters-and-worker.md](./adapters-and-worker.md). |

> The removed `@inbrowser/model/relay` and `@inbrowser/model/agent` adapter
> subpaths are gone. The engine is now a `ModelClient` via
> `createEngineModelClient` (from `@inbrowser/model/local`). See
> [./adapters-and-worker.md](./adapters-and-worker.md).

## `createEngine`

```ts
function createEngine(opts: CreateEngineOpts): Engine;
```

Constructs an `Engine` bound to a single model. Weight loading is deferred
until `ensureReady()` or the first `generate()` call. Spread a `ModelPreset`
into the call along with optional `EngineHooks`.

```ts
import { createEngine, gemma4_E2B } from '@inbrowser/model/local';

const engine = createEngine({ ...gemma4_E2B, onLoadProgress: console.log });
```

`CreateEngineOpts` is `ModelPreset & EngineHooks`.

### `ModelPreset`

A fully-specified model configuration.

| Field | Type | Description |
| --- | --- | --- |
| `model` | `ModelRef` | HF Hub locator. |
| `dtype` | `Dtype` | Weight/activation precision. |
| `backend` | `Backend` | ONNX Runtime Web execution backend. |
| `capabilities` | `EngineCapabilities` | Static, pre-load capability declaration. |
| `chatTemplate?` | `(messages: ReadonlyArray<EngineMessage>) => string` | Optional override of the tokenizer's bundled chat template. |

### `EngineHooks`

Non-preset construction options.

| Field | Type | Description |
| --- | --- | --- |
| `weightsBaseUrl?` | `string` | Base URL for weight fetches. Defaults to huggingface.co. The engine appends `{modelId}/{file}`. With multiple engines spanning different remotes, the last one to load wins. |
| `minGpuMemoryMb?` | `number` | Minimum reported GPU memory in MB. Below this, `ensureReady()` rejects rather than crashing mid-load. |
| `onLoadProgress?` | `(p: LoadProgress) => void` | Callback for load progress. Equivalent to subscribing via `on('load', ...)`. |

### `ModelRef`

HF Hub repo id with an optional pinned revision.

| Field | Type | Description |
| --- | --- | --- |
| `modelId` | `string` | HF Hub repo id. |
| `revision?` | `string` | Optional revision. Pin for reproducibility; `main` drifts. |

### `Dtype`

```ts
type Dtype = 'q4f16' | 'q8' | 'fp16' | 'fp32';
```

| Value | Meaning |
| --- | --- |
| `q4f16` | 4-bit int weights, fp16 activations. |
| `q8` | 8-bit int weights. |
| `fp16` | Half precision throughout. |
| `fp32` | Full precision. |

### `Backend`

```ts
type Backend = 'auto' | 'webgpu' | 'wasm';
```

| Value | Meaning |
| --- | --- |
| `auto` | Probe `navigator.gpu`; fall back to wasm if absent. |
| `webgpu` | WebGPU compute pipeline. |
| `wasm` | SIMD CPU fallback. Always available, much slower. |

### `EngineCapabilities`

Static capability declaration carried on `ModelPreset.capabilities`.

| Field | Type | Description |
| --- | --- | --- |
| `supportsTools` | `boolean` | Whether the model's chat template accepts tool declarations and emits tool-call envelopes. |
| `supportsVision` | `boolean` | Whether the model accepts image input. |
| `supportsAudio` | `boolean` | Whether the model accepts audio input. |
| `contextWindow` | `number` | Context window in tokens. |
| `supportsThinking` | `boolean` | Whether the model emits thinking traces when prompted. |
| `thinkingTags?` | `{ openTag: string; closeTag: string; implicitOpen?: boolean; stripTokens?: ReadonlyArray<string> }` | When set, describes the reasoning-tag wrapper the model uses. Shape matches `ThinkingSplitOpts` so the preset can be spread into `splitThinking()`. |

## `Engine`

The runtime engine. One engine per model instance.

| Member | Signature | Description |
| --- | --- | --- |
| `model` | `readonly ModelRef` | The bound model locator. |
| `state` | `readonly EngineState` | Current lifecycle state. |
| `capabilities` | `readonly EngineCapabilities` | Static capabilities, equal to `preset.capabilities`. |
| `ensureReady` | `() => Promise<void>` | Idempotent. Loads weights and resolves once state is `'ready'`. |
| `on` | `<K extends keyof EngineEventMap>(event: K, handler: (value: EngineEventMap[K]) => void) => () => void` | Subscribe to a lifecycle event. Returns an unsubscribe function. |
| `generate` | `(messages: ReadonlyArray<EngineMessage>, opts?: GenerateOpts) => AsyncIterable<EngineEvent>` | Run inference, yielding `EngineEvent`s. |
| `dispose` | `() => Promise<void>` | Release GPU buffers and tokenizer state. The engine is unusable afterward. |

### `EngineState`

```ts
type EngineState = 'idle' | 'loading' | 'ready' | 'error' | 'disposed';
```

### `EngineEventMap`

The events `engine.on()` subscribes to.

| Event | Value type | Description |
| --- | --- | --- |
| `state` | `EngineState` | Emitted on each state transition. |
| `load` | `LoadProgress` | Emitted during cold start. |

### `LoadProgress`

Progress for the observable phases of cold start.

```ts
type LoadProgress =
  | { phase: 'fetch'; file: string; loadedBytes: number; totalBytes: number }
  | { phase: 'init'; backend: Backend }
  | { phase: 'warmup'; tokensGenerated: number }
  | { phase: 'ready' };
```

| Phase | Meaning |
| --- | --- |
| `fetch` | Weights flowing from HF Hub (or `weightsBaseUrl`) into the browser Cache API. Cached after first run. |
| `init` | ONNX Runtime compiling the graph for `backend`. |
| `warmup` | First forward pass primes WebGPU pipelines and kernel caches. |
| `ready` | Terminal phase; safe to `generate`. |

## `generate`

```ts
generate(
  messages: ReadonlyArray<EngineMessage>,
  opts?: GenerateOpts,
): AsyncIterable<EngineEvent>;
```

Applies the model's chat template to `messages`, drives the decode loop, and
yields `EngineEvent`s. The terminal event is `usage` on success, or `error` on
failure.

```ts
for await (const evt of engine.generate([{ role: 'user', text: 'Hello' }])) {
  if (evt.kind === 'token') process.stdout.write(evt.text);
}
```

### `EngineMessage`

Engine-side chat message. The engine is toolless: there is no `tool` role.

| Field | Type | Description |
| --- | --- | --- |
| `role` | `'system' \| 'user' \| 'assistant'` | Message role. |
| `text` | `string` | Message text. |
| `media?` | `ReadonlyArray<MediaPart>` | Inline media for multimodal models. Dropped on the text-only path. |

### `MediaPart`

```ts
type MediaPart =
  | { kind: 'image'; data: Blob | ArrayBuffer; mimeType: string }
  | { kind: 'audio'; data: Blob | ArrayBuffer; mimeType: string };
```

### `GenerateOpts`

| Field | Type | Description |
| --- | --- | --- |
| `maxNewTokens?` | `number` | Maximum tokens to decode. Defaults to `512`. |
| `temperature?` | `number` | Sampling temperature. When set, enables sampling (`do_sample`). |
| `topP?` | `number` | Nucleus sampling cutoff. |
| `topK?` | `number` | Top-k sampling cutoff. |
| `stop?` | `ReadonlyArray<string>` | Stop sequences. Accepted but not yet enforced. |
| `signal?` | `AbortSignal` | Caller-side cancellation. Aborting stops the decode loop. |
| `tools?` | `ReadonlyArray<ToolSpec>` | Tool declarations. Honored only when the preset declares `capabilities.supportsTools: true`; the output stream is then wrapped so `tool_call` events are emitted. |
| `enableThinking?` | `boolean` | Opt into the model's thinking mode. Honored only when the preset declares `capabilities.supportsThinking: true`. |

### `ToolSpec`

Tool declaration matching the OpenAI function-calling format.

```ts
interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}
```

### `EngineEvent`

The engine's narrow event vocabulary.

```ts
type EngineEvent =
  | { kind: 'token'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown }
  | { kind: 'usage'; promptTokens: number; outputTokens: number; decodeMs: number }
  | { kind: 'error'; message: string; recoverable: boolean };
```

| Kind | Fields | Description |
| --- | --- | --- |
| `token` | `text: string` | Decoded text per decode step. |
| `thinking` | `text: string` | Reasoning content. The engine never produces this directly; it is emitted by `splitThinking()`. The variant lives on `EngineEvent` so one `switch (kind)` handles wrapped and raw streams. |
| `tool_call` | `id: string`, `name: string`, `args: unknown` | A tool invocation. `id` is locally generated. `name` is the tool name as the model wrote it. `args` is the parsed object, or `{ _raw: string }` when JSON parsing fails. |
| `usage` | `promptTokens: number`, `outputTokens: number`, `decodeMs: number` | Terminal accounting, once per stream. |
| `error` | `message: string`, `recoverable: boolean` | A failure. `recoverable` distinguishes retryable transients from terminal failures. |

## `definePreset`

```ts
function definePreset<P extends ModelPreset>(p: P): P;
```

Compile-time identity helper. At runtime it returns its argument unchanged; its
value is the completeness check it enforces on caller-defined presets. Used to
author both the bundled presets and community presets.

```ts
import { definePreset } from '@inbrowser/model/local';

export const myPreset = definePreset({
  model: { modelId: 'org/model-ONNX' },
  dtype: 'q4f16',
  backend: 'auto',
  capabilities: {
    supportsTools: false,
    supportsVision: false,
    supportsAudio: false,
    contextWindow: 8_192,
    supportsThinking: false,
  },
});
```

## Stream transformers

The engine emits only `token`, `usage`, and `error` events. Two transformers
wrap an `AsyncIterable<EngineEvent>` and re-emit the same shape with additional
`tool_call` or `thinking` events surfaced. `generate()` applies `parseToolCalls`
internally when tools are passed to a tools-capable preset; `splitThinking` is
applied by the consumer.

### `parseToolCalls`

```ts
function parseToolCalls(
  source: AsyncIterable<EngineEvent>,
  opts?: ToolCallParseOpts,
): AsyncIterable<EngineEvent>;
```

Detects native tool-call envelopes in the token stream and re-emits them as
`tool_call` events. `thinking`, `usage`, and `error` events forward unchanged.
`token` events outside an envelope forward as `token`; inside an envelope they
are buffered and converted to a single `tool_call` on close.

`ToolCallParseOpts`:

| Field | Type | Description |
| --- | --- | --- |
| `format?` | `'qwen'` | Envelope format. Default `'qwen'`: `<tool_call>...</tool_call>` with a JSON body carrying `name` and `arguments` (`parameters` is also accepted). Malformed JSON falls through as `{ _raw: string }`. |
| `generateId?` | `() => string` | Override id generator. Default uses a short random suffix. |

### `splitThinking`

```ts
function splitThinking(
  source: AsyncIterable<EngineEvent>,
  opts?: ThinkingSplitOpts,
): AsyncIterable<EngineEvent>;
```

Splits reasoning-tagged content out of the token stream, re-emitting text inside
the tags as `thinking` events. `usage` and `error` events forward unchanged.

```ts
for await (const evt of splitThinking(engine.generate(msgs))) {
  if (evt.kind === 'thinking') showReasoning(evt.text);
  else if (evt.kind === 'token') showOutput(evt.text);
}
```

`ThinkingSplitOpts`:

| Field | Type | Description |
| --- | --- | --- |
| `openTag?` | `string` | Tag that opens a reasoning block. Default `<think>`. |
| `closeTag?` | `string` | Tag that closes a reasoning block. Default `</think>`. Must be non-empty. |
| `implicitOpen?` | `boolean` | When true, the stream is treated as starting inside the thinking channel; the opening tag is implicit and the first `closeTag` ends the block. Default `false`. |
| `stripTokens?` | `ReadonlyArray<string>` | Literal substrings to strip from `token` events after mode classification. Content inside thinking blocks is unaffected. Default `[]`. |

A preset's `capabilities.thinkingTags` is shape-compatible with
`ThinkingSplitOpts`, so it can be spread directly:
`splitThinking(stream, preset.capabilities.thinkingTags)`.

## Related

- Tutorial: [../tutorials/01-run-a-model-in-the-browser.md](../tutorials/01-run-a-model-in-the-browser.md)
- Design discussion: [../explanation/design.md](../explanation/design.md)
- Presets: [./presets.md](./presets.md)
- Adapters and worker: [./adapters-and-worker.md](./adapters-and-worker.md)
