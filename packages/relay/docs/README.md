# @inbrowser/relay Docs

These docs use the Diataxis approach. Each page serves one user need instead of
mixing a lesson, a task guide, reference facts, and design discussion together.

## Learn By Doing

- [Tutorial: create a relay with a fake provider](tutorial.md) shows the full
  start-and-stream flow without calling a real LLM API.

## Work On A Task

- [How to wire a web app](how-to-wire-a-web-app.md) covers server routes,
  framework adapters, and the reconnecting client.
- [How to write a provider](how-to-write-a-provider.md) covers adding another
  upstream LLM by implementing a `ModelClient` (from `@inbrowser/model`) and
  registering its factory.
- [How to use a subscription Claude provider](how-to-use-a-subscription-provider.md)
  covers the `claude-code` and `claude-cli` providers, which reach Claude through
  a subscription with no API key.

## Look Up Facts

- [API reference](reference.md) describes exports, transport types, the model
  contract, handlers, adapters, the provider factory contract, client options,
  and SSE helpers.

## Understand The Design

- [How the relay works](how-it-works.md) explains the job lifecycle, provider
  and adapter split, SSE replay contract, and buffering behaviour.
