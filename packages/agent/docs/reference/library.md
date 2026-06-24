# Library Reference

This page describes the public library surface of `@inbrowser/agent`. The
package exposes the root runtime plus optional import subpaths.

## Exports

| Import path | Surface |
| --- | --- |
| `@inbrowser/agent` | Browser-safe runtime: sessions, strategies, tool registry/dispatch, metrics, storage, LLM contract, events helpers (wrap/replay/codec). No `node:*` imports. |
| `@inbrowser/agent/node` | Node-only additions: the disk event-log writer and its helpers, the MCP client adapter, fixture loaders. |
| `@inbrowser/agent/sandbox` | Optional bridge that adapts `@inbrowser/sandbox` tools to the current agent tool contract. |
| `@inbrowser/agent/cli` | CLI internals (`main`, command handlers, `parseArgs`, `CLI_SPEC`). See [cli.md](./cli.md) for the command surface. |

---

# `@inbrowser/agent`

## Sessions

### `createAgentSession`

```ts
function createAgentSession(config: AgentSessionConfig): AgentSession;
```

Constructs a host-facing session container around an `AgentStrategy`. The
session owns the id, the workspace and runtime references, and translates the
strategy's `StrategyEvent` stream into the `SessionEvent` stream the host
consumes.

`AgentSessionConfig`:

| Field | Type | Description |
| --- | --- | --- |
| `strategy` | `AgentStrategy` | The pluggable inference algorithm. |
| `llm` | `ModelClient` | Model client used for chat calls. |
| `tools` | `ToolDispatch` | Dispatcher the strategy runs tool calls against. |
| `toolList` | `ToolHandler[]` | Tool declarations the LLM sees this turn. Empty disables function calling. |
| `toolContext` | `() => ToolContext` | Factory producing a fresh `ToolContext` per tool execution. |
| `systemPromptBuilder` | `(workspace: Workspace, runtime: RuntimeState) => string` | Builds the system prompt from live state. |
| `metrics` | `MetricsCollector` | Records per-turn usage and totals. |
| `history` | `ChatMessage[]` | Empty for fresh sessions; populated for resume. |
| `id` | `string` (optional) | Session id; one is generated when absent. |
| `tracer` | `Tracer` (optional) | Trace sink. Absent is a zero-cost no-op. |

`AgentSession`:

| Member | Type | Description |
| --- | --- | --- |
| `id` | `string` (readonly) | Session id. |
| `workspace` | `Workspace` (readonly) | Current frozen workspace. Updated as tool results patch it. |
| `runtime` | `RuntimeState` (readonly) | Current frozen runtime state. |
| `submit(prompt, signal)` | `(string, AbortSignal) => AsyncIterable<SessionEvent>` | Runs one prompt to completion. The iterable closes when the run is done. |
| `cancel()` | `() => void` | Cancels any in-flight `submit`. Safe to call when idle. |

```ts
const session = createAgentSession({
  strategy: createReactLoopStrategy(),
  llm,
  tools: createDispatch(registry),
  toolList: registry.list(),
  toolContext: () => ({ signal: controller.signal }),
  systemPromptBuilder: (ws, rt) => buildPrompt(ws, rt),
  metrics: createMetricsCollector(),
  history: [],
});

for await (const ev of session.submit('build a chess board', controller.signal)) {
  // ev: SessionEvent
}
```

`SessionEvent` variants are enumerated in [events.md](./events.md).

## Strategies

### `createReactLoopStrategy`

```ts
function createReactLoopStrategy(options?: ReactLoopOptions): AgentStrategy;
```

Returns the default `AgentStrategy` (`id: 'react-loop'`). Composes
`[system, ...history, user(prompt)]`, issues one chat call per iteration,
streams events through, dispatches any tool calls, and loops. Settles on a turn
that produces no tool calls.

