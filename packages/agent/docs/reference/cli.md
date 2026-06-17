# CLI Reference

This page describes the `agent` binary. It is derived from `CLI_SPEC`
(`@inbrowser/agent/cli`), the single source of truth the parser and the
`agent schema` / `agent describe` commands surface verbatim.

## Binary

```text
agent <command> [options] [positional]
```

`agent` is a headless runner for `@inbrowser/agent` sessions. Output defaults
to NDJSON in non-TTY contexts and to text on a TTY.

## Global options

These apply to every command.

| Option | Short | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `--output` | `-o` | enum | ndjson (non-TTY), text (TTY) | Output format. Choices: `ndjson`, `json`, `text`. Use `ndjson` for streaming agent consumption. |
| `--fields` | | string[] | | Comma-separated event field allowlist. Applies only to `ndjson`/`json` output. Example: `--fields ts,type,turn,name,ok`. Max length 512; control chars rejected. |
| `--no-color` | | boolean | | Disable ANSI colors in text output. Auto-disabled when not a TTY. |
| `--help` | `-h` | boolean | | Show help for the (sub)command. Combine with `--output json` (or pipe to non-TTY) for the machine-readable schema. |

## Commands

| Command | Mutating | Description |
| --- | --- | --- |
| `run` | yes | Run a single agent session against a scripted LLM and a fake sandbox. |
| `fleet` | yes | Launch N concurrent agent sessions for isolation testing. |
| `serve` | yes | Inverse-mode MCP server exposing AgentDefinition tools over stdio. |
| `events` | no | Stream the per-project mutation event log. |
| `undo` | yes | Reverse a committed mutation by invoking its recorded reverseOp. |
| `describe` | no | Emit machine-readable descriptions of CLI subjects. |
| `schema` | no | Dump the full CLI command-and-option schema as JSON. |
| `migrate` | yes | Plan the forward replay of a project event log against a production dispatch. |
| `version` | no | Print the package version. |
| `help` | no | Show top-level help. |

---

### `run`

Run a single agent session against a scripted LLM and a fake sandbox.

Positional: `prompt` - free-form prompt text, equivalent to `--prompt`. Ignored
when `--json` is supplied.

| Option | Short | Type | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `--prompt` | `-p` | string | | reject control chars; max 8192 | User prompt. Required unless `--json` is provided. |
| `--json` | | json | | | Read the full run payload as JSON from stdin (`-` or no value) or from a file path. Schema: `{ prompt, scenario?, maxTurns?, sessionId?, history? }`. |
| `--scenario` | | enum | `echo` | choices: `echo`, `write-rules`; reject control chars, path traversal, query chars; max 64 | Scripted LLM fixture in headless mode. `echo` echoes the prompt; `write-rules` emits a tool_call then text. |
| `--max-turns` | | number | `8` | 1–64 | Hard cap on agent turn count. |
| `--session-id` | | string | | reject control chars, path traversal, query chars; max 64; pattern `^[a-zA-Z0-9_.-]+$` | Override the auto-generated session id. Used as the session log basename. |
| `--log-dir` | | path | `~/.pyric/sessions/` | reject control chars, query chars; max 1024 | Directory for the auto session log file. Each run writes `<log-dir>/<sessionId>.ndjson`. |
| `--no-log` | | boolean | | | Disable auto session log file writing. Stdout output is unaffected. |
| `--dry-run` | | boolean | | | Validate inputs and emit a single plan event without invoking the LLM or running tools. |
| `--llm` | | enum | `auto` | choices: `auto`, `scripted`, `openrouter` | LLM backend. `scripted` uses the fixture LLM; `openrouter` requires `OPENROUTER_API_KEY`; `auto` picks openrouter when the key is set, otherwise scripted. |
| `--model` | | string | | reject control chars, query chars; max 128 | OpenRouter model id. Ignored for `--llm scripted`. Falls back to `OPENROUTER_MODEL`, then `z-ai/glm-4.6`. |
| `--reasoning` | | enum | | choices: `off`, `low`, `medium`, `high` | Forward extended-thinking budget to models that support it. Off by default. |
| `--no-tui` | | boolean | | | Disable the OpenTUI run view even on a TTY. Falls back to the per-event prose emitter. |

---

### `fleet`

Launch N concurrent agent sessions for isolation testing.

| Option | Short | Type | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `--size` | `-n` | number | `3` | 1–64 | Number of concurrent sessions to launch. |
| `--scenario` | | enum | `write-rules` | choices: `write-rules` | Scripted scenario each fleet member runs. |
| `--log-dir` | | path | `~/.pyric/sessions/` | reject control chars, query chars; max 1024 | Directory for per-session log files. |
| `--no-log` | | boolean | | | Disable auto session log file writing. |
| `--dry-run` | | boolean | | | Print the planned fleet (size, member ids, scenario) without launching sessions. |

---

### `serve`

Inverse-mode MCP server. Exposes the named AgentDefinition(s) over stdio MCP so
an external host (Claude Code, Claude Desktop, Cursor) can call their
behavior-named tools. The process holds stdin/stdout for the transport; do not
pipe through it.

