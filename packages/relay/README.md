# @inbrowser/relay

`@inbrowser/relay` is a resumable LLM inference relay. It is a **pure transport**:
it wraps `@inbrowser/resumable` with Web-standard request handlers, framework
adapters, and a reconnecting browser-safe client. The relay does not own any
providers — it *consumes* `ModelClient` factories from
[`@inbrowser/model`](../model) and serves them resumably over HTTP.

The relay's primary value is resumability. A backgrounded browser tab, network
drop, or stream handler handoff does not have to lose the events already
produced by an in-flight generation. The relay constructs a `ModelClient` for
each request, runs its `.chat()` server-side, writes the streamed
`ModelEvent`s to a durable event log, and clients reconnect from their last
received offset.

## What It Provides

- `createRelay`, which exposes `handleStart(request)` and
  `handleStream(request, ctx)` as Web `Request` to `Response` handlers.
- A provider lookup table of `ModelClientFactory`s: the relay calls
  `factory({ apiKey, model })` per request to build a `ModelClient`, then drives
  its `.chat(req, signal)` and stores the `ModelEvent`s it streams.
- SSE helpers shared by the relay, any custom `ModelClient`, and the
  reconnecting client.
- Astro and Express adapters.
- `createResumableClient`, which starts a job, tails the SSE stream, and
  reconnects with `from=<offset>` when a stream drops.

The model contract (`ModelClient`, `ModelEvent`, `ModelRequest`, `ModelMessage`,
`ToolSpec`, `ModelUsage`) lives in `@inbrowser/model/contract`. The relay
re-exports those names for the registration site, and the cloud provider
factories (`geminiModelClient`, `openrouterModelClient`, `anthropicModelClient`,
`ollamaModelClient`, `claudeCliModelClient`, `claudeCodeModelClient`) live in
`@inbrowser/model/providers/*`.

## Quick Start

Import the provider factories from `@inbrowser/model` and register them in the
`providers` map. Each cloud provider factory already matches `ModelClientFactory`
(its config is `{ apiKey?, model }`), so it can be registered directly:

```ts
import { createRelay, type ModelEvent } from '@inbrowser/relay';
import {
  geminiModelClient,
  openrouterModelClient,
} from '@inbrowser/model';
import {
  createRtdbJobStore,
  serviceAccountTokenProvider,
} from '@inbrowser/resumable/rtdb';

const relay = createRelay({
  store: createRtdbJobStore<ModelEvent>({
    url: process.env.RTDB_URL!,
    auth: serviceAccountTokenProvider({ keyFile: './sa.json' }),
    rootPath: 'inference_jobs',
    defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
  }),
  providers: {
    gemini: geminiModelClient,
    openrouter: openrouterModelClient,
  },
});

// POST an inference request and allocate a job:
// await relay.handleStart(request)

// Stream the durable event log as SSE:
// await relay.handleStream(request, { jobId, from })
```

The relay preserves and replays the event log. It does not automatically
restart an upstream provider call if the process running that provider is
killed.

The relay does not choose URL paths for you. Common route shapes are:

- `POST /api/inference/job` - call `relay.handleStart(request)`.
- `GET /api/inference/job/:id/stream?from=N` - call
  `relay.handleStream(request, { jobId: id })`.

## API Keys

The relay supports two modes, configurable per provider.

**BYOK (default).** The client sends `apiKey` in the request body and the relay
forwards it to the provider. A missing key is a `400`. This is the right mode
when the end user brings their own key (the playground case).

**Server-managed.** List the provider in `apiKeys` and the relay resolves the
key itself, so the browser never carries it on the wire. This is the "your app,
your bill" mode.

```ts
import {
  geminiModelClient,
  anthropicModelClient,
  ollamaModelClient,
} from '@inbrowser/model';

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
    // ollama omitted, so it stays BYOK (the client supplies its base URL).
  },
});
```

A client that sends a non-empty `apiKey` for a server-managed provider gets a
`400`, so a forgotten BYOK field cannot silently leak to the wire. If a resolver
throws, `handleStart` returns `500` and no job is created.

The function form receives the raw `Request`, so the key can be derived from an
`Authorization` header the browser already sends (the browser carries its own
user token, never the provider key), a session cookie, or a per-user store:

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

## Client

```ts
import {
  createResumableClient,
  installBrowserLifecycle,
} from '@inbrowser/relay/client';

const client = createResumableClient({
  startUrl: '/api/inference/job',
  streamUrl: (jobId, from) =>
    `/api/inference/job/${encodeURIComponent(jobId)}/stream?from=${from}`,
  installLifecycle: installBrowserLifecycle(),
});

for await (const event of client.stream({
  provider: 'gemini',
  model: 'gemini-3-flash-preview',
  messages: [{ role: 'user', text: 'Hello' }],
  tools: [],
  apiKey: userApiKey,
})) {
  // Render text, thinking, tool calls, usage, or errors.
}
```

## Framework Adapters

- Hono, Bun, and Cloudflare Workers can call the Web-standard relay handlers
  directly.
- Astro uses `createAstroRoutes(relay)` from
  `@inbrowser/relay/adapters/astro`.
- Express and Cloud Functions Gen 2 use `createExpressHandlers(relay)` from
  `@inbrowser/relay/adapters/express`.

## Documentation

The documentation follows the Diataxis approach: each page serves one kind of
user need.

- [Tutorial: create a relay with a fake provider](docs/tutorial.md) - learn
  the relay flow without real API keys.
- [How to wire a web app](docs/how-to-wire-a-web-app.md) - connect server
  routes and the reconnecting client.
- [How to write a provider](docs/how-to-write-a-provider.md) - implement a
  `ModelClient` for an upstream LLM and register it without changing the relay.
- [API reference](docs/reference.md) - facts about exports, types, handlers,
  adapters, the provider contract, and SSE.
- [How the relay works](docs/how-it-works.md) - the design rationale and
  reconnection model.

## Package Exports

- `@inbrowser/relay` - relay factory, transport types, the re-exported model
  contract types, and the `ModelClientFactory` type for the registration site.
  Providers are NOT exported here — import the factories from `@inbrowser/model`.
- `@inbrowser/relay/sse` - SSE reader and encoder helpers.
- `@inbrowser/relay/adapters/astro` - Astro route adapter.
- `@inbrowser/relay/adapters/express` - Express-compatible adapter.
- `@inbrowser/relay/client` - reconnecting client and browser lifecycle helper.
