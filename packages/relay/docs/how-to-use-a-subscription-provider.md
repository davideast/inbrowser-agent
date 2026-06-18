# How To Use A Subscription Claude Provider

Use a subscription-backed Claude provider when you want model access through an
existing Claude subscription instead of a metered Anthropic API key. The relay
ships two: `claude-code` (the Claude Agent SDK) and `claude-cli` (the `claude`
command in print mode). Both run server-side, carry no API key on the wire, and
bill against the logged-in subscription rather than per token.

If you want a metered API key instead, use the `anthropic` provider and supply a
key (see [How to write a provider](how-to-write-a-provider.md) for the BYOK and
server-managed key modes).

## Pick a provider

Both reach the same models without an API key. They differ in how they talk to
Claude:

- **`claude-code`** drives the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
  in-process. Reach for it when you want a library dependency and no separate
  binary. The SDK is an optional peer dependency, so install it alongside.
- **`claude-cli`** shells out to the installed `claude` binary in print mode
  (`claude -p`). Reach for it when the CLI is already on the host and you would
  rather not add the SDK dependency.

## Use `claude-code`

Install the SDK peer dependency, then register the provider:

```bash
bun add @anthropic-ai/claude-agent-sdk
```

```ts
import { createRelay, claudeCodeProvider } from '@inbrowser/relay';

const relay = createRelay({
  store,
  providers: {
    'claude-code': claudeCodeProvider,
  },
});
```

The provider authenticates from the ambient Claude Code login it finds at
`~/.claude/.credentials.json`. It strips `ANTHROPIC_API_KEY` from the subprocess
environment so a stray key never switches the call back to per-token billing.

If you need to supply the token explicitly (for example in a container with no
login on disk), use the factory:

```ts
import { createClaudeCodeProvider } from '@inbrowser/relay';

const provider = createClaudeCodeProvider({
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
});
```

## Use `claude-cli`

The `claude` binary must be installed and logged in on the host. Register the
provider:

```ts
import { createRelay, claudeCliProvider } from '@inbrowser/relay';

const relay = createRelay({
  store,
  providers: {
    'claude-cli': claudeCliProvider,
  },
});
```

It spawns `claude -p` with a streaming-JSON output format and reads the NDJSON
stream back as inference events. By default it runs in a temporary working
directory, so it ignores the host project's `CLAUDE.md` and settings.

If the binary is not on `PATH`, or you need a longer timeout for long
generations, use the factory:

```ts
import { createClaudeCliProvider } from '@inbrowser/relay';

const provider = createClaudeCliProvider({
  claudePath: '/usr/local/bin/claude',
  timeoutMs: 600_000,
});
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

- Both providers are Node-only and reject caller-defined `tools`: if a request
  carries a non-empty `tools` array they yield an `error` event. Leave `tools`
  empty.
- `temperature`, `topP`, and `topK` are not exposed by either path and are
  ignored.
- These providers authorize from a subscription on the host, so they belong on a
  trusted server, never in code you ship to a browser.

For the provider contract, request shape, and event types these emit, see the
[API reference](reference.md).
