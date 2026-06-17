# Tutorial: Serve Agents Over MCP

In this tutorial we will expose our own tools to an external host (Claude
Desktop, Claude Code, Cursor, or any MCP client) over the Model Context Protocol.
We will define an agent, stand up an MCP stdio server that serves its tools, and
point a host at it.

This is inverse mode: instead of our code driving an LLM, an external LLM host
drives our tools. The bare `agent serve` command ships zero built-in agents on
purpose, so a host package wires its own. In this lesson, that host package is
the small script we will write.

## 1. Create The Server File

We will build a single Node entry file. Create `serve-agents.ts`:

```bash
touch serve-agents.ts
```

The MCP transport owns stdout, so this file must be Node-only and must never
print to stdout itself. We will drive it through the CLI's `main` function, which
is exactly how host packages wire `agent serve` as a library.

Add the imports:

```ts
import { main } from '@inbrowser/agent/cli';
import type { AgentDefinition } from '@inbrowser/agent';
```

`main` is the same dispatcher the `agent` binary uses. Passing it
`serveAgents` is how a host injects its own tools into the `serve` command.

## 2. Define An Agent

An `AgentDefinition` is a named bundle of tools. Each tool has a `name` and
`description` (this is what the host LLM matches against user intent), an
`inputSchema` in JSON Schema, and an `execute` function.

We will define one agent with a single tool that greets a name. Add this below
the imports:

```ts
const greeterAgent: AgentDefinition = {
  name: 'greeter',
  description: 'Greets people by name.',
  tools: [
    {
      name: 'say_hello',
      description: 'Greet a person by name and return the greeting.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The person to greet' },
        },
        required: ['name'],
      },
      async execute(input, ctx) {
        // `ctx.signal` is the cancellation signal (always present).
        void ctx.signal;
        const who = (input as { name: string }).name;
        return {
          ok: true,
          summary: `greeted ${who}`,
          data: { greeting: `Hello, ${who}!` },
        };
      },
    },
  ],
};
```

Notice that the agent's own `name` (`greeter`) is developer-facing: it shows up
in tooling and `--agent` flags. The host LLM never sees it. What the LLM sees is
each tool's `name` and `description`, so phrase those as the action a user would
ask for.

## 3. Boot The Server

Now we call `main` with the `serve` command and our agent. The `--project` flag
is required: it routes the event log and run log under
`~/.pyric/projects/<project>/`. Add this to the bottom of the file:

```ts
const exitCode = await main({
  argv: ['serve', '--project', 'greeter-demo'],
  serveAgents: [greeterAgent],
});

process.exit(exitCode);
```

Before serving for real, we will confirm the catalog with a dry run. `--dry-run`
prints the tool catalog and exits without binding stdio. Run it like this:

```bash
bunx tsx serve-agents.ts --dry-run
```

Because `argv` is set in code, pass extra flags by editing the `argv` array. For
the dry run, temporarily change the line to:

```ts
argv: ['serve', '--project', 'greeter-demo', '--dry-run'],
```

Run it again and you will see one plan event listing your agent and its tools:

```text
{"type":"dry_run_plan","command":"serve","projectId":"greeter-demo","agents":[{"name":"greeter","tools":["say_hello"]}]}
```

Notice the catalog: one agent, one tool named `say_hello`. That is exactly what
a host will discover. Now remove `--dry-run` from `argv` again so the next step
serves for real.

## 4. Understand What The Host Sees

When a host connects, the server answers two MCP requests. To the host's
`list_tools` call, it returns a flat list of every tool across every agent, each
with its `name`, `description`, and `inputSchema`. The host LLM reads those and
decides when to call one.

When the host issues a `call_tool` request for `say_hello`, the server runs your
`execute` function and returns the result as JSON text:

```json
{ "ok": true, "summary": "greeted Ada", "data": { "greeting": "Hello, Ada!" } }
```

Nothing about the `AgentDefinition` wrapper surfaces to the host. Developers see
agents; the LLM sees tools.

## 5. Point A Host At The Server

A host launches your server as a subprocess and talks to it over stdio. The host
needs the command to run. For an MCP client that reads a JSON config (such as
Claude Desktop), add an entry that runs your file:

```json
{
  "mcpServers": {
    "greeter": {
      "command": "bunx",
      "args": ["tsx", "/absolute/path/to/serve-agents.ts"]
    }
  }
}
```

Use an absolute path so the host can find the file regardless of its working
directory. After the host restarts, it will spawn your server, call `list_tools`,
and surface `say_hello`. Ask the host to greet someone by name and watch it call
your tool.

> The server holds stdin and stdout for the transport and runs until the host
> closes it. Do not pipe other commands through it, and do not write to stdout
> from your tools: log to stderr instead.

## What You Built

You defined an `AgentDefinition`, served its tools over MCP stdio through the
CLI's `main` function, verified the catalog with `--dry-run`, and wired a host to
launch your server. An external LLM can now call your tools as if they were its
own. This is the inverse-mode counterpart to driving a session in code: same
tools, different driver.

Add a second tool to the `greeterAgent.tools` array, dry-run again, and watch the
catalog grow. Every tool you add becomes one more capability the host can reach.

## Next

- To call MCP tools the other way (from your own agent into a remote MCP server),
  see [Connect to a remote MCP server](../how-to/consume-an-mcp-server.md).
- For the `serve` command's flags and the `AgentDefinition` shape, see the
  [MCP serve reference](../reference/cli.md).
