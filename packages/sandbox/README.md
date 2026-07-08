# @inbrowser/sandbox

Runtime-agnostic sandbox orchestration for the inbrowser stack. It sits above
`@inbrowser/workspace` and below `@inbrowser/agent`: workspaces provide files,
shell, git, package, and preview services; sandboxes turn those services into
events, checkpoints, and agent-callable tools.

```ts
import { createBrowserWorkspace } from '@inbrowser/workspace';
import { createWorkspaceSandbox } from '@inbrowser/sandbox';

const workspace = await createBrowserWorkspace({ id: 'local', storage: 'memory' });
const sandbox = await createWorkspaceSandbox({ workspace });

await sandbox.tools.run('write', {
  path: 'src/App.tsx',
  content: 'export default function App() {}',
});

const beforeEdit = await sandbox.checkpoints.create({
  label: 'before edit',
  reason: 'before-tool',
  toolCallId: 'tool-write-app',
});
await sandbox.checkpoints.restore(beforeEdit.id);
```

Use `@inbrowser/workspace` for browser project runtime primitives. Use this package
when a host needs a common tool, checkpoint, event, or runtime adapter layer.

## Documentation

- [Sandbox overview](./docs/overview.md) explains why this layer exists.
- [How to wire a sandbox into an agent](./docs/how-to-wire-an-agent.md) shows the
  `createSandboxAgentTools` path.
- [How to manage checkpoint history](./docs/how-to-manage-checkpoint-history.md)
  shows turn, message, and tool-call metadata for restore flows.
- [Remote container bridge](./docs/remote-container-bridge.md) investigates how
  Apple `container`, WSL containers, and similar runtimes fit into the sandbox
  boundary.
- [Why sandbox tools and agent tools are separate](./docs/why-sandbox-and-agent-tools-are-separate.md)
  explains the boundary between sandbox side effects and agent policy.
- [API reference](./docs/reference.md) lists the public surface.

## What It Owns

- A `Sandbox` contract with a file system, runtime, bound tools, checkpoints,
  optional services, and a chronological event stream.
- Standard tools for file reads/writes/edits, search, shell commands, git
  status, package install, and preview compilation.
- Checkpoint creation, restore, history queries, and pruning over any sandbox
  file system that supports snapshots.
- A `createWorkspaceSandbox` adapter for `@inbrowser/workspace`.
- A remote bridge subpath for adapting WebSocket-backed host/container runtimes
  into the same sandbox contract.
- Host-only remote bridge subpaths for decision-less local container bridges,
  Node/Bun daemons, command runners, and Apple `container` providers.

## What It Does Not Own

- Agent loop policy. Use `@inbrowser/agent` and its `@inbrowser/agent/sandbox`
  bridge to expose sandbox tools to an agent session.
- Browser workspace primitives. Keep files, shell, git, preview, and package
  registries in `@inbrowser/workspace`.
- UI. Render the event stream however your product needs.
