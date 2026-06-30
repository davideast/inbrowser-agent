# The in-browser AI stack

Put a language model in a web app without running an inference backend. It runs on the user's GPU in the browser tab, or proxies to a cloud model, and the token stream survives reloads and dropped connections

`@inbrowser` is six composable libraries:
1. `@inbrowser/model` - Run a language model on the user's GPU or through a cloud provider, and switch between them with a one-line change.
1. `@inbrowser/agent` - Let the model use your tools and take several steps to finish a task, right in the browser.
1. `@inbrowser/resumable` - Stream a long answer so a reload, a closed tab, or a dropped connection picks up where it left off instead of starting over.
1. `@inbrowser/relay` - Add a thin server when you'd rather keep API keys off the client or share one run across devices.
1. `@inbrowser/workspace` - Run files, shell commands, package installs, git, snapshots, and preview compilation in a browser workspace.
1. `@inbrowser/sandbox` - Bind workspace capabilities into agent-facing tools, events, checkpoints, and artifacts.


## No API Key or BYOK
On-device models don't need API keys. Cloud models use BYOK (bring your own key): each user supplies their own, and it stays on the client instead of on a server you run.

## Run a model in the browser

```ts
import { createEngine, createEngineModelClient, smollm2_360m } from '@inbrowser/model';

const engine = createEngine({
  ...smollm2_360m,
  onLoadProgress: (p) => {
    if (p.phase === 'fetch') {
      const pct = Math.round((p.loadedBytes / p.totalBytes) * 100);
      console.log(`downloading ${p.file}: ${pct}%`);
    } else {
      console.log(p.phase); // 'init' | 'warmup' | 'ready'
    }
  },
});

await engine.ensureReady(); // downloads ~180 MB once, then caches it

const client = createEngineModelClient(engine);

for await (const ev of client.chat({ 
  messages: [{ 
    role: 'user',
    text: 'Explain quantum tunneling in two sentences.' 
  }], 
  tools: [], 
  toolUseEnabled: false 
}, AbortSignal.timeout(60_000))) {
  if (ev.kind === 'text') console.log(ev.text);
}
```

The weights download once via Transformers.js and run on WebGPU (WASM fallback when there's no GPU). `createEngineModelClient` wraps the engine as a `ModelClient` — the same interface every cloud provider implements, so swapping it for `geminiModelClient({ apiKey, model })` (or `openrouterModelClient`, `requestyModelClient`, `ollamaModelClient`, …) changes that one line and nothing else.

## OpenRouter OAuth for BYOK

Cloud models need a key, and there is no server to keep one on, so the user brings it. For OpenRouter that can be a one-click connect instead of a pasted key:

```ts
import { beginOpenRouterOAuth, completeOpenRouterOAuth, openrouterModelClient } from '@inbrowser/model';

// 1. Send the user to OpenRouter to authorize (full-page redirect or popup).
const { authUrl, codeVerifier } = await beginOpenRouterOAuth({ callbackUrl: location.href });
sessionStorage.setItem('openrouter_verifier', codeVerifier);
location.href = authUrl;

// 2. Back on your callback page, exchange the ?code for the user's own key.
const code = new URLSearchParams(location.search).get('code')!;
const { key } = await completeOpenRouterOAuth({
  code,
  codeVerifier: sessionStorage.getItem('openrouter_verifier')!,
});

// The key belongs to the user, provisioned in their browser. Nothing on your server.
const client = openrouterModelClient({ apiKey: key, model: 'anthropic/claude-3.5-sonnet' });
```

The user clicks Connect OpenRouter and authorizes. Your app receives a key tied to their OpenRouter account, so usage is billed to them and they can revoke it whenever they want. PKCE means there is no client secret, so the exchange runs entirely in the browser.

## Give the model tools

```ts
import {
  createAgentSession,
  createReactLoopStrategy,
  createToolRegistry,
  createDispatch,
  createMetricsCollector,
} from '@inbrowser/agent';
import { openrouterModelClient } from '@inbrowser/model';

// A tool is a plain object: name, description, JSON-schema params, and execute().
const getWeather = {
  name: 'get_weather',
  description: 'Current temperature for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  async execute({ city }: { city: string }) {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=%t`);
    return { ok: true, summary: `${city}: ${await r.text()}` };
  },
};

