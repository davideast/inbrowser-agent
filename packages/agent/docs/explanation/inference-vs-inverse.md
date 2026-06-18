# Inference vs Inverse: The Two Consumer Modes

`@inbrowser/agent` can be consumed in two fundamentally different ways, and the
difference is not a feature flag or a configuration knob. It is a question of
who owns the loop. Understanding which mode you are in is the single most
important mental model for working with this package, because almost everything
else (which tool interface you implement, what context your tool receives, where
the safety story lives) follows from that one choice.

## Who drives the model?

The two modes are named for the direction the control flows.

In **inference mode** your code drives the model. You hold an `AgentSession`,
you give it a `ModelClient` and a `ToolRegistry`, and you call `session.submit()`.
The agent then runs a ReAct loop: it asks the model what to do, the model calls
your tools, the loop feeds the results back, and it keeps going until the model
produces a final answer. The model is something you drive. The playground UI is
an inference-mode consumer; so is the `agent run` CLI command, and so is any
TypeScript program that imports `createAgentSession`.

In **inverse mode** an external LLM host drives. The host is Claude Desktop,
Claude Code, Cursor, or any other MCP client. You define a set of
`AgentDefinition`s, each holding `AgentTool`s, and `agent serve` exposes every
tool over the Model Context Protocol. The host's own model decides when to call
them. There is no loop inside your process at all: a tool is invoked once, it
runs, it returns, and control goes straight back to the host. The host owns the
conversation, the history, and the reasoning; your process owns only the
behaviour behind each tool.

The name "inverse" is literal. In inference mode the loop lives inside this
package and reaches out to a model. In inverse mode the loop lives inside
someone else's product and reaches in to your tools. The runtime is the same
codebase turned inside out.

## Why both exist

It would be simpler to ship only one mode, so it is worth being clear about why
the package carries both.

Inference mode exists because sometimes you are building the agentic product.
The playground needs to own its own loop: it has a system prompt it controls, a
strategy it can swap, a metrics collector it reads, and a UI that renders every
intermediate step. None of that is possible if a third-party host owns the
conversation. When you are the one shipping the agent experience, you want the
loop in your hands.

Inverse mode exists because sometimes the best agent is one the user already
has. A developer using Claude Desktop does not want to leave it to run your
agent; they want your capabilities to show up inside the model they are already
talking to. Exposing tools over MCP means the host's frontier model, with its
own context about the user's intent, decides when to design a Firestore schema
or audit a backend. You contribute the behaviour, not the brain. This is far
cheaper to build against and far more natural for the user, because there is no
second agent to coordinate with.

The trade-off between them is essentially loop ownership versus reach. Inference
mode gives you total control of the agent at the cost of having to host and
drive a model yourself. Inverse mode gives you instant reach into every MCP
host at the cost of giving up the loop, the prompt, and the reasoning. Neither
is "better"; they answer different questions. Reach for inference mode when the
agent *is* your product. Reach for inverse mode when you want to add capabilities
to an agent someone else already runs.

## How the tools differ

Because the two modes differ in who owns the loop, they cannot share a single
tool interface, and the package deliberately keeps two.

An inference-mode tool is a `ToolHandler`. Its `execute(args, ctx)` receives a
`ToolContext`, which is session-coupled: it can carry a `workspace`, a `runtime`
snapshot, a `sandbox` handle, a `lint` function, and a `signal`. These exist
because the inference loop maintains state across turns. A `ToolHandler` is one
move in an ongoing conversation that the loop is shepherding, so it is given the
session's live context to read and patch. A handler can even return
`workspacePatch` and `runtimePatch` fields that the session folds back into its
own state for the next turn.

An inverse-mode tool is an `AgentTool`. Its `execute(input, ctx)` receives an
`AgentContext`, which is deliberately narrower: a `runId`, a `projectId`, an
`events` log, a cancellation `signal`, an optional `sandbox`, and an optional
`agentApp` for live project access. There is no `workspace` and no `runtime`,
because in inverse mode there is no session holding that state. The host owns the
conversation; each `AgentTool` is one-shot from its point of view. The type
comment in the source says it plainly: an `AgentTool` is a "pure(-ish) function
over input plus minimal context" with "no conversation state".

