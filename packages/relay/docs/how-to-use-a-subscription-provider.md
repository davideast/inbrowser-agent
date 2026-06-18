# How To Use A Subscription Claude Provider

Use a subscription-backed Claude provider when you want model access through an
existing Claude subscription instead of a metered Anthropic API key.
`@inbrowser/model` ships two factories you can register in the relay:
`claudeCodeModelClient` (the Claude Agent SDK) and `claudeCliModelClient` (the
`claude` command in print mode). Both run server-side, carry no API key on the
wire, and bill against the logged-in subscription rather than per token.

If you want a metered API key instead, register the `anthropicModelClient`
factory and supply a key (see [How to wire a web app](how-to-wire-a-web-app.md)
and the [API reference](reference.md) for the BYOK and server-managed key
modes).

## Pick a provider

Both reach the same models without an API key. They differ in how they talk to
Claude:

- **`claudeCodeModelClient`** drives the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`) in-process. Reach for it when you want a
  library dependency and no separate binary. The SDK is an optional peer
  dependency, so install it alongside.
- **`claudeCliModelClient`** shells out to the installed `claude` binary in
  print mode (`claude -p`). Reach for it when the CLI is already on the host and
  you would rather not add the SDK dependency.

Both factories take a config that extends `{ apiKey?, model }` with their own
options. Since the relay supplies only `{ apiKey, model }` per request, register
them as the bare factory when the defaults are fine, or wrap them to merge in
extra options.

## Use `claudeCodeModelClient`

Install the SDK peer dependency, then register the factory under whatever route
key you like:

```bash
bun add @anthropic-ai/claude-agent-sdk
```

```ts
import { createRelay } from '@inbrowser/relay';
import { claudeCodeModelClient } from '@inbrowser/model';

const relay = createRelay({
  store,
  providers: {
    'claude-code': claudeCodeModelClient,
  },
});
```

The client authenticates from the ambient Claude Code login it finds at
`~/.claude/.credentials.json`. It strips `ANTHROPIC_API_KEY` from the subprocess
environment so a stray key never switches the call back to per-token billing.

If you need to supply the token explicitly (for example in a container with no
login on disk), wrap the factory so the relay-supplied `{ apiKey, model }` is
merged with your `oauthToken`:

```ts
providers: {
  'claude-code': (c) =>
    claudeCodeModelClient({ ...c, oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN }),
}
```

## Use `claudeCliModelClient`

The `claude` binary must be installed and logged in on the host. Register the
factory:

```ts
import { createRelay } from '@inbrowser/relay';
import { claudeCliModelClient } from '@inbrowser/model';

const relay = createRelay({
  store,
  providers: {
    'claude-cli': claudeCliModelClient,
  },
});
```

It spawns `claude -p` with a streaming-JSON output format and reads the NDJSON
stream back as `ModelEvent`s. By default it runs in a temporary working
directory, so it ignores the host project's `CLAUDE.md` and settings.

If the binary is not on `PATH`, or you need a longer timeout for long
generations, wrap the factory and pass the `ClaudeCliOptions`:

```ts
providers: {
  'claude-cli': (c) =>
    claudeCliModelClient({ ...c, claudePath: '/usr/local/bin/claude', timeoutMs: 600_000 }),
}
```

## Send a request

A client request looks the same as any other provider, with an empty `apiKey`
because the subscription, not a key, authorizes the call:

```ts
await relay.handleStart(
  new Request('https://app.example/api/inference/job', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'claude-code',
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', text: 'Explain WebGPU in one paragraph.' }],
      tools: [],
      apiKey: '',
    }),
  }),
);
```

Set `reasoningEffort` to `'low'`, `'medium'`, or `'high'` to request extended
thinking; `'off'` (the default) leaves the model's own default in place.

## Limits

- Both clients are Node-only and reject caller-defined `tools`: if a request
  carries a non-empty `tools` array they yield an `error` event. Leave `tools`
  empty.
- `temperature`, `topP`, and `topK` are not exposed by either path and are
  ignored.
- These clients authorize from a subscription on the host, so they belong on a
  trusted server, never in code you ship to a browser.

For the `ModelClientFactory` contract, request shape, and the `ModelEvent`s
these emit, see the [API reference](reference.md).
