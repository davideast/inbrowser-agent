# relay-basic

A script demo for `@inbrowser/relay` with a fake provider and memory-backed resumable jobs.

It starts a relay job through the Web `Request` API, streams SSE events, and resumes from an offset.

```sh
bun run --cwd examples/relay-basic start
bun run --cwd examples/relay-basic test
```