That is also why an `AgentDefinition` groups tools the way it does. The
definition's own `name` (`'hello-firestore'`, `'firestore-data-modeling'`) is a
developer-facing id that surfaces in `agent describe` and `--agent` flags. It is
*not* what the host model sees. The host sees each individual tool's `name` and
`description`, which is why those should be phrased as verbs a user would utter
(`design_firestore_schema`, not `data_modeling__plan`). Developers see
definitions; LLMs see tools.

There is one important consequence of having two interfaces: a tool's behaviour
does not automatically port between modes. A `ToolHandler` that reaches for
`ctx.workspace` has no equivalent in inverse mode, because that state does not
exist there. When you want a capability available in both modes you implement it
against the narrower contract and adapt outward, not the other way around.

## Why one call, no loop

A natural question in inverse mode is: if there is no loop, how does the model
chain several steps together? The answer is that the host's loop does the
chaining. The host calls one tool, reads its result, reasons about it, and
decides whether to call another. Multi-step work that would be a ReAct loop in
inference mode becomes a sequence of independent host-driven calls in inverse
mode.

This is also why plan-and-commit chaining in inverse mode is enforced per-tool
rather than by the framework. A preview or plan tool returns a `planHash` in its
result; the corresponding commit tool requires that same hash before it will
execute. The framework does not remember that a plan happened, because the
framework holds no conversation state. The hash is the only thread connecting the
two calls, and it exists precisely so that the user-approved plan is provably the
thing that gets committed even though the two calls are otherwise unrelated.

## The event log and the inverse safety story

The most consequential difference between the modes is what backs their safety
guarantees, and this is where inverse mode earns its design.

In inference mode you can see everything as it happens. The session streams
events to your UI, the loop is in your process, and a user watching the
playground sees each tool call before the next one runs. Oversight is ambient.

In inverse mode you have given the loop away. You cannot watch the host's model
reason, you do not control when it calls a mutating tool, and you cannot insert a
confirmation step into a conversation you do not own. The safety story therefore
cannot rely on live oversight. It relies on the event log instead.

Every inverse-mode call writes to an append-only event log keyed by project, and
that log is the same one `wrapMutating` writes to on the inference side, so both
modes feed one auditable record. The log records mutations in three phases: a
`plan` phase capturing intent before the tool runs, a `commit` phase capturing
the after-image and, when one exists, a `reverseOp` describing how to undo the
mutation, and a `rollback` phase emitted when a call fails mid-flight or when
`agent undo` reverses a previously committed event. Each `agent serve` call also
writes a run record tagged `mode: 'inverse'` so the audit trail shows which host
call produced which events.

This is what makes letting a third-party model call mutating tools defensible.
You did not get to approve each call in the moment, but every call is recorded,
every reversible mutation carries the operation that undoes it, and `agent undo`
can walk the log backwards turning commits into rollbacks. The guarantee shifts
from "a human approved this before it happened" to "everything that happened is
recorded and the reversible parts can be reversed". For an autonomous external
driver, an after-the-fact audit-and-undo trail is a more honest safety model than
a confirmation prompt you were never present to answer. The event log is not a
logging convenience bolted on; in inverse mode it is the safety mechanism.

## Where to go from here

This page is about the shape of the two modes and why they are distinct. For the
mechanics of the loop that inference mode runs, see
[How the ReAct loop works](./how-the-react-loop-works.md). For the step-by-step
of standing up each mode, see the tutorials on
[driving a session from code](../tutorials/01-drive-a-session-from-code.md) and
[serving agents over MCP](../tutorials/03-serve-agents-over-mcp.md). For the
exact shapes of `ToolHandler`, `AgentTool`, and the event types, see the
[library reference](../reference/library.md) and the
[events reference](../reference/events.md).