| Option | Short | Type | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `--project` | `-p` | string | | required; reject control chars, path traversal, query chars; max 64; pattern `^[a-zA-Z0-9_.-]+$` | Firebase project id. Routes the event log + run log to `~/.pyric/projects/<project>/`. |
| `--events-dir` | | path | `~/.pyric/projects` | reject control chars, query chars; max 1024 | Override the events + runs root. |
| `--dry-run` | | boolean | | | Print the catalog (agent + tool list) without binding stdio. Exit 0. |

---

### `events`

Stream the per-project mutation event log
(`~/.pyric/projects/<project>/events.ndjson`). Each event is one NDJSON line.
Supports filtering by session, tool, agent, phase, and time.

| Option | Short | Type | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `--project` | `-p` | string | | required; reject control chars, path traversal, query chars; max 64; pattern `^[a-zA-Z0-9_.-]+$` | Firebase project id. The log lives at `<events-dir>/<project>/events.ndjson`. |
| `--events-dir` | | path | `~/.pyric/projects` | reject control chars, query chars; max 1024 | Override the events root. |
| `--session` | | string | | reject control chars, path traversal, query chars; max 64 | Restrict to events from a single agent session. |
| `--tool` | | string | | reject control chars, query chars; max 64 | Restrict to events from one tool name. |
| `--agent` | | string | | reject control chars, query chars; max 64 | Restrict to events emitted by a single agent. Default emitter is `host`. |
| `--phase` | | enum | | choices: `plan`, `commit`, `rollback` | Restrict to one lifecycle phase. |
| `--since` | | string | | reject control chars; max 40 | ISO-8601 lower bound (inclusive). |
| `--until` | | string | | reject control chars; max 40 | ISO-8601 upper bound (exclusive). |
| `--include-bookkeeping` | | boolean | | | Include bookkeeping markers (`migrate_applied`, `migrate_intent`). Hidden by default. |

---

### `undo`

Reverse a previously-committed mutation by invoking its recorded reverseOp.
Refuses on `reversible: false` events. `--dry-run` shows the plan.

| Option | Short | Type | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `--project` | `-p` | string | | required; reject control chars, path traversal, query chars; max 64; pattern `^[a-zA-Z0-9_.-]+$` | Firebase project id whose log holds the event. |
| `--event` | `-e` | string | | required; reject control chars, query chars; max 64 | Event id to undo. Must reference a `commit`-phase event with `reversible: true`. |
| `--events-dir` | | path | `~/.pyric/projects` | reject control chars, query chars; max 1024 | Override the events root. |
| `--dry-run` | | boolean | | | Show the rollback plan (target, reverseOp tool+args, irreversible-flag check) without invoking the reverse op. |

---

### `describe`

Emit machine-readable descriptions of CLI subjects (commands, scenarios,
events).

| Option | Short | Type | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `--target` | `-t` | enum | `all` | choices: `commands`, `scenarios`, `events`, `all` | Which subject to describe. `commands`: subcommand tree. `scenarios`: scripted LLM fixtures. `events`: NDJSON event types. `all`: a single combined object. |

---

### `schema`

Dump the full CLI command-and-option schema as JSON. No options. The output is
a stable contract for agent integrations.

---

### `migrate`

Plan the forward replay of a project event log against a production dispatch.
The CLI emits one `migrate_plan` per replayable commit; `--record` appends a
`migrate_intent` marker for host pickup. The CLI does not invoke tools; call
`replayEvents()` from `@inbrowser/agent` against a production registry. Marked
mutating because `--record` appends to the log; without `--record` the command
is pure plan-only.

| Option | Short | Type | Default | Constraints | Description |
| --- | --- | --- | --- | --- | --- |
| `--project` | `-p` | string | | required; reject control chars, path traversal, query chars; max 64; pattern `^[a-zA-Z0-9_.-]+$` | Firebase project id whose log holds the events to replay. |
| `--events-dir` | | path | `~/.pyric/projects` | reject control chars, query chars; max 1024 | Override the events root. |
| `--since-event` | | string | | reject control chars, query chars; max 64 | Replay only events with id `>=` this id. |
| `--tools` | | string[] | | reject control chars; max 512 | Comma-separated tool allowlist. Only events for these tools are planned. |
| `--record` | | boolean | | | Append a `migrate_intent` event to the log for host pickup. Without it, the command is a pure plan. |

---

### `version`

Print the package version. No options.

---

### `help`

Show top-level help. Add a subcommand name to scope it. No options.

## Input hardening

String and path options carry validation rules enforced by the parser. A
rejected input throws `InputHardeningError`; the CLI emits
`{ type: "error", code: "INPUT_HARDENED", field, reason }` as a single NDJSON
event and exits with code 64 (`EX_USAGE`).

| Rule | Effect |
| --- | --- |
| reject control chars | Rejects values matching `[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`. |
| reject path traversal | Rejects `../` (or `..\`) segments and percent-encoded dots (`%2e`). |
| reject query chars | Rejects URL query/fragment characters (`?`, `#`). |
| max length | Rejects values longer than the field's `maxLength`. |
| pattern | Rejects values not matching the field's regular expression. |

Path options additionally resolve to an absolute path: an absolute input is
returned as-is, a relative input is joined onto the current working directory.
Control-char rejection defaults to on for path options.
