# Tutorial: Run The Agent CLI

In this tutorial we will drive the `agent` binary from the command line. We will
discover its schema, run a scripted scenario that calls a tool, read the NDJSON
event stream it emits, and find the durable session log it leaves on disk.

Every command here uses a built-in scripted scenario, so nothing in this lesson
needs an API key or a network connection. It runs the same way every time.

## 1. Install The Package

Install `@inbrowser/agent` so the `agent` binary lands in your project's
`node_modules/.bin/`:

```bash
bun add @inbrowser/agent
```

Confirm the binary is available:

```bash
bunx agent version
```

You will see a short version string printed. If you prefer npm, the binary works
the same way after `npm install @inbrowser/agent`.

## 2. Discover The Schema

Before running a session, we will ask the CLI what it can do. The CLI is built
to be machine-readable: `agent schema` prints the full command-and-option
schema as JSON. We do not parse `--help`; we read the schema.

```bash
bunx agent schema > /tmp/agent-schema.json
```

Open the file, or pull out the command names to see the shape:

```bash
bunx agent describe --target commands
```

You will see entries for `run`, `fleet`, `serve`, and the rest, each with its
options and validation rules. This is the contract your scripts can rely on.

## 3. Run A Scripted Session

Now we will run a real session. The `write-rules` scenario is a scripted LLM
that calls a tool on its first turn, then writes a reply on its second. We pass
`--output ndjson` so each event prints as one JSON line:

```bash
bunx agent run "tighten the rules" --scenario write-rules --output ndjson
```

You will see a stream of NDJSON, one event per line, something like this:

```text
{"type":"session_start","sessionId":"sess-...","scenario":"write-rules","maxTurns":8}
{"type":"turn_start","sessionId":"sess-...","turn":"t-..."}
{"type":"thinking","sessionId":"sess-...","chunk":"Planning a minimal owner-only rule.\n"}
{"type":"tool_call","sessionId":"sess-...","name":"writeRules", ...}
{"type":"tool_result","sessionId":"sess-...","ok":true,"summary":"wrote ... chars of rules"}
{"type":"turn_end","sessionId":"sess-...", ...}
{"type":"text","sessionId":"sess-...","chunk":"Rules deployed. ..."}
{"type":"session_end","sessionId":"sess-...","totals":{...},"logPath":"..."}
```

Notice the arc of the run: `session_start`, then a turn that produces a
`tool_call` and its `tool_result`, then a final turn of `text`, and finally
`session_end`. The `session_end` line carries the totals and the path to the
durable log.

> When you run `agent run` directly in a terminal (a TTY) without `--output
> ndjson`, you get human-readable text instead. We asked for NDJSON here because
> that is the format scripts consume.

## 4. Plan Before You Run

The CLI can validate a run without invoking the LLM or any tools. Add
`--dry-run` to see the plan:

```bash
bunx agent run "tighten the rules" --scenario write-rules --dry-run --output ndjson
```

You will get a single event:

```text
{"type":"dry_run_plan","command":"run","sessionId":"sess-...","scenario":"write-rules","maxTurns":8,"logPath":"~/.pyric/sessions/sess-....ndjson"}
```

Notice the `logPath`: it tells you exactly where the real run will write its log
before you commit to running it.

## 5. Feed A JSON Payload On Stdin

For prompts with quotes, newlines, or extra fields, pass the whole payload as
JSON on stdin with `--json -`. This maps one-to-one to the run handler, so
nothing is lost in flag translation:

```bash
echo '{"prompt":"reset the rules","scenario":"write-rules","maxTurns":4}' \
  | bunx agent run --json -
```

You will see the same NDJSON stream as before, but driven entirely by the JSON
payload. The `maxTurns` field caps the loop at four turns.

## 6. Find The Session Log

Every run writes a durable NDJSON log under `~/.pyric/sessions/`, named for the
session id. This is the record to read from, because the stream you saw in the
terminal is ephemeral but the log file is not.

First, capture a run's stream and pull out its session id:

```bash
bunx agent run "tighten the rules" --scenario write-rules --output ndjson > /tmp/stream.ndjson
SESSION=$(grep '"type":"session_start"' /tmp/stream.ndjson | head -1 | sed -E 's/.*"sessionId":"([^"]+)".*/\1/')
echo "session: $SESSION"
```

Now read the totals straight from the last line of the durable log:

```bash
tail -1 ~/.pyric/sessions/$SESSION.ndjson
```

You will see the final `session_end` event, with the per-session token totals
and cost. This is the row to save when you are recording results: read it from
the log file, never by scraping the terminal output.

## What You Built

You installed the `agent` binary, discovered its schema without parsing help
text, ran a scripted scenario that called a tool, planned a run with
`--dry-run`, fed a JSON payload over stdin, and read durable totals from the
session log. This is the full single-session loop the CLI is built for.

Run `bunx agent fleet --size 5` to see the same machinery launch five isolated
sessions at once, with a summary at the end.

## Next

- To capture, filter, and roll back what a session changed, see
  [Audit and undo with the event log](../how-to/inspect-and-undo-with-the-event-log.md).
- For every command, flag, and NDJSON event type, see the
  [CLI reference](../reference/cli.md).