const registry = createToolRegistry();
registry.register(getWeather);

const session = createAgentSession({
  strategy: createReactLoopStrategy(),
  llm: openrouterModelClient({ apiKey: '<BYOK>', model: 'z-ai/glm-5.2' }),
  tools: createDispatch(registry),
  toolList: registry.list(),
  toolContext: () => ({ signal: new AbortController().signal }),
  systemPromptBuilder: () => 'Answer using the tools when they help.',
  metrics: createMetricsCollector(),
  history: [],
});

const events = session.submit('Is it jacket weather in Oslo?', new AbortController().signal);
for await (const event of events) {
  if (event.kind === 'text') console.log(event.chunk);
}
```

A ReAct loop needs a model that can call tools, so this uses a cloud client. Running on-device? Most small presets can't drive a tool loop. Pair `smollm2_360m` with `createRetrievalStrategy()` to ground answers in your own documents instead, or step up to `qwen2_5_0_5b`, the smallest preset that advertises tool calling. The presets table below marks which is which.

## Keep the stream alive across reloads

```ts
import { createJobEngine, createIdbJobStore } from '@inbrowser/resumable';

type Token = { text: string };

// IndexedDB-backed: the event log persists across page reloads.
const engine = createJobEngine<Token>({ 
  store: createIdbJobStore<Token>() 
});

// The producer keeps running even if the tab navigates away.
const { jobId } = await engine.start(async function* () {
  for (const word of ['Durable ', 'by ', 'default.']) yield { text: word };
});

// Reconnect with the last seq you saw — only newer events replay.
for await (const ev of engine.subscribe(jobId, { from: 0 })) {
  if (ev.kind === 'event') console.log(ev.seq, ev.value.text);
  else if (ev.kind === 'terminal') console.log('status:', ev.status);
}
```

The log is append-only and ordered by `seq`. A consumer that reconnects after a refresh passes the last `seq` it saw and gets only what it missed. There are no duplicates, no lost tokens. The store is swappable: `createMemoryJobStore()` for a single process, `createIdbJobStore()` for the browser, `createRtdbJobStore()` to share a job across machines.

## Packages

### `@inbrowser/model`

The shared `ModelClient` contract that relay and agent both consume, a set of cloud provider factories, and an on-device engine (Transformers.js + ONNX Runtime Web). Single root entrypoint — `import { … } from '@inbrowser/model'`.

**Cloud providers** — each is a factory that returns a `ModelClient` from `{ apiKey, model, … }`:

| Factory | Config | Notes |
|---------|--------|-------|
| `geminiModelClient(config)` | `GeminiConfig` | Google AI Studio / Vertex |
| `openrouterModelClient(config)` | `OpenRouterConfig` | Unified API, many models |
| `requestyModelClient(config)` | `RequestyConfig` | OpenAI-compatible gateway, many models |
| `anthropicModelClient(config)` | `AnthropicConfig` | Anthropic Claude |
| `openaiCompatModelClient(config)` | `OpenAiCompatConfig` | Any OpenAI-compatible server |
| `ollamaModelClient(config)` | `OllamaConfig` | Local Ollama server |
| `llamaServerModelClient(config)` | `LlamaServerConfig` | llama.cpp `llama-server` |
| `claudeCliModelClient(config)` | `ClaudeCliConfig` | Claude CLI subprocess (Node only) |
| `claudeCodeModelClient(config)` | `ClaudeCodeConfig` | Claude Code Agent SDK (Node only) |

`openrouterModelClient` also exports `beginOpenRouterOAuth` / `completeOpenRouterOAuth` for PKCE browser auth (no key on a server).

**On-device engine** — the lower-level API under `createEngineModelClient`. Use it directly when you want raw token events rather than the `ModelClient` contract:

```ts
import { createEngine, smollm2_360m } from '@inbrowser/model';

const engine = createEngine({ ...smollm2_360m });
await engine.ensureReady();

