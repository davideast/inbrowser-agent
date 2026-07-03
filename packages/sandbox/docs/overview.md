# Sandbox Overview

`@inbrowser/sandbox` is the orchestration layer above concrete runtimes. It
absorbs the useful Piebox-shaped ideas into the inbrowser package suite without
turning every layer into the same thing.

The default browser runtime is `@inbrowser/workspace`. Other runtimes, such as
`@inbrowser/node` or WebContainers, can adapt into the same sandbox contract when
they can provide a file system and command runner.

For a concrete investigation of remote Linux container runtimes, see
[Remote Container Bridge](./remote-container-bridge.md).

The package provides:

- a typed `Sandbox` contract
- standard file, search, shell, git, and preview tools
- checkpoint management
- event normalization
- a workspace adapter

## Why This Layer Exists

`@inbrowser/workspace` deliberately stays close to project primitives: files,
preview compilation, shell, git, and package import maps. An app-builder agent
needs another layer above that. It needs tool calls, run events, checkpoints,
and a stable place to adapt future runtimes without rewriting the agent UI.

That is the sandbox boundary. The sandbox can be rendered as a chronological
session timeline, fed to a trace recorder, checkpointed before a risky edit, or
adapted into an agent tool registry. None of those behaviours belong in the
file-system package itself.

## Layering

```text
@inbrowser/agent
  owns session loops, model calls, tool dispatch, and traces

@inbrowser/sandbox
  owns runtime events, standard tools, checkpoints, and runtime adapters

@inbrowser/workspace
  owns browser files, shell, git, packages, and compile-and-mount preview

runtime substrate
  OPFS/memory today; @inbrowser/node or WebContainers can adapt later
```

## Runtime Independence

A sandbox runtime only needs one primitive:

```ts
runtime.run(command, { cwd, signal });
```

That surface is intentionally smaller than a Node clone. A runtime can be
implemented by a structured browser shell, by `@inbrowser/node`, by
WebContainers, or by a remote worker bridge. If it can run commands against the
same file system, the sandbox tools and event stream do not need to care which
runtime produced the result.

## Event First

The sandbox emits structured events for file changes, command starts and
finishes, tool starts and finishes, checkpoints, errors, and destroy lifecycle.
Hosts should treat those events as the source for timelines, inspectors, and
logs. Avoid scraping terminal text when a structured event or service result is
available.

## Agent Boundary

The sandbox is not an agent session. It can be driven by a UI, a terminal, a
test, or an agent. When an agent needs sandbox tools, use
`createSandboxAgentTools(sandbox)` from `@inbrowser/agent/sandbox`; that adapter
returns the agent-owned `AgentTools` shape without putting agent policy on the
sandbox itself.

See [Why sandbox tools and agent tools are separate](./why-sandbox-and-agent-tools-are-separate.md)
for the design rationale.