`options` (the `ReactLoopOptions` shape is not exported as a named type):

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxTurns` | `number` | `24` | Cap on loop iterations. |
| `parallelDispatch` | `boolean` | `false` | When `true`, `parallelSafe` tool calls in one turn run concurrently; the rest run sequentially. Yield order, message order, and trace are identical to a sequential run. |
| `reflexion` | `ReflexionConfig` | absent | Opt-in critique-and-retry pass. See `ReflexionConfig`. |

When `maxTurns` is exceeded without settling, the strategy yields an `error`
event with message `react-loop: exceeded maxTurns (<n>) without settling`.

### `AgentStrategy`

```ts
interface AgentStrategy {
  readonly id: string;
  run(input: StrategyRunInput, signal: AbortSignal): AsyncIterable<StrategyEvent>;
}
```

The pluggable inference algorithm. `run` executes one prompt to completion and
returns the strategy's event stream; the session translates it into
`SessionEvent`s. `StrategyEvent` variants are enumerated in
[events.md](./events.md).

`StrategyRunInput`:

| Field | Type | Description |
| --- | --- | --- |
| `prompt` | `string` | The user prompt for this turn. |
| `history` | `ChatMessage[]` | Conversation history *before* this turn's prompt. The strategy appends `prompt` itself. |
| `workspace` | `Workspace` | Live workspace. |
| `runtime` | `RuntimeState` | Live runtime state. |
| `llm` | `ModelClient` | Model client. |
| `tools` | `ToolDispatch` | Dispatcher. |
| `toolList` | `ToolHandler[]` | Already filtered by active capabilities. |
| `toolContext` | `() => ToolContext` | Factory; called per tool execution. |
| `systemPrompt` | `string` | Pre-built by the session. |
| `tracer` | `Tracer` (optional) | Trace sink. Absent is a no-op. |
| `turnId` | `string` (optional) | Session-scoped id for trace labeling. |

### `ReflexionConfig`

```ts
interface ReflexionConfig {
  enabled: boolean;
  maxRetries?: number;
  critiqueSystemPrompt?: string;
}
```

Opt-in critique-and-retry pass after a candidate final-answer turn. When
`enabled`, the strategy issues a second chat call asking the model to evaluate
its own last reply against prior tool results and return a
`{ "ok": boolean, "feedback"?: string }` verdict.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | required | Opt-in switch. When `false` or absent, behavior is identical to the pre-reflexion loop. |
| `maxRetries` | `number` | `1` | Retries after a critique flags problems. `0` runs the critique and emits its verdict but never retries. |
| `critiqueSystemPrompt` | `string` | neutral default | System prompt for the critique call. |

A verdict of `ok: true` returns the original answer. A flagged verdict with
retry budget remaining injects the feedback as a synthetic user message and
loops. An exhausted budget returns the candidate answer as-is. A malformed or
non-JSON verdict is treated as `ok: true` (fail-open). At every critique
decision the strategy emits a `custom` `StrategyEvent` named
`reflexion_critique` carrying `{ verdict, text, feedback? }`, where `verdict`
is one of `'ok'`, `'retry'`, or `'exhausted'`.

## Tools

### `createToolRegistry`

```ts
function createToolRegistry(): ToolRegistry;
```

Returns an in-memory `ToolRegistry`.

`ToolRegistry`:

| Method | Signature | Description |
| --- | --- | --- |
| `register` | `(handler: ToolHandler) => void` | Adds a handler. **Throws** when `handler.name` is already registered. |
| `replace` | `(handler: ToolHandler) => void` | Idempotent. Registers fresh or replaces an existing handler of the same name. |
| `unregister` | `(name: string) => boolean` | Removes a handler. Returns whether one was removed. |
| `list` | `(opts?: { capabilities?: Capabilities }) => ToolHandler[]` | Returns registered handlers. With `capabilities`, drops handlers whose `available` hook returns `false`. |
| `has` | `(name: string) => boolean` | Whether a handler with this name is registered. |
| `fork` | `() => ToolRegistry` | Copy-on-write fork. Later registrations on the fork do not affect the parent. |

### `createDispatch`

```ts
function createDispatch(registry: ToolRegistry): ToolDispatch;
```

Returns a stateless `ToolDispatch` over a registry. The dispatcher holds a
reference to the registry; later `register`/`unregister` calls are seen on the
next `execute`.

`ToolDispatch`:

| Method | Signature | Description |
| --- | --- | --- |
| `execute` | `(call: ToolCall, ctx: ToolContext) => Promise<ToolResult>` | Looks up the handler by name and invokes it. |

An unknown tool name returns `{ ok: false, summary: "Unknown tool: <name>" }`.
A handler that throws returns `{ ok: false, summary: "Tool <name> threw: <message>" }`.

```ts
const registry = createToolRegistry();
registry.register(writeRulesHandler);
const dispatch = createDispatch(registry);
const result = await dispatch.execute(
  { id: 'c1', name: 'writeRules', args: { source: '...' } },
  { signal },
);
```

### `isParallelSafe`, `isPure`

```ts
function isParallelSafe(handler: ToolHandler): boolean;
function isPure(handler: ToolHandler): boolean;
```

Read `handler.parallelSafe` / `handler.pure` with the conservative default.
Both return `false` when the field is absent or `false`; callers opt in
explicitly. Centralised so all schedulers apply the same rule.

### `ToolHandler`

```ts
interface ToolHandler<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  available?(capabilities: Capabilities): boolean;
  parallelSafe?: boolean;
  pure?: boolean;
  execute(args: A, ctx: ToolContext): Promise<ToolResult<D>>;
}
```

| Field | Description |
| --- | --- |
| `name` | Unique tool name. |
| `description` | Human-readable summary surfaced to the model. |
| `parameters` | JSON Schema for the tool arguments. |
| `available` | Capability gate. Handler is excluded from `list()` when this returns `false`. |
| `parallelSafe` | When `true`, the dispatcher may run this tool concurrently with other parallel-safe tools in the same turn. Read via `isParallelSafe`. |
| `pure` | When `true`, repeat calls with the same args against the same workspace may be served from a content-addressed cache. Read via `isPure`. |
| `execute` | Runs the tool against `args` and a `ToolContext`. |

### `ToolContext`

```ts
interface ToolContext {
  signal: AbortSignal;
  workspace?: Workspace;
  runtime?: RuntimeState;
  sandbox?: SandboxHandle;
  lint?: LintFn;
  stitch?: StitchClient;
}
```

Session-scoped context handed to every `execute`. Only `signal` is required.

### `ToolResult`

```ts
interface ToolResult<D = unknown> {
  ok: boolean;
  summary: string;
  data?: D;
  workspacePatch?: Partial<Workspace>;
  runtimePatch?: Partial<RuntimeState>;
}
```

| Field | Description |
| --- | --- |
| `ok` | Whether the tool succeeded. |
| `summary` | One-line human-readable summary the model can quote back. |
| `data` | Structured payload. |
| `workspacePatch` | Patch the session applies to its workspace. |
| `runtimePatch` | Patch the session applies to its runtime state. |

### `ToolCall`

```ts
interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}
```

The dispatch input shape.

### `createMemoizedDispatch`

```ts
function createMemoizedDispatch(
  registry: ToolRegistry,
  options?: MemoOptions,
): MemoizedDispatch;
```

Builds a `ToolDispatch` over a registry with a content-addressed cache that
serves repeat calls to handlers tagged `pure`. The returned `MemoizedDispatch`
extends `ToolDispatch` with cache controls and exposes `MemoStats`. Related
types: `MemoKeyComponent`, `MemoOptions`, `MemoStats`.

## Model contract

The agent drives the model through `ModelClient` — the one model-call contract
for the stack, defined in `@inbrowser/model/contract` and re-exported from
`@inbrowser/agent`. The relay (transport) and the cloud providers speak the same
contract, so a client built for one works in the others.

### `ModelClient`

```ts
interface ModelClient {
  readonly id: string;
  readonly supportsTools: boolean;
  chat(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
```

The narrow model interface. The cloud providers in `@inbrowser/model`
(`geminiModelClient`, `openrouterModelClient`, `anthropicModelClient`,
`ollamaModelClient`, `claudeCliModelClient`, `claudeCodeModelClient`) are
factories returning one. The client knows about model calls and streamed events;
it knows nothing about BYOK forms, storage, model pickers, or pricing. `chat`
yields `ModelEvent`s, enumerated in [events.md](./events.md). `id` is a stable
metrics/provenance string such as `gemini:gemini-3.5-flash`.

### `ModelRequest`

```ts
interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolSpec[];
  toolUseEnabled: boolean;
  temperature?: number;
  topP?: number;
  topK?: number;
  reasoningEffort?: ReasoningEffort; // 'off' | 'low' | 'medium' | 'high'
}
```

| Field | Description |
| --- | --- |
| `messages` | The message array to send. |
| `tools` | Tool specs the model may invoke. Empty array means plain chat. |
| `toolUseEnabled` | Lighter than `tools.length === 0`; lets clients skip tool-mode encoding entirely. |
| `temperature`, `topP`, `topK`, `reasoningEffort` | Optional sampling / reasoning controls. |

### `ToolSpec`

```ts
interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}
```

A tool surfaced to the model in the OAI function-calling shape that modern chat
templates accept directly. `parameters` is a JSON Schema object. (The agent
builds these from its `ToolHandler` list.)

### `ModelMessage`

```ts
interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown; signature?: string }[];
  toolCallId?: string;
  name?: string;
  resultJson?: string;
}
```

One turn handed to the model. Assistant turns carry `toolCalls[]` (each with an
`id`); tool-result turns carry `toolCallId` (the call they answer), `name`, and
`resultJson`.

### `ModelUsage`

```ts
interface ModelUsage {
  promptTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}
