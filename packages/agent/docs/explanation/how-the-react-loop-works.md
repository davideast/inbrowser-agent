# How the ReAct Loop Works

The default strategy in `@inbrowser/agent` is `createReactLoopStrategy()`. It is
the engine that turns a single `session.submit()` call into a multi-step agent:
the thing that lets a model reason, call one of your tools, look at the result,
and decide what to do next. This page explains what that loop is, why it is
shaped the way it is, and the trade-offs baked into its two optional behaviours.
It is not a configuration guide; for the option shapes and defaults, see the
[library reference](../reference/library.md).

## Reason, act, repeat

A strategy is the control flow of an agent turn. The ReAct strategy implements
the reason-act pattern: the model reasons about what to do, acts by calling a
tool, observes the result, and reasons again. The loop is small enough to
describe in full.

It begins by composing the message array as `[system, ...history, user(prompt)]`:
the system prompt, then any prior conversation, then the new user prompt. It then
issues one chat call against the `ModelClient` with the current tool list
attached, and streams the model's `text`, `thinking`, and `tool_call` events
straight through to the caller so a UI can render them live.

What happens next depends on whether the model asked to use any tools.

If the model produced tool calls, the loop dispatches each one against your
`ToolDispatch`, appends each result back into the message array as a `tool`
message, and loops back to issue another chat call. The model now sees the
results of its own actions and can reason about them. This is the "act then
observe" half of the cycle, and it is what lets the agent take several steps to
satisfy one prompt.

If the model produced no tool calls, that turn is the final answer. The loop
emits a `turn_complete` `StrategyEvent` (carrying the turn's usage) and returns.
No tool calls is the agent's way of saying it is done.

That is the whole loop: compose, call, dispatch-and-feed-back on tool calls, stop
on no tool calls.

## Why a ReAct loop at all

It is worth asking why the default is ReAct rather than something more elaborate,
because there are more sophisticated agent architectures: planner-executor
splits, graph-of-thoughts, parallel-branch ensembling.

The reason ReAct is the default is that it is the simplest control flow that is
still genuinely agentic. It interleaves reasoning and action at the finest
possible grain: every action is informed by the result of the previous one, and
nothing is planned further ahead than the next step. That makes it robust to
surprise. When a tool returns something unexpected, the model sees it on the very
next turn and can adapt, because there is no committed plan to invalidate. More
elaborate strategies buy efficiency or parallelism by planning ahead, but they
pay for it with brittleness when reality diverges from the plan, and with much
more machinery to get right.

ReAct is also the right *default* specifically because it makes the fewest
assumptions. The strategy interface is deliberately pluggable: the source notes
that planner-executor, graph-of-thoughts, and parallel-branch strategies sit
alongside this one behind the same `AgentStrategy` interface. ReAct is the floor
everyone can build up from, not a ceiling. You reach for a fancier strategy when
you have a specific reason to; you reach for ReAct when you just want an agent
that works.

## Why a turn cap exists

A reason-act loop has an obvious failure mode: the model keeps calling tools and
never decides it is done. Two tools can ping-pong, or the model can get stuck
re-trying the same action. Left unbounded, the loop would run forever and burn
tokens with nothing to show for it.

The loop guards against this with `maxTurns`, which defaults to 24. It is a
simple iteration cap. If the loop reaches the cap without the model ever
producing a tool-call-free turn, it stops and emits an error saying it exceeded
`maxTurns` without settling. The number is a safety bound, not a target. The
expectation is that real tasks settle well under it; the cap is there to turn an
infinite loop into a clean, observable failure. Treating runaway agents as a
bounded error rather than a hang is the conservative choice, and it is why the
default exists at all rather than trusting every model to always stop on its own.

## Parallel dispatch and the byte-identical promise

By default the loop dispatches the tool calls in a turn one at a time, in order.
That is the conservative behaviour, and it is correct for tools that mutate
shared state, because serialising them means there is no question of one
mutation racing another.

But many tools only read. When a model asks to read three documents in one turn,
running them sequentially wastes wall-clock for no benefit. `parallelDispatch` is
the opt-in that lets the loop run read-only tools concurrently while still
serialising the mutations.

The mechanism rests on a contract: a `ToolHandler` may tag itself `parallelSafe`,
read through `isParallelSafe()` so the default is applied uniformly. When parallel
dispatch is on, the loop partitions a turn's calls into the parallel-safe group
and the rest. The parallel-safe group runs concurrently with `Promise.all`; the
remaining mutation calls run sequentially afterwards. The conservative default
matters here: a handler that does not opt in is treated as not safe to
parallelise and falls into the sequential group. You have to declare a tool safe;
the loop never assumes it.

The most important property of this design is what it deliberately does *not*
change. The loop pre-allocates result slots and yields results, and appends tool
messages, in the original input order regardless of which parallel call finished
first. The result is that the event trace and the next-turn prompt are
byte-for-byte identical to a sequential run. The only observable difference is
wall-clock. This is a strong and intentional contract: parallelism is purely a
performance optimisation that is invisible to the model and to any tooling that
reads the trace. The reason for going to that trouble is that an optimisation you
cannot turn on without changing behaviour is one you cannot trust; making
parallel dispatch observationally identical to serial dispatch means it can be
enabled without re-validating the agent's behaviour.

## Reflexion: a second look before settling

The plain loop trusts the model's final answer. The moment the model produces a
turn with no tool calls, that answer is returned. Most of the time that is fine.
But a model can produce a confident final answer that quietly contradicts a tool
result it saw earlier, and the plain loop has no way to catch it.

Reflexion is the opt-in pass that adds a critique-and-retry step after a
candidate final answer. When it is enabled, reaching a no-tool-call turn does not
end the loop immediately. Instead the loop issues one more chat call, this time
asking the model to critique its own most recent reply against the tool results
visible in the conversation, and to reply with a small JSON verdict of the shape
`{ ok: boolean, feedback?: string }`. If the verdict is `ok`, the answer stands
and the loop returns. If the verdict is not ok and retries remain, the loop
injects the feedback as a synthetic user message ("Reviewer feedback: ...") and
loops back into a fresh ReAct iteration so the model can revise. The retry budget
is bounded, defaulting to one, so reflexion cannot itself become a runaway loop.

The design choices around the failure cases are telling. Reflexion fails open: if
the critique call errors, or returns malformed JSON, or returns something without
a boolean `ok` field, the loop treats it as `ok` and returns the original answer.
The reasoning is that a self-critique is an enhancement, not a gate; a broken
critique must never block a completion the agent had otherwise reached. The same
caution applies to its absence. When reflexion is disabled, the loop does not
append the final assistant turn or issue any extra call, so its behaviour is
byte-for-byte identical to the pre-reflexion loop. As with parallel dispatch, the
optional behaviour is designed to be invisible when off.

The trade-off Reflexion makes is plain: it costs an extra model call per final
answer, and more when it triggers a retry, in exchange for catching answers that
drift from the evidence. That is worth it when correctness matters more than
latency or token cost, and not worth it when the task is cheap and the stakes are
low. It is off by default because most turns do not need a second opinion, and
the package's stance is to add cost only when you ask for it.

## Where to go from here

This page is about why the loop is shaped the way it is. To stand up a session
that runs it, follow
[Drive a session from your code](../tutorials/01-drive-a-session-from-code.md).
For the exact option shapes (`maxTurns`, `parallelDispatch`, the `ReflexionConfig`
fields), the `AgentStrategy` interface, and the event stream the loop yields, see
the [library reference](../reference/library.md). For how this loop relates to
inverse mode, where there is no loop at all, see
[Inference vs inverse](./inference-vs-inverse.md).
