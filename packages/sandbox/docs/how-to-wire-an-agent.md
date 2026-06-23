# How To Wire A Sandbox Into An Agent

This guide shows you how to expose browser workspace tools to an
`@inbrowser/agent` session through `@inbrowser/sandbox`.

## Create A Workspace Sandbox

```ts
import { createBrowserWorkspace } from '@inbrowser/workspace';
import { createWorkspaceSandbox } from '@inbrowser/sandbox';

const workspace = await createBrowserWorkspace({
  id: 'builder',
  root: '/work',
  storage: 'opfs-with-memory-fallback',
});

const sandbox = await createWorkspaceSandbox({ workspace });
```

The sandbox now has the workspace file system, shell runtime, git service,
package registry, and any preview service you pass in.

## Register Sandbox Tools

Use the agent subpath when the host is already using `@inbrowser/agent`:

```ts
import { createDispatch, createToolRegistry } from '@inbrowser/agent';
import { registerSandboxTools } from '@inbrowser/agent/sandbox';

const registry = createToolRegistry();

registerSandboxTools({
  registry,
  sandbox,
});

const dispatch = createDispatch(registry);
```

The registered tools include `read`, `write`, `edit`, `ls`, `grep`, `find`,
`bash`, `git_status`, `package_install`, and `preview_compile`.

## Pass The Tools To A Session

```ts
const controller = new AbortController();

const session = createAgentSession({
  strategy,
  llm,
  tools: dispatch,
  toolList: registry.list(),
  toolContext: () => ({ signal: controller.signal }),
  systemPromptBuilder,
  metrics,
  history: [],
});
```

The sandbox itself is captured by the registered tool handlers, so the
session's `ToolContext` only needs the abort signal unless your app has other
tools that need extra context.

## Subscribe To Sandbox Events

```ts
const unsubscribe = sandbox.on((event) => {
  if (event.type === 'tool:start') renderToolStarted(event);
  if (event.type === 'tool:finish') renderToolFinished(event);
  if (event.type === 'file') refreshFileTree(event.event.path);
});
```

Use these events for a chronological agent-session UI. Tool events should appear
where they happened in the turn. File events can update files panels, change
summaries, or checkpoints without waiting for the assistant's final text.

## Add Checkpoints Around Risky Work

```ts
import { createCheckpointManager } from '@inbrowser/sandbox';

const checkpoints = createCheckpointManager(sandbox);

const beforeLargeEdit = await checkpoints.create('before redesign');

// Later:
await checkpoints.restore(beforeLargeEdit.id);
```

Checkpoint restore uses the sandbox file-system snapshot API. It works with the
memory workspace and OPFS-backed workspace because both implement snapshots.
