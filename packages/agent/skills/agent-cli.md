---
name: agent-cli
description: Drive the `@inbrowser/agent` CLI to run headless agent sessions, fleets, and emit NDJSON event streams + per-session metrics.
version: 0.0.0
applies_to:
  - "@inbrowser/agent"
  - command: agent
---

# Skill: drive the `agent` CLI

This skill teaches an AI agent how to invoke `agent` correctly the
first time, without trial-and-error.

## Entry points

- `agent run` — single session. Use when you have one task to drive.
- `agent fleet` — N concurrent sessions. Use for stress / isolation
  testing or batch processing.
- `agent describe` — JSON description of commands, events, scenarios.
- `agent schema` — full CliSpec JSON.
- `agent help [command]` — structured help in non-TTY, prose in TTY.

## Step-by-step: run a single session

1. **Discover the schema once per session**:

   ```bash
   agent schema > /tmp/agent-schema.json
   ```

   Cache `commands[*].options` keyed by `name` — use that to drive
   your own argument validation.

2. **Build the payload as JSON**, not as flag args, for any input
   containing newlines, quotes, or > 100 chars:

   ```json
   {
     "prompt": "Refactor the workspace rules to be owner-only.",
     "scenario": "write-rules",
     "maxTurns": 4
   }
   ```

3. **Dry-run first**:

   ```bash
   echo "$PAYLOAD" | agent run --json - --dry-run
   ```

   The response is one event: `{"type":"dry_run_plan", "sessionId":..., ...}`.
   If the plan looks right, drop `--dry-run` and run for real.

4. **Stream the NDJSON**. Each line is a JSON event. Track:

   - `session_start` — record `sessionId` for log lookup
   - `tool_call` / `tool_result` — observe what the agent did
   - `turn_end` — per-turn metrics
   - `session_end` — TOTALS go here; this is the row to save

5. **Read totals from the log**, not from the stream tail — the log
   is durable:

   ```bash
   SESSION=$(jq -r 'select(.type=="session_start") | .sessionId' < stream.ndjson | head -1)
   tail -1 ~/.pyric/sessions/$SESSION.ndjson | jq '.totals'
   ```

## Step-by-step: run a fleet for isolation testing

```bash
agent fleet --size 10
```

The `fleet_summary` event is the row to inspect. If `isolated: false`,
the test failed — at least one session's workspace state leaked
across the boundary.

## Field filtering for token economy

If you only need to know whether tool calls succeeded, ask for less:

```bash
agent run --json - --fields ts,type,sessionId,callId,ok,summary < payload.json
```

You'll skip the chat chunks entirely.

## Input hardening cheat-sheet

The parser will reject (exit 64):

| Field type | Rejected if it contains                       |
| ---------- | --------------------------------------------- |
| any string | control chars (`\x00`–`\x1F`, `\x7F`)         |
| paths / ids | `..` segments, `%2e`, `?`, `#`               |
| oversized   | exceeding the option's `maxLength`            |
| ids         | not matching `^[a-zA-Z0-9_.-]+$` (session-id) |

To avoid retries, pre-validate against `option.validate` in the
schema before invoking.

## Event sourcing — audit + undo

Every tool wrapped in `wrapMutating()` (from the library surface)
emits typed events to `~/.pyric/projects/<projectId>/events.ndjson`.
The CLI surfaces them via two read-only and one mutating subcommand:

```bash
# Audit
agent events --project my-app                  # full log
agent events --project my-app --phase commit   # just the committed ones
agent events --project my-app --tool writeRules
agent events --project my-app --session sess-x
agent events --project my-app --since 2026-05-11T00:00Z --until 2026-05-12T00:00Z

# Undo (plan first, then commit)
agent undo --project my-app --event <id> --dry-run
agent undo --project my-app --event <id>
```

