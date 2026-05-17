# API Reference

This page describes the public surface of `@inbrowser/relay`.

## Exports

| Import path | Exports |
| --- | --- |
| `@inbrowser/relay` | `createRelay`, relay types, request types, event types, provider contract, built-in providers |
| `@inbrowser/relay/sse` | `readSseDataLines`, `encodeSseEvent`, `SSE_DONE_LINE`, `SSE_STREAM_OPEN` |
| `@inbrowser/relay/adapters/astro` | `createAstroRoutes` |
| `@inbrowser/relay/adapters/express` | `createExpressHandlers` |
| `@inbrowser/relay/client` | `createResumableClient`, `installBrowserLifecycle` |

## `createRelay`

```ts
function createRelay(opts: CreateRelayOpts): Relay;
```

`CreateRelayOpts`:

| Field | Type | Description |
| --- | --- | --- |
| `store` | `JobStore<InferenceEvent>` | Required resumable job store. |
| `providers` | `Record<string, InferenceProvider>` | Provider map keyed by `NormalizedRequest.provider`. |
| `logger` | `Logger` | Optional structured logger. Defaults to silent. |
| `sweep` | `SweepSchedule` | Optional periodic sweep passed to `@inbrowser/resumable`. |

`Relay`:

| Member | Description |
| --- | --- |
| `handleStart(request)` | Parses a `NormalizedRequest`, starts a provider job, and returns `{ jobId }`. |
| `handleStream(request, ctx)` | Streams the job log as SSE from `ctx.from` or the request query string. |
| `engine` | Underlying `JobEngine<InferenceEvent>`. |
| `stop()` | Stops the underlying engine. |

`handleStart` returns:

| Status | Meaning |
| --- | --- |
| `201` | Job created. Body is `{ "jobId": "..." }`. |
| `400` | Invalid JSON, missing `provider` or `apiKey`, or unknown provider. |
| `500` | Store or engine failed before the job could be created. |

`handleStream` returns:

| Status | Meaning |
| --- | --- |
| `200` | SSE stream opened. |
| `400` | Missing job id. |
| `404` | Job not found. |
| `502` | Store read failed before streaming began. |

## `NormalizedRequest`

```ts
interface NormalizedRequest {
  provider: string;
  model: string;
  messages: LegacyChatMessage[];
  tools: LegacyToolDecl[];
  apiKey: string;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
  temperature?: number;
  topP?: number;
  topK?: number;
  signal?: AbortSignal;
}
```

`provider` is the lookup key in the `providers` map. `apiKey` is passed to the
selected provider and is not stored in job metadata by the relay.

## `InferenceEvent`

```ts
type InferenceEvent =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | {
      kind: 'tool_call';
      callId: string;
      name: string;
      args: unknown;
      signature?: string;
    }
  | {
      kind: 'usage';
      promptTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      costUsd?: number;
    }
  | { kind: 'error'; message: string };
```

Providers may add fields to existing event kinds when the field is
provider-specific and optional. New event kinds require client coordination.

## `InferenceProvider`

```ts
type InferenceProvider = (
  req: NormalizedRequest,
) => AsyncIterable<InferenceEvent>;
```

The relay drives the provider under `@inbrowser/resumable`. Providers own upstream
protocol details only.

## Built-In Providers

| Provider | Import | Notes |
| --- | --- | --- |
| Gemini | `geminiProvider` from `@inbrowser/relay` | Uses the Generative Language REST streaming endpoint. Includes retry handling for selected transient Gemini failures. |
| OpenRouter | `openrouterProvider` from `@inbrowser/relay` | Uses OpenRouter chat completions SSE, reasoning deltas, tools, and usage cost when reported. |
| Anthropic | `anthropicProvider` from `@inbrowser/relay` | Uses Anthropic native Messages streaming. Tool use is intentionally compact. |

## SSE Wire Format

Relay-to-client events are single-line SSE data events:

```text
data: {"kind":"text","chunk":"hello"}

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

`client.stream(req)` starts a job and yields `InferenceEvent`s until the relay
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
