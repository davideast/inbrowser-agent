# AGENTS.md — `@inbrowser/agent`

This file is for AI agents driving the `agent` CLI. Read it before
your first invocation. Invariants are listed first; rationale and
worked examples follow.

## Invariants (always-do)

1. **Pipe NDJSON.** The CLI auto-selects `--output ndjson` when stdout
   is not a TTY. Parse each line as a JSON object. Never grep prose.
2. **Use `--json -` for mutating commands** when the input contains
   anything non-trivial (newlines, JSON, long prompts). The raw
   payload maps 1:1 to the run signature — no flag translation loss.
3. **Use `--dry-run` first** when you're about to mutate state. `run`
   and `fleet` honor it; the response is a single `dry_run_plan`
   event you can inspect before re-invoking without the flag.
4. **Filter with `--fields`** when you only need a slice of each
   event. Example: `--fields ts,type,sessionId,ok,summary`. Saves
   tokens proportional to event payload size.
5. **Trust `--help --json` (or pipe to `cat`).** When stdout is not a
   TTY, `agent help <command>` emits a structured object. When it
   is, you get prose. The structure is the contract.
6. **Treat `session_end` as the source of truth.** Its `totals` field
   has the canonical cost / tokens summary; everything before it can
   be transient.

## Don't (anti-patterns)

- Don't parse text output. It's for humans. The TTY format is not
  versioned.
- Don't infer the schema from `--help`. Call `agent schema` or
  `agent describe` and cache the result.
- Don't write session ids by hand if you can let the CLI generate
  them. Generated ids are guaranteed to pass hardening.
- Don't pass paths with `..` or URL-encoded segments. The hardening
  layer rejects them and you'll burn a turn on the retry.

## Workflow patterns

### Run a single session, capture totals

```bash
agent run --json - <<'EOF'
{"prompt": "build a chess board", "scenario": "write-rules", "maxTurns": 4}
EOF
```

Or programmatically: take the last NDJSON line, parse it, and read
`totals.tokensTotal` and `totals.costUsd`.

### Discover the schema

```bash
agent schema                    # full CliSpec
agent describe --target events  # NDJSON event catalog only
```

The schema's `commands[*].options[*]` includes the same `validate`
rules the parser enforces — you can pre-validate inputs in your
agent before invoking.

### Validate without side effects

```bash
agent run --prompt "$PROMPT" --dry-run
agent fleet --size 10 --dry-run
```

Each emits exactly one `dry_run_plan` event.

### Run many sessions in parallel

```bash
agent fleet --size 10
```

The `fleet_summary` event at the end reports per-session totals plus
an `isolated` boolean. Treat `isolated: false` as a hard failure.

## Per-session logs

Every `run` writes its full event stream to:

```
~/.pyric/sessions/<sessionId>.ndjson
```

Last line is always `session_end` with totals. Tail with:

```bash
tail -1 ~/.pyric/sessions/<sessionId>.ndjson | jq '.totals'
```

Override with `--log-dir <abs-path>`. Disable with `--no-log`.

## Wrap on the producer, NOT on the consumer

**Critical invariant for anyone using `wrapMutating()` + `replayEvents()`.**

Wrap your handlers on the system that **produces** the log (the dev
environment, the agent session that generates mutations). Do NOT
wrap on the system that **consumes** the log via `replayEvents`. If
you do, each replayed event spawns its own plan+commit cascade on
the target log — and a subsequent replay run would try to re-replay
those, ad infinitum.

```
   DEV (producer)                         PROD (replay consumer)
   ──────────────                         ──────────────────────
   wrapMutating(setDoc, { log, ... })     setDoc                  ← bare!
                                          deleteDoc               ← bare!
```

`isWrappedHandler(handler)` returns `true` for any output of
`wrapMutating`. Use it to assert your prod registry is safe before
calling `replayEvents` against it.

## Non-JSON-safe types — use a codec

`wrapMutating` stores `args`, `before`, `after` in the log. The
default `JSON.stringify` is lossy for the exact types real Firebase
code uses (`Timestamp`, `FieldValue.serverTimestamp()`,
`DocumentReference`, `Date`, `Uint8Array`, `bigint`). Without a
codec, replay can silently write the wrong types to prod.

The shipped default `defaultEventValueCodec` handles the universal
non-JSON types — `Date`, `Uint8Array`, `bigint` — via tagged
envelopes. For Firestore-specific types, compose your own codec on
top using `walkValue`:

```ts
import { composeCodecs, defaultEventValueCodec, openEventLog, walkValue, type EventValueCodec, ENVELOPE_KEY } from '@inbrowser/agent';
import { Timestamp } from 'firebase-admin/firestore';

const firestoreCodec: EventValueCodec = {
  encode: (v) => walkValue(v, (n) => {
    if (n instanceof Timestamp) return { [ENVELOPE_KEY]: 'Timestamp', seconds: n.seconds, nanoseconds: n.nanoseconds };
    return undefined;
  }),
  decode: (v) => walkValue(v, (n) => {
    if (typeof n === 'object' && n !== null && (n as any).__pyric === 'Timestamp') {
      return new Timestamp((n as any).seconds, (n as any).nanoseconds);
    }
    return undefined;
  }),
};

const codec = composeCodecs(firestoreCodec, defaultEventValueCodec);
const log = openEventLog({ projectId: 'my-app', codec });
// Pass the same codec to `openEventLog` on the prod side so decode matches.
```

