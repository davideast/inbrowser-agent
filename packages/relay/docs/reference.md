# API Reference

This page describes the public surface of `@inbrowser/relay`.

## Exports

| Import path | Exports |
| --- | --- |
| `@inbrowser/relay` | `createRelay`; relay/transport types (`Relay`, `CreateRelayOpts`, `ApiKeySource`, `StreamCtx`, `NormalizedRequest`, `Logger`); the re-exported model contract types (`ModelEvent`, `ModelMessage`, `ModelRequest`, `ModelUsage`, `ToolSpec`, `ReasoningEffort`); the `ModelClientFactory` type for the registration site; the client and SSE re-exports |
| `@inbrowser/relay/sse` | `readSseDataLines`, `encodeSseEvent`, `SSE_DONE_LINE`, `SSE_STREAM_OPEN` |
| `@inbrowser/relay/adapters/astro` | `createAstroRoutes` |
| `@inbrowser/relay/adapters/express` | `createExpressHandlers` |
| `@inbrowser/relay/client` | `createResumableClient`, `installBrowserLifecycle` |

The relay does **not** export any providers. Import the cloud provider factories
(`geminiModelClient`, `openrouterModelClient`, `anthropicModelClient`,
`ollamaModelClient`, `claudeCliModelClient`, `claudeCodeModelClient`) from
`@inbrowser/model`.

## `createRelay`

```ts
function createRelay(opts: CreateRelayOpts): Relay;
```

`CreateRelayOpts`:

| Field | Type | Description |
| --- | --- | --- |
| `store` | `JobStore<ModelEvent>` | Required resumable job store. |
| `providers` | `Record<string, ModelClientFactory>` | Provider map keyed by `NormalizedRequest.provider`. Each value is a `ModelClientFactory` from `@inbrowser/model`: the relay calls `factory({ apiKey, model })` per request to build a `ModelClient`, then drives its `.chat()`. |
| `logger` | `Logger` | Optional structured logger. Defaults to silent. |
| `sweep` | `SweepSchedule` | Optional periodic sweep passed to `@inbrowser/resumable`. |
| `apiKeys` | `Record<string, ApiKeySource>` | Optional per-provider server-managed keys. See [Server-managed API keys](#server-managed-api-keys). |

`Relay`:

| Member | Description |
| --- | --- |
| `handleStart(request)` | Parses a `NormalizedRequest`, constructs the provider's `ModelClient`, starts a resumable job, and returns `{ jobId }`. |
| `handleStream(request, ctx)` | Streams the job log as SSE from `ctx.from` or the request query string. |
| `engine` | Underlying `JobEngine<ModelEvent>`. |
| `stop()` | Closes in-flight producers and stops the scheduled sweep. |

`handleStart` returns:

| Status | Meaning |
| --- | --- |
| `201` | Job created. Body is `{ "jobId": "..." }`. |
| `400` | Invalid JSON, missing `provider`, unknown provider, missing `apiKey` in BYOK mode, or a client-supplied `apiKey` for a server-managed provider. |
| `500` | Store or engine failed, or a server-managed `apiKey` resolver threw, before the job could be created. |

`handleStream` returns:

| Status | Meaning |
| --- | --- |
| `200` | SSE stream opened. |
| `400` | Missing job id. |
| `404` | Job not found. |
| `502` | Store read failed before streaming began. |

## `NormalizedRequest`

`NormalizedRequest` is the shared `ModelRequest` (from
`@inbrowser/model`) plus the relay-only transport fields:

```ts
type NormalizedRequest = ModelRequest & {
  // ModelRequest carries: messages: ModelMessage[]; tools: ToolSpec[];
  // toolUseEnabled: boolean; temperature?; topP?; topK?; reasoningEffort?
  provider: string; // routing key — looked up in createRelay's providers map
  model: string; // upstream model id, passed to the ModelClientFactory
  apiKey?: string;
  signal?: AbortSignal; // page-direct consumer cancellation only
};
```

`provider` is the lookup key in the `providers` map. `model` and `apiKey` are
handed to the `ModelClientFactory` (`factory({ apiKey, model })`); the per-call
settings (`messages`, `tools`, sampling) ride the `ModelRequest` into `.chat()`.
`apiKey` is not stored in job metadata by the relay. It is optional on the wire
because the relay resolves it differently per mode (see below); by the time a
provider's `ModelClient` runs, the relay has guaranteed a resolved value.

## Server-managed API keys

By default the relay is BYOK: the client sends `apiKey` in the request body and
the relay 400s if it is missing. To keep the key on the server instead, list the
provider in `CreateRelayOpts.apiKeys`:

```ts
import { geminiModelClient } from '@inbrowser/model/providers/gemini';
import { anthropicModelClient } from '@inbrowser/model/providers/anthropic';
import { ollamaModelClient } from '@inbrowser/model/providers/ollama';

type ApiKeySource =
  | string
  | ((ctx: { req: NormalizedRequest; request: Request }) => string | Promise<string>);

const relay = createRelay({
  store,
  providers: {
    gemini: geminiModelClient,
    anthropic: anthropicModelClient,
    ollama: ollamaModelClient,
  },
  apiKeys: {
    gemini: () => process.env.GEMINI_API_KEY ?? '',
    anthropic: () => process.env.ANTHROPIC_API_KEY ?? '',
    // ollama omitted, so it stays BYOK (the client supplies its base URL)
  },
});
```

Rules per provider:

- **Listed (server-managed):** the relay resolves the key and overwrites
  whatever the client sent. A client that sends a non-empty `apiKey` anyway gets
  a `400` so a forgotten BYOK field cannot silently leak to the wire. If the
  resolver throws, `handleStart` returns `500` and no job is created.
- **Not listed (BYOK):** unchanged. The client supplies `apiKey`; a missing key
  is a `400`.

The function form receives the raw `Request`, so the key can be derived from an
`Authorization` header, a session cookie, or a per-user store:

```ts
apiKeys: {
  anthropic: async ({ request }) => {
    const userId = await getUserIdFromSession(request);
    const key = await db.getUserKey(userId, 'anthropic');
    if (!key) throw new Error('no anthropic key for user');
    return key;
  },
}
```

## `ModelEvent`

The relay's event type is `ModelEvent` from `@inbrowser/model`,
re-exported from `@inbrowser/relay`:

```ts
type ModelEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown; signature?: string }
  | { kind: 'usage'; usage: ModelUsage }
  | { kind: 'error'; message: string };

interface ModelUsage {
  promptTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}
```

The turn ends when the `chat()` iterable returns. On a normal end a `usage`
event is emitted before the return (it carries the final accounting); there is
no separate `turn_complete` event. An `error` event is itself terminal: after it
the iterable returns with no `usage` event. Consumers can rely on exactly one of
{a `usage` event, an `error` event} per turn.

## Provider contract: `ModelClientFactory`

A provider is a `ModelClient` from `@inbrowser/model`, registered as a
`ModelClientFactory`:

```ts
interface ModelClient {
  readonly id: string;
  readonly supportsTools: boolean;
  chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

// The shape createRelay's `providers` map holds (from @inbrowser/model):
type ModelClientFactory = (config: { apiKey?: string; model: string }) => ModelClient;
```

The relay calls the factory per request with `{ apiKey, model }` (so BYOK
per-request keys and routing both work), then drives `.chat(req, signal)` under
`@inbrowser/resumable`. The `ModelClient` owns upstream protocol details only.

## Built-In Providers

The relay ships none. The cloud provider factories live in `@inbrowser/model`
and are imported from `@inbrowser/model`.
Each is a factory that returns a `ModelClient`; the cloud ones match
`ModelClientFactory` directly (config `{ apiKey?, model }`).

| Provider | Factory (`@inbrowser/model`) | Notes |
| --- | --- | --- |
| Gemini | `geminiModelClient` | Uses the Generative Language REST streaming endpoint. Includes retry handling for selected transient Gemini failures. |
| OpenRouter | `openrouterModelClient` | Uses OpenRouter chat completions SSE, reasoning deltas, tools, and usage cost when reported. |
| Requesty | `requestyModelClient` | Uses Requesty's OpenAI-compatible gateway SSE, reasoning deltas, tools, and usage cost when reported. |
| Anthropic | `anthropicModelClient` | Uses Anthropic native Messages streaming. Tool use is intentionally compact. |
| Ollama | `ollamaModelClient` | Talks to a local Ollama server. The request `apiKey` carries the base URL rather than a secret; or pass `baseUrl` via a wrapping factory. |
| Claude (CLI) | `claudeCliModelClient` | Subscription auth. Spawns the `claude` binary in print mode (`claude -p`) and reads its streaming-JSON output. Accepts `ClaudeCliOptions` (`claudePath`, `timeoutMs`). Node-only; rejects caller-defined tools. |
| Claude (Agent SDK) | `claudeCodeModelClient` | Subscription auth. Drives `@anthropic-ai/claude-agent-sdk` (an optional peer dependency) in-process; strips `ANTHROPIC_API_KEY` so the call never falls back to per-token billing. Accepts `oauthToken`. Node-only; rejects caller-defined tools. |

The two Claude providers authorize from a logged-in subscription instead of an
API key, so a client sends an empty `apiKey`. See [How to use a subscription
Claude provider](how-to-use-a-subscription-provider.md).

## SSE Wire Format

Relay-to-client events are single-line SSE data events:

```text
data: {"kind":"text","text":"hello"}

data: [DONE]
```

`SSE_STREAM_OPEN` is emitted first as an SSE comment:

```text
: stream-open
```

`[DONE]` is emitted only when the job reaches terminal state. A connection that
closes without `[DONE]` means the client should reconnect from its current
offset.

## Client

```ts
function createResumableClient(opts: ResumableClientOpts): ResumableClient;
```

`ResumableClientOpts`:

| Field | Description |
| --- | --- |
| `startUrl` | URL for `POST` job creation. |
| `streamUrl` | Builds the stream URL from `(jobId, from)`. |
| `maxAttempts` | Reconnect attempt limit. Defaults to `300`. |
| `reconnectDelayMs` | Delay between reconnects. Defaults to `300`. |
| `onReconnect` | Diagnostic callback for reconnect decisions. |
| `onConsumerAbort` | Callback when the caller aborts the request signal. |
| `installLifecycle` | Hook for browser or host lifecycle integration. |
| `fetchImpl` | Optional `fetch` implementation. |

`client.stream(req)` starts a job and yields `ModelEvent`s until the relay
emits `[DONE]`, an unrecoverable error occurs, or the caller aborts.

## Adapters

`createAstroRoutes(relay, opts?)` returns `{ start, stream }` APIRoute-like
handlers. `opts.jobIdParam` defaults to `id`.

`createExpressHandlers(relay, opts?)` returns `{ start, stream }`
Express-compatible handlers. Options:

| Field | Description |
| --- | --- |
| `jobIdParam` | Route parameter containing the job id. Defaults to `id`. |
| `cors` | Adds permissive CORS headers and handles preflight when true. |
