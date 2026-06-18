# Event Reference

This page enumerates the three discriminated-union event streams in
`@inbrowser/agent`. Each is a typed `AsyncIterable` consumed at a different
layer.

| Stream | Discriminant | Source | Consumer |
| --- | --- | --- | --- |
| `SessionEvent` | `kind` | `AgentSession.submit(prompt, signal)` | The host. |
| `StrategyEvent` | `kind` | `AgentStrategy.run(input, signal)` | The session (translates into `SessionEvent`). |
| `ModelEvent` | `kind` | `ModelClient.chat(req, signal)` | The strategy. |

The flow is layered: `chat` yields `ModelEvent`s to the strategy, the strategy
yields `StrategyEvent`s to the session, and the session yields `SessionEvent`s
to the host. `ModelEvent` is the shared contract from
`@inbrowser/model/contract` (re-exported from `@inbrowser/agent`); the other two
streams are agent-internal types layered on top of it.

---

## `SessionEvent`

Yielded by `AgentSession.submit`. The session-owned `turnId` correlates events
within one turn.

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `turn_started` | `turnId: string` | A turn has begun. Emitted first. |
| `text` | `turnId: string`, `chunk: string` | A chunk of assistant output text. |
| `thinking` | `turnId: string`, `chunk: string` | A chunk of hidden reasoning text. |
| `tool_started` | `turnId: string`, `callId: string`, `name: string`, `args: unknown`, `signature?: string` | The model requested a tool call. |
| `tool_finished` | `turnId: string`, `callId: string`, `result: ToolResult` | A tool call completed. |
| `workspace_changed` | `workspace: Workspace` | A tool result patched the workspace. Emitted after the `tool_finished` that caused it. |
| `runtime_changed` | `runtime: RuntimeState` | A tool result patched the runtime state. |
| `turn_completed` | `turnId: string`, `metrics: TurnMetrics`, `details: TurnDetails` | The turn finished. Carries recorded metrics and turn details. |
| `error` | `turnId?: string`, `message: string` | The run failed. Terminates the stream. |
| `completed` | (none) | The run completed normally. Emitted last. |
| `strategy_event` | `name: string`, `data?: unknown` | A strategy-emitted milestone. Generic envelope (planner phases, branch expansions, reflexion critiques). |

Notes:

- A run ends with either `completed` (normal) or `error` (failure). After an
  `error`, no further events are yielded.
- `strategy_event` carries the `name` and `data` of a strategy's `custom`
  event. The ReAct strategy with reflexion enabled emits one named
  `reflexion_critique`.

---

## `StrategyEvent`

Yielded by `AgentStrategy.run`. The session maps each variant onto a
`SessionEvent`.

| `kind` | Fields | Maps to `SessionEvent` |
| --- | --- | --- |
| `text` | `chunk: string` | `text` |
| `thinking` | `chunk: string` | `thinking` |
| `tool_call` | `id: string`, `name: string`, `args: unknown`, `signature?: string` | `tool_started` |
| `tool_result` | `id: string`, `result: ToolResult` | `tool_finished` (plus `workspace_changed` / `runtime_changed` when the result carries patches) |
| `turn_complete` | `usage: ModelUsage`, `details: TurnDetails` | `turn_completed` (after the session records metrics from `usage`) |
| `error` | `message: string` | `error` (terminates the run) |
| `custom` | `name: string`, `data?: unknown` | `strategy_event` |

Notes:

- The session derives `turnId` and `callId` mappings: `tool_call.id` becomes
  `tool_started.callId`, and `tool_result.id` becomes `tool_finished.callId`.
- `turn_complete.usage` is the raw provider usage; the session passes it to the
  `MetricsCollector` and stamps the resulting `TurnMetrics` onto
  `turn_completed`.
- `custom` is the extension point: new strategies surface milestones without
  expanding the union. The ReAct strategy's reflexion pass emits
  `custom` events named `reflexion_critique` with a
  `{ verdict, text, feedback? }` payload, where `verdict` is `'ok'`,
  `'retry'`, or `'exhausted'`.

---

## `ModelEvent`

Yielded by `ModelClient.chat`. The provider-level stream the strategy consumes.
This is the shared contract from `@inbrowser/model/contract`, re-exported from
`@inbrowser/agent`.

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `text` | `text: string` | A chunk of assistant output text. |
| `thinking` | `text: string` | A chunk of hidden reasoning text. |
| `tool_call` | `id: string`, `name: string`, `args: unknown`, `signature?: string` | The model requested a tool call. |
| `usage` | `usage: ModelUsage` | Final per-turn accounting. Emitted once, just before the iterable returns. |
| `error` | `message: string` | The provider call failed. Terminal. |

`ModelUsage`:

| Field | Type | Description |
| --- | --- | --- |
| `promptTokens` | `number` | Input tokens. |
| `outputTokens` | `number` | Output tokens. |
| `cachedTokens` | `number` (optional) | Cache-hit input tokens. |
| `reasoningTokens` | `number` (optional) | Reasoning tokens. |
| `costUsd` | `number` (optional) | Provider-supplied cost; bypasses pricing tables when present. |

Notes:

- The turn ends when the async iterable returns; there is no `turn_complete`
  event. On a normal end a `usage` event is emitted before the return — it
  carries the final accounting. An `error` event is itself terminal: after it
  the iterable returns with no `usage` event. Consumers can rely on exactly one
  of {a `usage` event, an `error` event} per turn.
- `signature` carries a provider-specific token (for example a Gemini
  thoughtSignature) through round-trips. It is absent on providers that do not
  emit one.
- The strategy translates this stream into `StrategyEvent`s: `text`/`thinking`
  fragments are re-emitted (as `chunk`), and the `usage` event becomes the
  strategy's `turn_complete`, where the session synthesizes `TurnDetails`
  (`{ requestedModel }`) from the client `id` before recording metrics.

---

## Mutation events (distinct stream)

The three streams above are the in-process runtime event streams. They are
distinct from `MutationEvent`, the on-disk audit record a mutating tool emits
to a project's event log via `wrapMutating`. `MutationEvent` is documented with
the event-log surface in [library.md](./library.md); its three lifecycle
phases (`plan`, `commit`, `rollback`) are filterable by the
[`agent events`](./cli.md#events) command.
