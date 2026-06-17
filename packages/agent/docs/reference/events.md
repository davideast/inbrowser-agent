# Event Reference

This page enumerates the three discriminated-union event streams in
`@inbrowser/agent`. Each is a typed `AsyncIterable` consumed at a different
layer.

| Stream | Discriminant | Source | Consumer |
| --- | --- | --- | --- |
| `SessionEvent` | `kind` | `AgentSession.submit(prompt, signal)` | The host. |
| `StrategyEvent` | `kind` | `AgentStrategy.run(input, signal)` | The session (translates into `SessionEvent`). |
| `ChatEvent` | `kind` | `LlmClient.chat(req, signal)` | The strategy. |

The flow is layered: `chat` yields `ChatEvent`s to the strategy, the strategy
yields `StrategyEvent`s to the session, and the session yields `SessionEvent`s
to the host.

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
| `turn_complete` | `usage: RawUsage`, `details: TurnDetails` | `turn_completed` (after the session records metrics from `usage`) |
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

## `ChatEvent`

Yielded by `LlmClient.chat`. The provider-level stream the strategy consumes.

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `text` | `chunk: string` | A chunk of assistant output text. |
| `thinking` | `chunk: string` | A chunk of hidden reasoning text. |
| `tool_call` | `id: string`, `name: string`, `args: unknown`, `signature?: string` | The model requested a tool call. |
| `turn_complete` | `usage: RawUsage`, `details: TurnDetails` | The model's reply is complete. Carries token usage and turn details. |
| `error` | `message: string` | The provider call failed. |

`RawUsage`:

| Field | Type | Description |
| --- | --- | --- |
| `promptTokens` | `number` | Input tokens. |
| `completionTokens` | `number` | Output tokens. |
| `cachedTokens` | `number` (optional) | Cache-hit input tokens. |
| `reasoningTokens` | `number` (optional) | Reasoning tokens. |
| `costUsd` | `number` (optional) | Provider-supplied cost; bypasses pricing tables when present. |

`TurnDetails`:

| Field | Type | Description |
| --- | --- | --- |
| `requestedModel` | `string` | The model name the host requested. |
| `servedModel` | `string` (optional) | The model the provider actually served. |
| `fingerprint` | `string` (optional) | Provider-stable fingerprint when offered. |
| `routing` | `Record<string, unknown>` (optional) | Free-form provider routing info. |

Notes:

- `signature` carries a provider-specific token (for example a Gemini
  thoughtSignature) through round-trips. It is absent on providers that do not
  emit one.
- A well-behaved client emits a terminal `turn_complete` (or `error`). The
  strategy treats a stream that ends without `turn_complete` as a turn with no
  recorded usage.

---

## Mutation events (distinct stream)

The three streams above are the in-process runtime event streams. They are
distinct from `MutationEvent`, the on-disk audit record a mutating tool emits
to a project's event log via `wrapMutating`. `MutationEvent` is documented with
the event-log surface in [library.md](./library.md); its three lifecycle
phases (`plan`, `commit`, `rollback`) are filterable by the
[`agent events`](./cli.md#events) command.
