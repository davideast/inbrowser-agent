# model-basic

A keyless script demo for `@inbrowser/model`.

It demonstrates the offline parts of the model contract:

- split `<think>...</think>` output into reasoning and answer events
- parse model-emitted `<tool_call>...</tool_call>` envelopes
- normalize and sum provider usage accounting

```sh
bun run --cwd examples/model-basic start
bun run --cwd examples/model-basic test
```