```

Per-turn token usage, carried by the `usage` `ModelEvent`. Interpreted by
`MetricsCollector` to derive `TurnMetrics`. `costUsd`, when present, bypasses
pricing tables.

### `LlmConfig`

```ts
interface LlmConfig {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  isByok?: boolean;
}
```

Agent-local construction-time config for a `ModelClient`. Passed explicitly so
concurrent sessions can use different keys and models against the same provider.

### `LlmClientFactory`

```ts
interface LlmClientFactory {
  create(config: LlmConfig): ModelClient;
}
```

Agent-local factory shape that builds a `ModelClient` from an `LlmConfig`.

### `callbackProviderAsLlmClient`

```ts
function callbackProviderAsLlmClient(
  provider: CallbackProvider,
  id: string,
): ModelClient;
```

Adapts a callback-style `CallbackProvider` (one that drives turns via
`ProviderCallbacks`) into the streaming `ModelClient` interface. It buffers the
callbacks into a `ModelEvent` stream and emits the final `usage` event before
the iterable returns. Related types: `CallbackProvider`, `ProviderTurnResult`,
`ProviderCallbacks`, `ProviderChatMessage`, `ProviderToolDecl`, `ProviderUsage`,
`ProviderTurnDetails`.

## Metrics

### `createMetricsCollector`

```ts
function createMetricsCollector(): MetricsCollector;
```

Builds a stateful `MetricsCollector` for one session.

`MetricsCollector`:

| Method | Signature | Description |
| --- | --- | --- |
| `recordTurn` | `(input: RecordTurnInput) => TurnMetrics` | Stamps a turn completion and returns the typed metrics. Accumulates into totals. |
| `totals` | `() => SessionTotals` | Aggregate across every recorded turn. |
| `reset` | `() => void` | Resets the accumulated totals. |

`RecordTurnInput`:

| Field | Type | Description |
| --- | --- | --- |
| `llmId` | `string` | Model client id (the `ModelClient.id`). |
| `rawUsage` | `ModelUsage` | Provider-reported usage. |
| `model` | `string` | Model name (the pricing key with `llmId`). |
| `durationMs` | `number` | Turn wall-clock. |
| `isByok` | `boolean` (optional) | Whether the user supplied their own key. |

`SessionTotals` fields: `tokensTotal`, `tokensIn`, `tokensOut`, `tokensCached`,
`tokensReasoning`, `costUsdTotal`, `turnCount`.

### `computeTurnMetrics`

```ts
function computeTurnMetrics(input: RecordTurnInput): TurnMetrics;
```

Pure function deriving one turn's `TurnMetrics` from raw usage. When
`rawUsage.costUsd` is a number, it is trusted and `costEstimated` is `false`.
Otherwise cost is computed from the pricing table; an unpriced model yields
`costUsd: 0` with `costEstimated: true`.

### `findPricing`

```ts
function findPricing(llmId: string, model: string): PricingRow | undefined;
```

Looks up the per-`(provider, model)` pricing row keyed `${llmId}:${model}`.
Returns `undefined` when the model is unpriced.

## Storage

### `noopStorage`

```ts
const noopStorage: Storage;
```

A frozen no-op `Storage`. `get` returns `null`; `set`/`remove` are ignored;
`keys` returns `[]`. Useful for tests and the headless CLI default.

### `createMemoryStorage`

```ts
function createMemoryStorage(seed?: Record<string, string>): Storage;
```

In-memory `Storage` backed by a `Map`, optionally seeded.

### `createLocalStorageAdapter`

```ts
function createLocalStorageAdapter(): Storage;
```

Browser-only adapter over `globalThis.localStorage`. Errors (private browsing,
quota) are swallowed: `get` returns `null`, `set` is a no-op, the host does not
crash.

`Storage`:

| Method | Signature | Description |
| --- | --- | --- |
| `get` | `(key: string) => string \| null` | Read a value. |
| `set` | `(key: string, value: string) => void` | Write a value. |
| `remove` | `(key: string) => void` | Delete a value. |
| `keys` | `(prefix?: string) => string[]` | List keys, optionally by prefix. Implementations may degrade to `[]`. |

## Event utilities

These helpers are browser-safe and exported directly from the root entry. The
disk writer (`openEventLog`) and its value helpers live on
`@inbrowser/agent/node`.

### `wrapMutating`

```ts
function wrapMutating<A, D>(
  handler: ToolHandler<A, D>,
  opts: WrapMutatingOptions<A, D>,
): ToolHandler<A, D>;
```

Decorates a `ToolHandler` so every invocation appends `plan` + `commit` (or
`plan` + `rollback`) events to an event log. The wrapped handler is still a
regular `ToolHandler`. Wrap on the system that **produces** the log, never on
the system that consumes it via `replayEvents`.

`WrapMutatingOptions<A, D>`:

| Field | Type | Description |
| --- | --- | --- |
| `log` | `EventLog` | Where to append events. |
| `sessionId` | `string` | Session id stamped on every event. |
| `agent` | `string` (optional) | Emitting agent. Default `'host'`. |
| `target` | `(args, ctx) => MutationTarget` | Computes the `target` for plan and commit. |
| `snapshot` | `(args, ctx) => unknown` (optional) | Captures the `before` state. |
| `reverseOp` | `(args, result, ctx, before) => ReverseOp \| null` (optional) | Computes the reverse operation. Return `null` for irreversible mutations. |
| `reversibleByDefault` | `boolean` (optional) | Default reversibility when `reverseOp` is omitted. |
| `irreversibleReason` | `string` (optional) | Why the mutation is irreversible. |
| `metadata` | `Record<string, unknown>` (optional) | Static metadata stamped on every event. |

Failure semantics: a handler that throws appends a `rollback` event
(`reason: 'failure'`) and re-throws. A handler returning `{ ok: false }` still
appends a `commit` (the intent was reached; the audit log records the attempt).

### `isWrappedHandler`

```ts
function isWrappedHandler(handler: ToolHandler): boolean;
```

Returns `true` when `handler` was produced by `wrapMutating`. Used to assert a
replay target registers only unwrapped handlers.

### `WRAPPED_MARKER`

```ts
const WRAPPED_MARKER: unique symbol;
```

The non-enumerable marker symbol stamped on every `wrapMutating` output.

### `replayEvents`

```ts
function replayEvents(opts: ReplayOptions): AsyncIterable<ReplayProgress>;
```

Forward replay of an event log's `commit` events against a `ToolDispatch`, in
event-id order. Each applied event writes a `migrate_applied` marker so re-runs
skip already-applied events. The dispatch handlers must be unwrapped.

`ReplayOptions`:

| Field | Type | Description |
| --- | --- | --- |
| `log` | `EventLog` | Source log to read commits from. |
| `dispatch` | `ToolDispatch` | Dispatch to invoke each replayed tool against. Must register unwrapped handlers. |
| `toolContext` | `() => ToolContext` | Factory producing a fresh context per call. |
| `sinceEventId` | `string` (optional) | Replay only events with id `>=` this id (inclusive, lexical). |
| `toolAllowlist` | `readonly string[]` (optional) | Restrict to these tool names. |
| `pathDenyList` | `readonly string[]` (optional) | Skip events whose `target.path` matches. |
| `shouldApply` | `(event) => 'apply' \| 'skip' \| 'abort'` (optional) | Per-event resolver. Fires after the tool/path/already-applied filters. Default `'apply'`. |
| `dryRun` | `boolean` (optional) | Emit `plan` progress without calling dispatch; no markers written. |
| `targetLog` | `EventLog` (optional) | Separate log for the `migrate_applied` markers. Defaults to the source log. |
| `agent` | `string` (optional) | Agent stamped on markers. Default `'replay'`. |
| `sessionId` | `string` (optional) | Session id stamped on markers. Defaults to a synthesized id. |

`ReplayProgress` variants:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `plan` | `event` | Dry-run plan entry. |
| `applied` | `event`, `markerId`, `result` | Event applied; marker written. |
| `skipped` | `event`, `reason` | Skipped. `reason`: `already_applied` \| `tool_denied` \| `path_denied` \| `shouldapply_skip`. |
| `error` | `event`, `message` | Dispatch failed or returned `ok: false`. |
| `done` | `total`, `applied`, `skipped`, `errors` | Terminal summary. |

### `ReplayInvariantError`

```ts
class ReplayInvariantError extends Error {}
```

Thrown when a `commit`-phase event lacks `args` (commits written by
`wrapMutating` always carry args).

### Codec helpers

```ts
const defaultEventValueCodec: EventValueCodec;
const identityCodec: EventValueCodec;
function composeCodecs(outer: EventValueCodec, inner: EventValueCodec): EventValueCodec;
function walkValue(value: unknown, transform: (v: unknown) => unknown): unknown;
const ENVELOPE_KEY: '__pyric';
```

Round-trip non-JSON-safe values through the log.

| Symbol | Description |
| --- | --- |
| `defaultEventValueCodec` | Handles `Date`, `Uint8Array`, and `bigint` via tagged envelopes keyed `__pyric`. |
| `identityCodec` | Pass-through. Skips the value walk. |
| `composeCodecs` | Layers two codecs. `encode` runs the outer last on encode and the inner last on decode. |
| `walkValue` | Walks a value tree applying a per-node transform. Recurses into plain objects and arrays only; class instances are returned unchanged. |
| `ENVELOPE_KEY` | The `'__pyric'` envelope tag prefix. |

`EventValueCodec`:

```ts
interface EventValueCodec {
  encode(value: unknown): unknown;
  decode(value: unknown): unknown;
}
```

## Type-only exports

`@inbrowser/agent` re-exports many types consumed by hosts and adapters,
including: `Workspace`, `StitchContext`, `ProjectContext`, `RuntimeState`,
`TerminalEntry`, `RunSummary`, `DeployState`, `ChatMessage`, `ChatRole`,
`TurnMetrics`, `TurnDetails`, the model-contract types (`ModelClient`,
`ModelRequest`, `ModelEvent`, `ModelMessage`, `ModelUsage`, `ToolSpec`,
`ReasoningEffort`) re-exported from `@inbrowser/model/contract`, `Capabilities`,
`SandboxHandle`, `LintFn`, `LintWarning`, `StitchClient`, `Tracer`,
`TraceEvent`, `MutationEvent`, `MutationTarget`, `ReverseOp`, `TargetKind`,
`MutationPhase`, `EventLog`, `AppendDraft`, `AgentDefinition`, `AgentTool`,
`AgentContext`, `AgentToolResult`, `SandboxObserver`, `ObserverEvent`, the eval
harness types, and the skill catalog / router types.

Value exports beyond those documented above include: `EMPTY_WORKSPACE`,
`EMPTY_RUNTIME`, `DEFAULT_CAPABILITIES`, `combineObservers`, `noopObserver`,
`SKILL_CATALOG`, `getSkillEntry`, `listSkillNames`, `routeSkill`,
`createPlannerExecutorStrategy`, `defaultKeywordRouter`, `turnTimingTable`,
`analyzeTruthfulness`, and the eval harness functions (`runFixture`,
`runFixtures`, `collectMetrics`, `compareMetrics`, `createSpecRegistry`, and
related spec builders).

---

# `@inbrowser/agent/sandbox`

Optional bridge for hosts that use `@inbrowser/sandbox` as their project
runtime layer.

### `createSandboxAgentTools`

```ts
function createSandboxAgentTools(
  sandbox: Sandbox,
  options?: { names?: readonly string[] },
): SandboxAgentTools;
```

Returns an `AgentTools` object:

```ts
sandboxTools.list();
sandboxTools.execute(call, context);
```

The tool list and execution path are built from `sandbox.tools.list` and
`sandbox.tools.run`. Pass `names` to expose only selected sandbox tools to the
agent session. This adapter does not mutate a registry or attach agent state to
the sandbox.

---

# `@inbrowser/agent/node`

Node-only additions. The event-log writer imports `node:fs` / `node:os`, so it
ships here rather than on the browser-safe root entry.

### `openEventLog`

```ts
function openEventLog(opts: OpenEventLogOptions): EventLog;
```

Opens (creating as needed) the append-only NDJSON event log for a project at
`<logDir>/<projectId>/events.ndjson`. Throws when `projectId` contains
characters outside `[a-zA-Z0-9_.-]`.

`OpenEventLogOptions`:

| Field | Type | Description |
| --- | --- | --- |
| `projectId` | `string` | Firebase project id. Routes the log path. |
| `logDir` | `string` (optional) | Directory containing per-project subdirs. Defaults to `~/.pyric/projects`. |
| `io` | `EventLogIO` (optional) | Injectable fs primitives. Defaults to `node:fs`. |
| `now` | `() => number` (optional) | Injectable clock. Defaults to `Date.now`. |
| `codec` | `EventValueCodec` (optional) | Codec for `args` / `before` / `after`. Defaults to `defaultEventValueCodec`. |
| `maxEventBytes` | `number` (optional) | Per-event byte cap. Defaults to `DEFAULT_MAX_EVENT_BYTES`. Exceeding throws `EventTooLargeError`. |

`EventLog`:

| Member | Signature | Description |
| --- | --- | --- |
| `path` | `string` (readonly) | Absolute path to the NDJSON file. |
| `projectId` | `string` (readonly) | The project id. |
| `append` | `(draft: AppendDraft) => MutationEvent` | Appends one event. `id` and `ts` are auto-populated when absent. Returns the full event. |
| `read` | `(filter?: MutationEventFilter) => MutationEvent[]` | Reads all matching events. Malformed lines are skipped. |
| `appliedEventIds` | `() => Set<string>` | Ids already applied by `replayEvents` (referenced by a `migrate_applied` marker). |
| `close` | `() => void` | Releases resources. Idempotent. |

### `defaultProjectLogDir`

```ts
function defaultProjectLogDir(): string;
```

Returns `~/.pyric/projects` (the default events root).

### `generateEventId`

```ts
function generateEventId(now?: () => number, sequence?: number): string;
```

Produces a time-prefixed base36 id with an optional per-log sequence so two
appends in the same millisecond stay strictly sortable by emission order.

### `buildRollbackEvent`

```ts
function buildRollbackEvent(opts: {
  original: MutationEvent;
  reason: 'failure' | 'undo';
  reverseOp?: ReverseOp;
  agent: string;
  sessionId: string;
  now?: () => number;
}): AppendDraft;
```

Builds a `rollback`-phase `AppendDraft` referencing the original event. The
draft is always `reversible: false` (rollback events are terminal).

### `connectMcpTools`

```ts
function connectMcpTools(opts: McpConnectOptions): Promise<McpConnection>;
```

Connects to an external MCP server, lists its tools, and adapts each into a
`ToolHandler` the registry/dispatch can run. Resolves once the handshake and
`listTools` complete.

`McpConnectOptions` is one transport shape plus common options. Transports:

| Shape | Fields | Description |
| --- | --- | --- |
| HTTP | `url: string \| URL` | Streamable-HTTP MCP endpoint. |
| stdio | `command: string`, `args?: string[]`, `env?: Record<string, string>` | Spawn an MCP server over stdio. |
| injected | `transport: Transport` | Bring your own transport. |

Common options:

| Field | Type | Description |
| --- | --- | --- |
| `clientName` | `string` (optional) | Client identity in the handshake. Default `'inbrowser-agent'`. |
| `clientVersion` | `string` (optional) | Default `'0.0.0'`. |
| `namePrefix` | `string` (optional) | Prefix imported tool names; stripped before forwarding the call. |
| `include` | `(name: string) => boolean` (optional) | Keep only named tools (after prefixing). Default: all. |

`McpConnection`:

| Member | Signature | Description |
| --- | --- | --- |
| `tools` | `ToolHandler[]` | Imported tools, ready to `register`. |
| `client` | `Client` | The live MCP client. |
| `close` | `() => Promise<void>` | Disconnect the transport. |

### `EventTooLargeError`

```ts
class EventTooLargeError extends Error {
  readonly bytes: number;
  readonly cap: number;
  readonly tool: string;
}
```

Thrown by `append` when one serialized event exceeds the byte cap. Above the
cap, atomic append is not guaranteed and concurrent writers can interleave.

### `DEFAULT_MAX_EVENT_BYTES`

```ts
const DEFAULT_MAX_EVENT_BYTES: number; // 64 * 1024
```

The default per-event byte cap (64 KB).

### `HOST_AGENT_ID`

```ts
const HOST_AGENT_ID: 'host';
```

The agent identifier used in event records when the host did not name an agent.

### Fixture loaders

```ts
function loadFixture(...): ...;
function loadFixtures(...): ...;
class FixtureLoadError extends Error {}
```

Node-side eval fixture loaders that read from disk.

---

# `@inbrowser/agent/cli`

Programmatic access to the same surface the `agent` binary exposes. Use it when
embedding the CLI inside another process so argv parsing, hardening, and output
emission stay consistent.

Exports include: `main`, `runCommand`, `fleetCommand`, `describeCommand`,
`schemaCommand`, `helpCommand`, `versionCommand`, `parseArgs`, `UsageError`,
`InputHardeningError`, `createEmitter`, `errorEvent`, `pickMode`,
`hardenString`, `hardenPath`, `openSessionLog`, `defaultLogDir`, `scriptedLlm`,
`fakeSandbox`, `writeRulesTool`, `writeCodeTool`, `CLI_SPEC`, and `findCommand`.

The command surface (commands, flags, defaults, hardening rules) is documented
in [cli.md](./cli.md), derived from `CLI_SPEC`.
