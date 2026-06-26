# How to define and register tools

This guide shows you how to define a tool the agent can call, register it in a
catalog, and dispatch it - including how to mutate session state and how to mark
read-only tools as safe to run in parallel.

A tool is a `ToolHandler`: a name, a description, a JSON Schema for its
arguments, and an `execute` that returns a `ToolResult`. The `ToolRegistry`
holds the catalog; an `AgentTools` object exposes both the list the model sees
and the executor that runs selected tool calls.
For the full `ToolHandler`, `ToolContext`, and `ToolResult` field tables, see
the [tools reference](../reference/library.md).

## Define a tool

Write the handler as a plain object. Describe the arguments with JSON Schema in
`parameters` - this is the schema the model sees when deciding how to call the
tool, so describe each field:

```ts
import type { ToolHandler } from '@inbrowser/agent';

const renameDoc: ToolHandler = {
  name: 'renameDoc',
  description: 'Rename a document in the workspace.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Current document path.' },
      to: { type: 'string', description: 'New document path.' },
    },
    required: ['from', 'to'],
  },
  async execute(args, ctx) {
    const { from, to } = args as { from: string; to: string };
    // ...do the work, respecting ctx.signal for long-running ops
    return {
      ok: true,
      summary: `Renamed ${from} to ${to}.`,
    };
  },
};
```

Keep `summary` to one line. It is the human-readable result the model quotes
back on its next turn, so make it specific (`"Renamed users/alice to users/bob"`,
not `"done"`).

Only `ctx.signal` is guaranteed. The other `ToolContext` fields (`workspace`,
`runtime`, `sandbox`, `lint`, `stitch`) are optional, so a headless host does
not have to mock playground state. Read them defensively if you depend on them.

## Return patches to mutate session state

A tool does not mutate the workspace or runtime directly. Instead it returns
`workspacePatch` / `runtimePatch`, and the session applies them. This keeps the
handler pure with respect to session state and lets the event log capture the
change:

```ts
async execute(args, ctx) {
  const next = applyRename(ctx.workspace, args);
  return {
    ok: true,
    summary: `Renamed ${args.from} to ${args.to}.`,
    workspacePatch: { rules: next.rules },
  };
}
```

Return `runtimePatch` the same way to record runtime state such as the last
sandbox run.

## Mark read-only tools as parallel-safe

If a tool only reads state and has no side effects, set `parallelSafe: true` so
a parallel dispatcher may run it concurrently with other parallel-safe calls in
the same turn. The default is conservative (`false`) - tools are treated as not
safe to parallelise unless they opt in:

```ts
const listDocs: ToolHandler = {
  name: 'listDocs',
  description: 'List document paths in a collection.',
  parameters: {
    type: 'object',
    properties: { collection: { type: 'string' } },
    required: ['collection'],
  },
  parallelSafe: true,
  async execute(args, ctx) {
    const paths = await readPaths(ctx, args);
    return { ok: true, summary: `${paths.length} docs.`, data: { paths } };
  },
};
```

If the same tool also always returns the same result for the same arguments
against the same state, add `pure: true` so a content-addressed cache may serve
repeat calls.

## Register tools in a catalog

Create a registry and register each handler:

```ts
import { createToolRegistry } from '@inbrowser/agent';

const registry = createToolRegistry();
registry.register(renameDoc);
registry.register(listDocs);
```

`register` throws if the name is already present - this catches two factories
shipping the same tool name by accident. If an overlay is intentional, use
`replace`:

```ts
registry.replace(renameDoc); // idempotent: replaces or registers fresh
```

The registry also exposes `unregister(name)`, `has(name)`, `list({ capabilities })`,
and `fork()` for a copy-on-write per-session catalog. If a tool should only
appear for certain hosts, gate it with an `available(caps)` hook on the handler -
`list({ capabilities })` drops handlers whose `available` returns false.

## Create an agent tool runtime

Create an `AgentTools` object over the registry and execute a call. The runtime
looks the handler up by name and invokes it with your context:

```ts
import { createAgentTools } from '@inbrowser/agent';

const tools = createAgentTools(registry);

tools.list(); // ToolHandler[] shown to the model

const result = await tools.execute(
  { id: 'call-1', name: 'renameDoc', args: { from: 'a', to: 'b' } },
  { signal: new AbortController().signal },
);
```

The tool runtime holds a live reference to the registry, so later `register` /
`unregister` calls are visible on the next `execute`. A handler that throws
becomes `{ ok: false, summary: "Tool renameDoc threw: ..." }` rather than
propagating, so your loop does not need a try/catch around every call. An
unknown name returns `{ ok: false, summary: "Unknown tool: ..." }`.

To wire the runtime into a session, pass it as `tools`:

```ts
const session = createAgentSession({
  strategy,
  llm,
  tools,
  toolContext: () => ({ signal }),
  systemPromptBuilder,
});
```

The older `tools` plus `toolList` session shape still works for compatibility,
but new code should prefer a single `AgentTools` value so discovery and execution
cannot drift apart. For the complete field tables and the `available` /
capability shapes, see the
[tools reference](../reference/library.md).
