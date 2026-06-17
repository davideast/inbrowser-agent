# How to consume an external MCP server

This guide shows you how to give an agent the tools from an external MCP server -
a running `pyric serve --bridge`, a Claude-Desktop-style stdio server, or any
other - so the session can call them through the same loop that runs in-process
tools.

The work is in the Node-only entry: `connectMcpTools` handshakes with the
server, lists its tools, and adapts each into a `ToolHandler`. You then register
those handlers and dispatch as usual. For the full options and connection
shapes, see the [`connectMcpTools` reference](../reference/library.md).

## Connect to the server

Import `connectMcpTools` from `@inbrowser/agent/node` and pick a transport:

- If the server exposes a streamable-HTTP endpoint (for example a running
  `pyric serve`'s `mcpUrl`), pass `url`:

  ```ts
  import { connectMcpTools } from '@inbrowser/agent/node';

  const mcp = await connectMcpTools({
    url: 'http://localhost:5173/__pyric/mcp',
  });
  ```

- If you need to spawn the server over stdio, pass `command` (and optional
  `args` / `env`):

  ```ts
  const mcp = await connectMcpTools({
    command: 'my-mcp-server',
    args: ['--stdio'],
    env: { API_KEY: process.env.API_KEY ?? '' },
  });
  ```

`connectMcpTools` resolves once the handshake and `listTools` complete. The
returned `McpConnection` has `tools` (the adapted handlers), `client` (the live
MCP client for prompts or resources), and `close()`.

## Namespace and filter the imported tools

If the server's tool names might collide with your in-process tools or a second
MCP server, set `namePrefix`. The prefix is added to each local name and
stripped before the call is forwarded:

```ts
const mcp = await connectMcpTools({
  url: 'http://localhost:5173/__pyric/mcp',
  namePrefix: 'pyric_',
});
```

If you want only a subset, pass `include`. It receives the prefixed name and
keeps the tool when it returns true:

```ts
const mcp = await connectMcpTools({
  url: 'http://localhost:5173/__pyric/mcp',
  namePrefix: 'pyric_',
  include: (name) => name.startsWith('pyric_write'),
});
```

## Register the tools and build a dispatch

Register each imported handler into a `ToolRegistry`, then create a dispatch
over it:

```ts
import { createToolRegistry, createDispatch } from '@inbrowser/agent';

const registry = createToolRegistry();
for (const tool of mcp.tools) {
  registry.register(tool);
}

const dispatch = createDispatch(registry);
```

`register` throws if a name is already present. If you are layering MCP tools
over handlers that may share a name, prefix them with `namePrefix`, or use
`registry.replace(tool)` when an overlay is intentional.

The adapted handlers run like any other tool. Their `execute` forwards to the
server's `callTool`, passing your `ToolContext.signal` so an aborted turn
cancels the in-flight call:

```ts
const result = await dispatch.execute(
  { id: 'call-1', name: 'pyric_writeRules', args: { source: '...' } },
  { signal: new AbortController().signal },
);
```

## Close the connection

The connection holds a transport (an open socket or a child process). Close it
when the session ends:

```ts
await mcp.close();
```

If you spawned the server over stdio, `close()` also tears down the child
process. Wire it into your shutdown path so a long-lived host does not leak
connections:

```ts
process.on('SIGTERM', () => {
  void mcp.close().finally(() => process.exit(0));
});
```

For the `McpConnectOptions` union, the handshake identity fields
(`clientName` / `clientVersion`), and how MCP results map back to `ToolResult`,
see the [`connectMcpTools` reference](../reference/library.md).