`identityCodec` is also available for tests / when args are known
JSON-clean (slightly cheaper since it skips the walk).

## Per-project event log (observability + undo)

Distinct from the per-session log above. Every **mutating tool** that
wraps itself in `wrapMutating()` from `@inbrowser/agent` emits one or more
events to:

```
~/.pyric/projects/<projectId>/events.ndjson
```

Each event has a stable id, a phase (`plan` | `commit` | `rollback`),
a target (`{kind, path}`), optional `before`/`after` snapshots, and —
when the API permits rollback — a `reverseOp` (`{tool, args}`) that
`agent undo` can invoke.

Read the log:

```bash
agent events --project my-app                                 # full log
agent events --project my-app --phase commit                  # just commits
agent events --project my-app --tool writeRules               # one tool
agent events --project my-app --session sess-2026-05-11-abc   # one session
agent events --project my-app --since 2026-05-11T00:00:00Z    # time range
```

Reverse a commit:

```bash
agent undo --project my-app --event <id> --dry-run            # show plan
agent undo --project my-app --event <id>                      # record rollback
```

Important:
- `agent undo` **does not invoke the reverse tool itself.** It records
  a `rollback` event referencing the original and surfaces the
  recorded `reverseOp`. Your host (the playground, a specialized-agent
  process) is responsible for dispatching the tool — the CLI is a
  controller surface, not a Firebase admin runtime.
- Events with `reversible: false` are rejected up front with the
  recorded `irreversibleReason`.
- Idempotent — undoing the same event twice returns `AlreadyUndone`
  (exit 64), never double-rolls.

## Forward replay (dev → prod migrations)

The same log that powers `agent undo` is a forward-replayable migration
record. Every `commit` event carries the original `args`, so a different
`ToolDispatch` can re-execute the same operations against a different
environment (typical case: `dev` simulator log → live Firestore).

CLI surface (planning only):

```bash
# Plan: list every replayable commit (NDJSON, one `migrate_plan` per event).
agent migrate --project my-app

# Filter: from a known anchor, restricted to specific tools.
agent migrate --project my-app --since-event <id> --tools setDoc,writeRules

# Record an intent marker the host can pick up.
agent migrate --project my-app --record
```

Host surface (actually replays):

```ts
import { openEventLog, replayEvents } from '@inbrowser/agent';

const log = openEventLog({ projectId: 'my-app' });           // dev log
const dispatch = buildProdToolDispatch();                     // your prod registry
for await (const ev of replayEvents({ log, dispatch, toolContext })) {
  if (ev.type === 'error') break;
}
```

Important:
- Same controller/runtime split as `agent undo`: the CLI does NOT
  invoke tools. It records intent + lists the plan; the host calls
  `replayEvents()` against its production registry.
- Idempotent across re-runs. Each successfully-applied event gets a
  `migrate_applied` marker; a re-run skips events whose marker is
  already present.
- Legacy events (no `args` field — emitted before the field was added)
  are skipped by default. Pass `legacyEventPolicy: 'abort'` to fail
  loudly instead.
- Reverse direction is `agent undo`; forward direction is `replayEvents()`.
  They share the same log.

## Exit codes

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| 0    | Success                                     |
| 1    | Runtime error (session-level)               |
| 2    | Unhandled exception (CLI bug — file a bug)  |
| 64   | Usage error or input hardening rejection    |

## Scoring (per agent-dx-cli-scale)

| Axis                                  | Score | Notes                                                                          |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------ |
| 1. Machine-Readable Output            | 3     | NDJSON streaming default in non-TTY; JSON errors; structured everywhere.       |
| 2. Raw Payload Input                  | 3     | `--json -` (stdin) or `--json <file>` for `run`; payload mirrors handler sig.  |
| 3. Schema Introspection               | 2     | `agent schema`, `agent describe`, `--help --json`. All commands covered.       |
| 4. Context Window Discipline          | 3     | `--fields` allowlist + per-event NDJSON streaming + `agent events` filters.    |
| 5. Input Hardening                    | 3     | Rejects control chars, `..`, `%2e`, `?`, `#`, oversized strings; path sandbox. |
| 6. Safety Rails                       | 3     | `--dry-run` on `run`/`fleet`/`undo`; idempotent undo + replay; irreversible-event gate. |
| 7. Agent Knowledge Packaging          | 2     | This file + `skills/agent-cli.md`. Versioned with the package.                 |
| **Total**                             | **19** | **Agent-first**                                                              |

The event log lifts the score on axes 4 and 6: it gives agents a
typed substrate to audit, reverse, and replay mutations without
re-scraping provider APIs. `agent migrate` extends the
controller/runtime split (CLI plans, host dispatches) that `agent undo`
established — same shape, opposite direction.
