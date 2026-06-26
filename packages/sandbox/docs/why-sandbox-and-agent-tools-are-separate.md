# Why sandbox tools and agent tools are separate

`@inbrowser/sandbox` and `@inbrowser/agent` meet at tools, but they do not own
the same problem.

The sandbox owns side effects. It knows which file system, runtime, git service,
package service, preview compiler, checkpoints, and event stream belong together.
Running `sandbox.tools.run('write', ...)` mutates that sandbox and emits sandbox
events.

The agent owns conversation policy. It decides which model to call, which tool
schemas to show the model, how to dispatch tool calls, how to record traces, and
when a turn is finished.

Those responsibilities overlap just enough to need an adapter, but not enough to
make one object own both layers.

## The cohesive boundary

The bridge in `@inbrowser/agent/sandbox` returns `AgentTools`:

```ts
const tools = createSandboxAgentTools(sandbox, {
  names: ['read', 'write', 'edit', 'bash'],
});

const session = createAgentSession({
  strategy,
  llm,
  tools,
});
```

`AgentTools` has two jobs:

```ts
tools.list(); // describes callable tools to the model
tools.execute(call, context); // executes one selected tool call
```

This keeps the session API cohesive. A host passes one tool runtime to the
session instead of separately passing a dispatcher and a tool list that can drift
apart.

## Why the sandbox does not expose `sandbox.agent`

A sandbox is not tied to one agent session. The same sandbox may be inspected by
a UI, replayed by tests, driven by a human terminal, or exposed to more than one
agent configuration over time. Putting agent-specific fields on the sandbox
would make the sandbox look like it owns model-facing policy.

Instead, `createSandboxAgentTools(sandbox)` captures the sandbox in a small
adapter. The adapter is cheap to create, can expose an allowlist, and can be
discarded without changing the sandbox.

## Why `execute` lives on `AgentTools`

The previous shape separated execution from discovery:

```ts
createAgentSession({
  tools: dispatch,
  toolList,
});
```

That worked, but it made the host responsible for keeping two related values in
sync. It also made sandbox integration read strangely because the sandbox already
had bound tools.

The newer shape makes the relationship explicit:

- `sandbox.tools` is the sandbox-owned runtime for direct host calls.
- `AgentTools` is the agent-owned view of callable tools.
- `createSandboxAgentTools(sandbox)` adapts one into the other.

The legacy `tools` plus `toolList` path still exists for compatibility, but new
code should pass an `AgentTools` object.
