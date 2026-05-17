# inbrowser

In-browser agent toolkit. Three packages:

| Package | Purpose |
|---|---|
| [`@inbrowser/agent`](./packages/agent) | Agent runtime, types, CLI, observability |
| [`@inbrowser/relay`](./packages/relay) | Resumable LLM relay — providers, server adapters, reconnecting browser client |
| [`@inbrowser/resumable`](./packages/resumable) | Backend-agnostic streaming-job engine |

Dep graph:

```
@inbrowser/resumable   (no inbrowser deps)
       ↑
@inbrowser/relay       (depends on resumable)

@inbrowser/agent       (independent — does not import relay or resumable)
```

## Development

```bash
bun install
bun run typecheck
bun run build
bun run test
```

Workspaces:

```bash
bun --filter '@inbrowser/agent' run test
bun --filter '@inbrowser/relay' run build
```

## Status

Pre-release. First publish target: `0.1.0`. See [plans/](./plans) for migration history.