The undo flow records a `rollback` event in the log but **does not
invoke the reverse tool** — the host (your agent or playground)
reads the rollback event and dispatches the recorded `reverseOp.tool`
against its own `ToolDispatch`. The CLI is a controller surface; it
deliberately does not bundle a Firebase admin runtime.

Workflow when you're about to mutate something risky:

1. Run the tool normally (the wrapping is transparent — same args).
2. Find the resulting commit event id via `agent events --project …
   --tool X --phase commit | tail -1 | jq -r .id`.
3. If something looks wrong, `agent undo --project … --event <id>
   --dry-run` to see the reverse plan.
4. If the plan is right, drop `--dry-run`. Host picks up the rollback.

Event-specific anti-patterns:

- ✗ Don't manually edit the NDJSON log. It's append-only; readers
  treat unknown lines as corrupt and skip them.
- ✗ Don't reuse the same event id across calls. Generated ids are
  time-prefixed base36 and globally sortable; don't override.
- ✗ Don't expect `agent undo` to roll back service enablements,
  bucket creations, or other one-way operations. They emit with
  `reversible: false` and `agent undo` refuses up front.

## Forward replay (dev → prod migrations)

The same log that powers `agent undo` can replay forwards against a
production dispatch. Use case: agent explored a data shape against
the simulator locally; you want to apply those exact mutations to
live Firestore.

```bash
# Plan: what would replay?
agent migrate --project my-app

# Filter from an anchor + restrict tools.
agent migrate --project my-app --since-event <id> --tools setDoc,writeRules

# Record an intent marker the host's pipeline can pick up.
agent migrate --project my-app --record
```

The CLI does NOT run the tools (same controller/runtime split as
`agent undo`). The host calls `replayEvents()` from `@inbrowser/agent`:

```ts
import { openEventLog, replayEvents } from '@inbrowser/agent';

const log = openEventLog({ projectId: 'my-app' });
const dispatch = /* your prod ToolDispatch wired to live services */;

for await (const ev of replayEvents({ log, dispatch, toolContext })) {
  switch (ev.type) {
    case 'applied': /* event ev.event was re-executed in prod */ break;
    case 'skipped': /* ev.reason: already_applied | tool_denied | path_denied | legacy_no_args | conflict_skip */ break;
    case 'error':   /* ev.event + ev.message; loop continues to next */ break;
    case 'done':    /* ev.applied / skipped / errors totals */ break;
  }
}
```

Replay is idempotent. `replayEvents()` writes a `migrate_applied`
marker per success; re-runs skip already-marked events.

Workflow when migrating dev → prod:

1. **Plan locally:** `agent migrate --project dev | jq .tool | sort | uniq -c`
   tells you what tools and how many you're about to fire in prod.
2. **Optionally narrow:** filter by `--since-event` (only what's new
   since the last migration) or `--tools` (only the writes you trust).
3. **Record intent:** `agent migrate --project dev --record` writes a
   `migrate_intent` event with the planned ids. Audit log entry.
4. **Run replay in the host:** the deploy script / specialized agent
   invokes `replayEvents()` with its prod dispatch.
5. **Re-run if interrupted:** safe. Already-applied events are skipped.

Replay-specific anti-patterns:

- ✗ Don't replay against the SAME dispatch that emitted the events.
  You'd re-record everything (recursive) and double-mutate.
- ✗ Don't skip the `--record` step in CI/CD — the intent marker is
  the audit hook ("we did mean to apply this set on this day").
- ✗ Don't pass `legacyEventPolicy: 'abort'` unless you've audited the
  log first. A single pre-args-field event will halt the migration.

## Anti-patterns

- ✗ Parsing `agent run` text output to recover totals — instead read
  the last NDJSON line of the log file.
- ✗ Passing the prompt as a flag when it has quotes — use `--json -`.
- ✗ Using `--scenario echo` for tool flows — `echo` emits no tool
  calls. Use `write-rules` (or the host's real LLM when running
  inside the playground).
- ✗ Calling `run` repeatedly to "pre-warm" — each invocation is a
  fresh session with no shared state.
