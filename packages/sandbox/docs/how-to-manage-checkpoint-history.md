# How to manage checkpoint history

Use checkpoint history when an agent edits a workspace in multiple steps and you
need a practical way to connect file-system state back to turns, messages, and
tool calls.

This guide assumes you already have a `Sandbox`. If you are wiring a sandbox
into an agent session, start with [How to wire a sandbox into an agent](./how-to-wire-an-agent.md).

## Create checkpoints with timeline metadata

Create checkpoints at the boundaries your app may need to inspect or restore.
For an agent builder, the most useful boundaries are usually before a turn,
before a mutating tool, and after a turn:

```ts
const beforeTool = await sandbox.checkpoints.create({
  label: 'before editing App.tsx',
  reason: 'before-tool',
  turnId: 'turn-42',
  messageId: 'assistant-42',
  toolCallId: 'call-write-app',
  summary: 'Before replacing the app shell',
  metadata: {
    path: '/work/src/App.tsx',
  },
});
```

The metadata does not change restore behaviour. It gives your UI and event log a
stable way to answer questions such as "which checkpoint belongs to this tool
row?" or "what was the latest checkpoint before this turn finished?"

## Restore the sandbox to a checkpoint

Restore mutates the sandbox file system. By default it emits a
`checkpoint:restore` event so a transcript, run log, or detail inspector can show
what happened:

```ts
await sandbox.checkpoints.restore(beforeTool.id);
```

If you are restoring internally while replaying or recovering state, suppress the
event and emit your own higher-level event instead:

```ts
await sandbox.checkpoints.restore(beforeTool.id, {
  recordEvent: false,
});
```

The current restore mode is `replace-current`: the checkpoint snapshot replaces
the current sandbox root.

## Find the checkpoint you need

Use `history()` when you are rendering a timeline-oriented list. Use `latest()`
when you need a restore target for a specific turn or tool:

```ts
const turnCheckpoints = sandbox.checkpoints.history({
  turnId: 'turn-42',
});

const latestBeforeTool = sandbox.checkpoints.latest({
  turnId: 'turn-42',
  reason: 'before-tool',
});
```

`list()` accepts the same filters and is equivalent when you are not emphasising
timeline semantics.

## Keep automatic checkpoints bounded

Automatic checkpoints can accumulate quickly during long sessions. Keep the
latest useful records and prune the rest:

```ts
sandbox.checkpoints.prune({
  reason: 'before-tool',
  keepLatest: 20,
});
```

When checkpoints are removed, the sandbox emits `checkpoint:prune` with the
removed records. Use that event to update any in-memory inspector state.

## Choose checkpoint reasons consistently

Use a small set of reasons so filters stay predictable:

| Reason | When to use it |
| --- | --- |
| `manual` | A user explicitly asks to save a checkpoint. |
| `before-turn` | Before an agent turn starts. |
| `before-tool` | Before a mutating tool runs. |
| `after-turn` | After an agent turn completes cleanly. |
| `restore` | When recording a checkpoint that represents a restore operation. |

The reason is not an access-control mechanism. It is timeline metadata. Your app
can add stricter policy in `metadata` or in the code that decides when to call
`restore()`.
