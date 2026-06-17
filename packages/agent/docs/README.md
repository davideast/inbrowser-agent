# `@inbrowser/agent` documentation

`@inbrowser/agent` is an agent runtime, an agent-friendly CLI, and an MCP server
in one package. The runtime drives a model through a tool-calling loop; the CLI
(`agent`) runs sessions headlessly with NDJSON output and session logs; the MCP
server (`agent serve`) exposes tools over the Model Context Protocol so an
external host can drive them. The library is browser-safe (no React, no DOM, no
fetch) and the playground UI consumes the same primitives. The CLI and MCP server
are Node-only.

These docs follow the [Diataxis](https://diataxis.fr/) framework, which sorts
documentation by what you need from it right now: to learn, to get a task done, to
look something up, or to understand why.

## Tutorials

Learning-oriented lessons. Start here if you are new to the package and want to
build something working end to end.

- [Drive a session from your code](./tutorials/01-drive-a-session-from-code.md)
- [Run the agent CLI](./tutorials/02-run-the-agent-cli.md)
- [Serve agents over MCP](./tutorials/03-serve-agents-over-mcp.md)

## How-to guides

Goal-oriented directions. Reach for these when you already know what you want to
accomplish.

- [Implement a custom `LlmClient`](./how-to/implement-llm-client.md)
- [Consume an MCP server](./how-to/consume-an-mcp-server.md)
- [Define and register tools](./how-to/define-and-register-tools.md)
- [Inspect and undo with the event log](./how-to/inspect-and-undo-with-the-event-log.md)

## Reference

Information-oriented description. Consult these while working for exact shapes,
flags, and behaviour.

- [Library API](./reference/library.md)
- [CLI](./reference/cli.md)
- [Events](./reference/events.md)

## Explanation

Understanding-oriented discussion. Read these to grasp the design and the
trade-offs behind it.

- [Inference vs inverse](./explanation/inference-vs-inverse.md)
- [How the ReAct loop works](./explanation/how-the-react-loop-works.md)
