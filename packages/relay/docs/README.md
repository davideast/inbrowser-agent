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
  upstream LLM through the `InferenceProvider` contract.

## Look Up Facts

- [API reference](reference.md) describes exports, types, handlers, adapters,
  built-in providers, client options, and SSE helpers.

## Understand The Design

- [How the relay works](how-it-works.md) explains the job lifecycle, provider
  and adapter split, SSE replay contract, and buffering behaviour.