for await (const event of engine.generate([{ role: 'user', text: 'Hi' }])) {
  if (event.kind === 'token') console.log(event.text);
}
```

| Export | Description |
|--------|-------------|
| `createEngine(opts)` | Creates an `Engine` that loads ONNX models via Transformers.js |
| `createEngineModelClient(engine)` | Wraps an `Engine` as a `ModelClient` |
| `definePreset(p)` | Type-safe identity for community presets |
| `parseToolCalls(stream, opts?)` | Extracts tool calls from an `EngineEvent` stream |
| `splitThinking(stream, opts?)` | Separates `<think>` blocks from output |
| `withRetry(client, opts?)` | Wraps a `ModelClient` to retry transient failures |
| `hostEngineInWorker(self, opts?)` | Hosts an `Engine` inside a Web Worker |
| `connectWorkerEngine(opts)` | Connects to a worker-hosted engine |

**Bundled presets** (all `q4f16`). "Tools" marks presets that advertise native tool calling. The rest can still retrieve and answer, but can't drive a ReAct loop:

| Preset | Params | Download | Tools | Notes |
|--------|--------|----------|:-----:|-------|
| `smollm2_360m` | 360M | ~180 MB | ✗ | Default. Runs on WASM, no GPU required. |
| `qwen2_5_0_5b` | 0.5B | ~0.5 GB | ✓ | Smallest tool-capable preset. |
| `qwen2_5_coder_1_5b` | 1.5B | ~1.28 GB | ✓ | Code / fill-in-the-middle. WebGPU only. |
| `qwen3_1_7b` | 1.7B | ~1.36 GB | ✓ | General, frontier-for-size. WebGPU only. |
| `deepseek_r1_qwen_1_5b` | 1.5B | ~1.37 GB | ✗ | Reasoning model; emits `<think>` blocks. |
| `gemma4_E2B` | ~2.3B eff. | ~500 MB | ✗ | Audio-capable. Needs WebGPU. |
| `gemma4_E4B` | ~4.5B eff. | ~1.5 GB | ✗ | Audio-capable. Needs a discrete GPU. |

Author your own with `definePreset({ model: { modelId }, dtype, backend, capabilities })`.

### `@inbrowser/resumable`

A backend-agnostic resumable streaming-job engine. Producers write typed events into a durable ordered log; subscribers tail it from any offset. Single root entrypoint.

| Export | Description |
|--------|-------------|
| `createJobEngine(opts)` | Creates a `JobEngine<TEvent>` with `start()`, `subscribe()`, `get()`, `stop()` |
| `createMemoryJobStore(opts?)` | In-process store (ephemeral) |
| `createIdbJobStore(opts?)` | IndexedDB store (browser-persistent) |
| `createRtdbJobStore(opts)` | Firebase RTDB store (shared across machines) |
| `connectJobEngine(port)` | Wraps a `MessagePort` as a `ConnectedJobEngine` |
| `hostJobEngine(opts)` | Hosts a `JobEngine` in a Worker |
| `sseFromJob(source, opts?)` | Streams a job subscription as an SSE `Response` |
| `encodeSseEvent(value)` | Serializes a value as an SSE `data:` line |
| `createResumableClient(opts)` | Environment-agnostic reconnecting HTTP client |
| `installBrowserLifecycle()` | Returns an abort-on-tab-foreground hook |
| `probeStoreDurability(opts)` | Verifies events survive engine handoff |
| `probeSweepTtl(opts)` | Verifies TTL-based cleanup |

**`createJobEngine` options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `JobStore<TEvent>` | required | Backing store for events |
| `logger` | `Logger` | `silentLogger` | Debug/info/warn/error logger |
| `sweep` | `SweepSchedule` | undefined | Expiry sweep `{ intervalMs, statusFilter?, onResult? }` (store must implement `sweepExpired`) |
| `now` | `() => number` | `Date.now` | Clock for TTL checks |

The RTDB store also exports `serviceAccountTokenProvider` and `staticTokenProvider` for auth.

### `@inbrowser/relay`

Wires `@inbrowser/resumable` to the `ModelClient` contract: routes a provider request, streams the model's events into the durable log, and serves SSE. Use it when you do want a server in the loop (server-managed keys, shared jobs). Single root entrypoint.

```ts
import { createRelay } from '@inbrowser/relay';
import { openrouterModelClient } from '@inbrowser/model';
import { createMemoryJobStore } from '@inbrowser/resumable';

const relay = createRelay({
  store: createMemoryJobStore(),
  providers: { openrouter: openrouterModelClient },
});

