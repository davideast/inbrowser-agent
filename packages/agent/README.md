# `@inbrowser/agent`

Agent runtime + agent-friendly CLI in one package. Three consumer surfaces:

- **Library** — `import { createAgentSession, createToolRegistry, ... }`. Pure TypeScript, no React, no DOM, no fetch. The playground UI consumes the same primitives.
- **CLI** — the `agent` binary. NDJSON output by default, `--json` stdin, `--dry-run`, schema introspection, automatic session logs.
- **MCP server** — `agent serve` exposes agent tools over stdio so external LLM hosts (Claude Desktop, others) can drive them as MCP tools.

The library is browser-safe; the CLI and MCP server are Node-only.

## Install

```bash
bun add @inbrowser/agent
# or
npm install @inbrowser/agent
```

The `agent` binary lands in `./node_modules/.bin/`.

## A 30-second example

### Library

```ts
import {
  createAgentSession,
  createReactLoopStrategy,
  createToolRegistry,
  createDispatch,
  createMetricsCollector,
} from '@inbrowser/agent';

const session = createAgentSession({
  strategy: createReactLoopStrategy(),
  llm: yourLlmClient,
  tools: createDispatch(createToolRegistry()),
  toolContext: () => ({ workspace, runtime, sandbox, lint, signal: new AbortController().signal }),
  metrics: createMetricsCollector(),
  history: [],
  id: 'sess-1',
  systemPromptBuilder: (workspace, runtime) => '…',
});

for await (const event of session.submit('hello')) {
  // SessionEvent stream — apply to your store / UI / log
}
```

### CLI

```bash
# Headless single session — text in TTY, NDJSON when piped.
agent run "build a chess rule set"

# JSON payload via stdin.
echo '{"prompt": "reset rules"}' | agent run --json -

# 10 isolated sessions in parallel.
agent fleet --size 10
```

### MCP server

```bash
# Expose agent tools over stdio for an external host.
agent serve --project my-project
```

### CLI commands

| Command | Purpose |
|---------|---------|
| `run` | Headless single session — text in a TTY, NDJSON when piped |
| `fleet` | Run N isolated sessions in parallel |
| `serve` | Expose agent tools over MCP stdio |
| `events` | Inspect a session's event log |
| `undo` | Roll back the last mutating operation via the event log |
| `describe` | Print tool schemas / session metadata |
| `schema` | Emit machine-readable schema introspection |
| `migrate` | Migrate session logs / event-log format |
| `version`, `help` | Version string and usage |

## Subpath exports

| Entry | Surface |
|-------|---------|
| `@inbrowser/agent` | Browser-safe library — `createAgentSession`, `createToolRegistry`, strategies, metrics, storage adapters, event utilities |
| `@inbrowser/agent/cli` | Node-only CLI internals — `main`, command handlers, arg parsing, the `CLI_SPEC` |
| `@inbrowser/agent/node` | Node-only event-log writer — `openEventLog`, `buildRollbackEvent`, id generation |

## Where to go next

Documentation is organised under [`docs/`](./docs/) following the [Diataxis](https://diataxis.fr/) framework:

| If you want to | Read |
|---|---|
| Follow a complete lesson | [Tutorials](./docs/tutorials/) |
| Accomplish a specific task | [How-to guides](./docs/how-to/) |
| Look up a function, event, or CLI flag | [Reference](./docs/reference/) |
| Understand the design choices | [Explanation](./docs/explanation/) |

### Starting points by role

- **Building an agent in code?** Start with [Drive a session from your code](./docs/tutorials/01-drive-a-session-from-code.md).
- **Running the CLI?** Start with [Run the agent CLI](./docs/tutorials/02-run-the-agent-cli.md).
- **Exposing tools to an external host?** Start with [Serve agents over MCP](./docs/tutorials/03-serve-agents-over-mcp.md).
- **Implementing a new LLM provider?** See [Implement a custom `LlmClient`](./docs/how-to/implement-llm-client.md).

## Position in the stack

`@inbrowser/agent` is the agent runtime — independent of domain packages. Hosts compose it with their own `AgentDefinition`s; the bare CLI ships zero built-ins.

See [Inference vs inverse architectures](./docs/explanation/inference-vs-inverse.md) for the two distinct consumer modes.

## Licence

Same as the parent workspace.
