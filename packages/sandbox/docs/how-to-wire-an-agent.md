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

## Adapt Sandbox Tools For An Agent Session

Use the agent subpath when the host is already using `@inbrowser/agent`:

```ts
import { createSandboxAgentTools } from '@inbrowser/agent/sandbox';

const sandboxTools = createSandboxAgentTools(sandbox, {
  names: ['read', 'write', 'edit', 'bash'],
});
```

The adapter returns an `AgentTools` object. It does not mutate a registry or
attach agent state to the sandbox.

```ts
sandboxTools.list();
sandboxTools.execute(call, context);
```

## Pass The Sandbox Tools To A Session

```ts
const controller = new AbortController();

const session = createAgentSession({
  strategy,
  llm,
  tools: sandboxTools,
  toolContext: () => ({ signal: controller.signal }),
  systemPromptBuilder,
  metrics,
  history: [],
});
```

The available tools include `read`, `write`, `edit`, `ls`, `grep`, `find`,
`bash`, `git_status`, `package_install`, and `preview_compile`.

The sandbox itself is captured by the adapter, so the session's `ToolContext`
only needs the abort signal unless your app has other tools that need extra
context.

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
const beforeLargeEdit = await sandbox.checkpoints.create('before redesign');

// Later:
await sandbox.checkpoints.restore(beforeLargeEdit.id);
```

Checkpoint restore is a sandbox operation: it uses the sandbox file-system
snapshot API, mutates that sandbox's files, and emits `checkpoint:restore`.
It works with the memory workspace and OPFS-backed workspace because both
implement snapshots.