// Start an inference job.
const res = await relay.handleStart(new Request('http://localhost', {
  method: 'POST',
  body: JSON.stringify({
    provider: 'openrouter',
    model: 'anthropic/claude-3.5-sonnet',
    messages: [{ role: 'user', text: 'Write a haiku' }],
    apiKey: '<BYOK>',
  }),
}));
const { jobId } = await res.json();

// Stream as SSE. Reconnect after a drop by passing the last seq you saw.
const stream = await relay.handleStream(new Request('http://localhost'), { jobId, from: 0 });
```

| Export | Description |
|--------|-------------|
| `createRelay(opts)` | Creates a `Relay` with `handleStart`, `handleStream`, `engine`, `stop` |
| `createResumableClient(opts)` | Relay-typed reconnecting client (`AsyncIterable<ModelEvent>`) |
| `installBrowserLifecycle()` | Proactive abort on tab-visibility change |
| `createAstroRoutes(relay, opts?)` | `{ start, stream }` Astro route handlers |
| `createExpressHandlers(relay, opts?)` | `{ start, stream }` Express-compatible handlers |
| `readSseDataLines(body)` | SSE line reader (async generator) |
| `encodeSseEvent(event)` | SSE event serializer |

**`createRelay` options:**

| Option | Type | Description |
|--------|------|-------------|
| `store` | `JobStore<ModelEvent>` | Backing store for the event log |
| `providers` | `Record<string, ModelClientFactory>` | Provider name → factory from `@inbrowser/model` |
| `logger` | `Logger` | Optional logger |
| `sweep` | `SweepSchedule` | Optional expiry sweep |
| `apiKeys` | `Record<string, ApiKeySource>` | Optional server-managed keys per provider (the browser never carries the key) |

### `@inbrowser/agent`

A browser-safe agent runtime plus a Node CLI. The runtime (session, strategies, tools, metrics) is the root entrypoint; Node-only and CLI code live behind `/node` and `/cli` subpaths so they never reach the browser bundle. See "Give the model tools" above for a full session.

| Export | Entry | Description |
|--------|-------|-------------|
| `createAgentSession(config)` | `.` | Creates an `AgentSession` with `submit(prompt, signal)`, `cancel()`, `id` |
| `createReactLoopStrategy(opts?)` | `.` | ReAct multi-tool loop (needs a tool-capable model) |
| `createRetrievalStrategy(opts?)` | `.` | Retrieve-then-read RAG strategy (works with small on-device models) |
| `createPlannerExecutorStrategy(opts?)` | `.` | Skill-catalog planner-executor strategy |
| `createToolRegistry()` | `.` | In-memory registry: `register`, `replace`, `unregister`, `list`, `has`, `fork` |
| `createDispatch(registry)` | `.` | Stateless dispatch with `execute(call, ctx)` (`call` is a `ToolCall`) |
| `createMemoizedDispatch(dispatch, opts?)` | `.` | Content-addressed memoized dispatch |
| `createMetricsCollector()` | `.` | Token/cost collector: `recordTurn`, `totals`, `reset` |
| `computeTurnMetrics` / `findPricing` | `.` | Standalone turn-metric and pricing helpers |
| `createMemoryStorage()` / `createLocalStorageAdapter()` / `noopStorage` | `.` | Storage implementations |
| `noopObserver` / `combineObservers(...)` | `.` | `SandboxObserver` helpers |
| `wrapMutating(handler, opts)` | `.` | Wraps a handler so mutations are logged for undo/replay |
| `replayEvents(opts)` | `.` | Replays logged mutations against a dispatch |
| `isWrappedHandler(handler)` | `.` | Checks the `WRAPPED_MARKER` symbol |
| `SKILL_CATALOG` / `routeSkill(prompt, options?)` | `.` | Skill catalog and routing (`catalog` is a field on `options`) |
| `createSpecRegistry()` / `evaluateSpec()` | `.` | Eval harness |
| `openEventLog(projectId, opts?)` | `/node` | NDJSON append-only event log |
| `connectMcpTools(opts)` | `/node` | MCP client tools |
| `main(opts?)` | `/cli` | CLI entry point |
| `CLI_SPEC` / `parseArgs(argv, cwd)` | `/cli` | CLI schema and parser |

**CLI commands (`agent`):**

| Command | Description |
|---------|-------------|
| `run` | Headless single session. Prompt via positional arg or `--json -` stdin. |
| `fleet` | Run N isolated sessions in parallel |
| `describe` | Machine-readable descriptions of commands, scenarios, events |
| `schema` | Dump full CLI schema as JSON |
| `events` | Stream the per-project mutation event log with filters |
| `undo` | Reverse a previously-committed mutation via recorded `reverseOp` |
| `migrate` | Plan forward replay of a project event log |
| `serve` | Inverse-mode MCP server over stdio |
| `version` | Print package version |
| `help` | Show usage |

Any command emits structured output with the global `--output json` (`-o json`) flag, or when piped to a non-TTY.

**Session events** (`SessionEvent` `kind`): `turn_started`, `text`, `thinking`, `tool_started`, `tool_finished`, `workspace_changed`, `runtime_changed`, `turn_completed`, `error`, `completed`, `strategy_event`.

## Installation

Packages are published independently. Install what you need:

```bash
bun add @inbrowser/resumable    # resumable streaming-job engine
bun add @inbrowser/model        # model contract + providers + on-device engine
bun add @inbrowser/relay        # LLM relay (depends on resumable + model)
bun add @inbrowser/agent        # agent runtime + CLI
bun add @inbrowser/workspace    # browser workspace: files, shell, preview, git
bun add @inbrowser/sandbox      # tools, events, checkpoints, artifacts
```

The on-device engine needs Transformers.js as a peer dependency:

```bash
bun add @huggingface/transformers
```

### Development (this monorepo)

```bash
bun install
bun run build          # builds all packages in dependency order
bun run typecheck      # type-checks all packages
bun run test           # runs all package tests
bun run check          # biome lint + format
```

Filter to one workspace:

```bash
bun --filter '@inbrowser/agent' run test
```

### Examples

| Example | What it demonstrates |
|---------|---------------------|
| [`examples/model-basic`](examples/model-basic) | Script-only model helpers: thinking splitting, tool-call parsing, usage normalization |
| [`examples/agent-basic`](examples/agent-basic) | Script-only agent session with a fake model, a real tool registry, ReAct events, and workspace mutation |
| [`examples/resumable-basic`](examples/resumable-basic) | Script-only resumable job flow: start, subscribe, resume from offset, inspect final snapshot |
| [`examples/relay-basic`](examples/relay-basic) | Script-only relay flow: fake provider, memory-backed job, SSE stream, reconnect from offset |
| [`examples/workspace-basic`](examples/workspace-basic) | Script-only workspace flow: files, shell, snapshots, git, and React preview compilation |
| [`examples/sandbox-basic`](examples/sandbox-basic) | Script-only sandbox flow: standard tools, chronological events, checkpoints, restore |
| [`examples/workspace-browser`](examples/workspace-browser) | Browser IDE-style workspace demo for files, preview compilation, terminal, packages, git, snapshots, and events |
| [`examples/sandbox-browser`](examples/sandbox-browser) | Browser sandbox manager for tools, events, checkpoints, files, shell, and preview |
| [`examples/local-llm-poc`](examples/local-llm-poc) | On-device model in the browser: preset selection, load progress, WebGPU/WASM |
| [`examples/resumable-hono-youtube-briefcast`](examples/resumable-hono-youtube-briefcast) | Multi-step media workflow using `@inbrowser/resumable`'s durable log on a Hono server |

## Dependency graph

```
@inbrowser/resumable    no internal deps
@inbrowser/model        no internal deps
@inbrowser/relay        depends on resumable + model
@inbrowser/workspace    no internal deps
@inbrowser/sandbox      depends on workspace
@inbrowser/agent        depends on model + sandbox
```

## Status

Pre-1.0. Versions are coordinated manually:

| Package | Version |
|---------|---------|
| `@inbrowser/resumable` | 0.4.0 |
| `@inbrowser/model` | 0.4.0 |
| `@inbrowser/relay` | 0.4.0 |
| `@inbrowser/workspace` | 0.4.0 |
| `@inbrowser/sandbox` | 0.4.0 |
| `@inbrowser/agent` | 0.4.0 |

Breaking changes are expected until 1.0.
