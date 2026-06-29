# agent-basic

A deterministic script demo for `@inbrowser/agent`.

It wires a tiny fake model, a real `ToolRegistry`, the default ReAct loop strategy, and session events. No provider keys are required.

```sh
bun run --cwd examples/agent-basic start
bun run --cwd examples/agent-basic test
```
