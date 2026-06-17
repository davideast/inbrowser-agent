# How to inspect and undo with the event log

This guide shows you how to audit what an agent did to a project and reverse a
mutating commit, using the `agent` CLI against the per-project event log.

Every tool wrapped with `wrapMutating()` emits `plan` and `commit` (or
`rollback`) events to an append-only log at
`~/.pyric/projects/<projectId>/events.ndjson`. The `events` command reads it;
the `undo` command reverses a commit. For the full event shape and every CLI
flag, see the [event-log reference](../reference/library.md) and the
[CLI reference](../reference/cli.md).

## Inspect what changed

Read the whole log for a project as NDJSON:

```bash
agent events --project my-app
```

Each line is one `MutationEvent`. Narrow the query to answer a specific
question:

- If you only care about completed mutations, filter by phase:

  ```bash
  agent events --project my-app --phase commit
  ```

- If you are auditing one tool or one session, filter by it:

  ```bash
  agent events --project my-app --tool writeRules
  agent events --project my-app --session sess-123
  ```

- If you are scoping to a time window, pass an ISO-8601 range (`--since` is
  inclusive, `--until` exclusive):

  ```bash
  agent events --project my-app \
    --since 2026-05-11T00:00:00Z --until 2026-05-12T00:00:00Z
  ```

Filters combine, so `--phase commit --tool writeRules` returns just the
committed `writeRules` events.

## Find the event to undo

`undo` needs the id of a `commit`-phase event that carries `reversible: true`.
Pull the most recent committed event for a tool and read its id:

```bash
agent events --project my-app --tool writeRules --phase commit | tail -1 | jq -r .id
```

## Plan the rollback before committing

Always dry-run first. This prints the reverse plan - the target, the recorded
`reverseOp` tool and args, and the irreversible-flag check - without invoking
anything:

```bash
agent undo --project my-app --event <id> --dry-run
```

If the plan reverses what you intended, drop `--dry-run`:

```bash
agent undo --project my-app --event <id>
```

This appends a `rollback` event to the log. Note the controller/runtime split:
the CLI records the rollback but does **not** invoke the reverse tool itself.
The host (your agent or the playground) reads the rollback event and dispatches
the recorded `reverseOp.tool` against its own `ToolDispatch`. The reverse tool
must be registered in that dispatch, or undo cannot resolve it.

If the event is irreversible (`reversible: false` - for example a service
enablement or bucket creation), `undo` refuses up front. Those operations are
one-way and have no reverse op to record.

## Note: writing the log from a library host

The CLI reads and appends to a log that a host produces. If you are building the
host, open the log and write through `wrapMutating()` (from `@inbrowser/agent`)
so plan and commit events are emitted around each mutating tool. The Node-only
writer and the rollback/id helpers live in `@inbrowser/agent/node`:

```ts
import {
  openEventLog,
  buildRollbackEvent,
  generateEventId,
} from '@inbrowser/agent/node';

const log = openEventLog({ projectId: 'my-app' });
```

Wrap the producer's handlers, not the consumer's - wrapping a replay target
spawns runaway plan/commit cascades. For `wrapMutating()`, the `MutationEvent`
fields, and `buildRollbackEvent` options, see the
[event-log reference](../reference/library.md).
