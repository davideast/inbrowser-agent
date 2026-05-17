/**
 * Single source of truth for the CLI command schema. Used for:
 *
 *   - Runtime arg parsing (`parse.ts` consults this for option types
 *     and required-ness).
 *   - Schema introspection (`agent describe`, `agent schema`,
 *     `--help --json` all surface this verbatim).
 *   - Per-axis guarantees in the Agent DX CLI scale rubric:
 *       axis 3 (schema introspection): every command + option is here.
 *       axis 5 (input hardening): `validate` records the rules the
 *         parser must enforce.
 *       axis 6 (safety rails): the `mutating` flag marks where
 *         `--dry-run` MUST be honored.
 */

export type OptionType = 'string' | 'number' | 'boolean' | 'string[]' | 'enum' | 'json' | 'path';

export interface OptionSpec {
  name: string;
  short?: string;
  type: OptionType;
  description: string;
  default?: string | number | boolean | null;
  required?: boolean;
  /** For type === 'enum' */
  choices?: readonly string[];
  /** Hardening rules for type === 'string' | 'path' */
  validate?: {
    rejectControlChars?: boolean;
    rejectPathTraversal?: boolean;
    rejectQueryChars?: boolean;
    maxLength?: number;
    pattern?: string;
  };
  /** When true, supplying this option is destructive — covered by --dry-run. */
  mutating?: boolean;
}

export interface CommandSpec {
  name: string;
  description: string;
  /** Whether this command can change side-effects (writes session log, runs LLM, etc). */
  mutating: boolean;
  options: readonly OptionSpec[];
  /** Free-form positional after options; documented but not destructured. */
  positional?: { name: string; description: string };
  examples?: readonly { input: string; description: string }[];
}

export interface CliSpec {
  name: string;
  version: string;
  description: string;
  /** Global options that apply to every subcommand. */
  globalOptions: readonly OptionSpec[];
  commands: readonly CommandSpec[];
}

const OUTPUT_FORMATS = ['ndjson', 'json', 'text'] as const;

const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--output',
    short: '-o',
    type: 'enum',
    choices: OUTPUT_FORMATS,
    description:
      'Output format. Default: ndjson when stdout is not a TTY, text when it is. ' +
      'Use ndjson for streaming agent consumption.',
  },
  {
    name: '--fields',
    type: 'string[]',
    description:
      'Comma-separated event field allowlist. Applies only to ndjson/json output. ' +
      'Example: --fields ts,type,turn,name,ok',
    validate: { rejectControlChars: true, maxLength: 512 },
  },
  {
    name: '--no-color',
    type: 'boolean',
    description: 'Disable ANSI colors in text output. Auto-disabled when not a TTY.',
  },
  {
    name: '--help',
    short: '-h',
    type: 'boolean',
    description:
      'Show help for the (sub)command. Combine with --output json (or pipe to non-TTY) ' +
      'to receive the machine-readable schema.',
  },
];

const RUN_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--prompt',
    short: '-p',
    type: 'string',
    description: 'User prompt for the session. Required unless --json is provided.',
    validate: { rejectControlChars: true, maxLength: 8192 },
  },
  {
    name: '--json',
    type: 'json',
    description:
      'Read full run payload as JSON from stdin (- or no value) or from the given file ' +
      'path. Schema: { prompt: string, scenario?: string, maxTurns?: number, sessionId?: string, history?: ChatMessage[] }. ' +
      'Maps 1:1 to the run handler signature — no flag translation loss.',
  },
  {
    name: '--scenario',
    type: 'enum',
    choices: ['echo', 'write-rules'] as const,
    default: 'echo',
    description:
      'Scripted LLM fixture used in headless mode. echo: echoes the prompt. ' +
      'write-rules: emits a tool_call → text two-turn flow.',
    validate: {
      rejectControlChars: true,
      rejectPathTraversal: true,
      rejectQueryChars: true,
      maxLength: 64,
    },
  },
  {
    name: '--max-turns',
    type: 'number',
    default: 8,
    description: 'Hard cap on agent turn count for this session. 1–64.',
  },
  {
    name: '--session-id',
    type: 'string',
    description:
      'Override the auto-generated session id. Used as the basename for the auto session log file.',
    validate: {
      rejectControlChars: true,
      rejectPathTraversal: true,
      rejectQueryChars: true,
      maxLength: 64,
      pattern: '^[a-zA-Z0-9_.-]+$',
    },
  },
  {
    name: '--log-dir',
    type: 'path',
    description:
      'Directory for the auto session log file. Default: ~/.pyric/sessions/. ' +
      'Each run writes <log-dir>/<sessionId>.ndjson with the full event stream + metrics summary.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 1024 },
  },
  {
    name: '--no-log',
    type: 'boolean',
    description: 'Disable auto session log file writing. Stdout output is unaffected.',
  },
  {
    name: '--dry-run',
    type: 'boolean',
    description:
      'Validate inputs (parsing, hardening, file resolution) and emit a single ' +
      'plan event without invoking the LLM or running any tools.',
  },
  {
    name: '--llm',
    type: 'enum',
    choices: ['auto', 'scripted', 'openrouter'] as const,
    default: 'auto',
    description:
      'LLM backend. `scripted` uses the fixture LLM (echo / write-rules) for ' +
      'headless CI. `openrouter` requires OPENROUTER_API_KEY in env. `auto` ' +
      '(default) picks openrouter when the key is set, scripted otherwise.',
  },
  {
    name: '--model',
    type: 'string',
    description:
      'OpenRouter model id (e.g. `z-ai/glm-4.6`). Ignored for --llm scripted. ' +
      'Falls back to OPENROUTER_MODEL env var, then `z-ai/glm-4.6` default.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 128 },
  },
  {
    name: '--reasoning',
    type: 'enum',
    choices: ['off', 'low', 'medium', 'high'] as const,
    description:
      'Forward extended-thinking budget to models that support it (GLM, ' +
      'DeepSeek-R1, Claude with thinking, GPT-5 reasoning). Off by default ' +
      'to keep request shape lean.',
  },
  {
    name: '--no-tui',
    type: 'boolean',
    description:
      'Disable the OpenTUI run view even when stdout is a TTY. Falls ' +
      'back to the per-event prose emitter (the previous default). ' +
      'Useful when piping `--output text` through a pager or debugging ' +
      'the stream without the alt-screen.',
  },
];

const FLEET_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--size',
    short: '-n',
    type: 'number',
    default: 3,
    description: 'Number of concurrent sessions to launch. 1–64.',
  },
  {
    name: '--scenario',
    type: 'enum',
    choices: ['write-rules'] as const,
    default: 'write-rules',
    description: 'Scripted scenario each fleet member runs.',
  },
  {
    name: '--log-dir',
    type: 'path',
    description: 'Directory for per-session log files. Default: ~/.pyric/sessions/.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 1024 },
  },
  {
    name: '--no-log',
    type: 'boolean',
    description: 'Disable auto session log file writing.',
  },
  {
    name: '--dry-run',
    type: 'boolean',
    description: 'Print the planned fleet (size, member ids, scenario) without launching sessions.',
  },
];

const EVENTS_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--project',
    short: '-p',
    type: 'string',
    required: true,
    description: 'Firebase project id. The log lives at <events-dir>/<project>/events.ndjson.',
    validate: {
      rejectControlChars: true,
      rejectPathTraversal: true,
      rejectQueryChars: true,
      maxLength: 64,
      pattern: '^[a-zA-Z0-9_.-]+$',
    },
  },
  {
    name: '--events-dir',
    type: 'path',
    description:
      'Override the events root. Default: ~/.pyric/projects. The full log path is <events-dir>/<project>/events.ndjson.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 1024 },
  },
  {
    name: '--session',
    type: 'string',
    description: 'Restrict to events from a single agent session.',
    validate: {
      rejectControlChars: true,
      rejectPathTraversal: true,
      rejectQueryChars: true,
      maxLength: 64,
    },
  },
  {
    name: '--tool',
    type: 'string',
    description: 'Restrict to events from one tool name.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 64 },
  },
  {
    name: '--agent',
    type: 'string',
    description:
      "Restrict to events emitted by a single agent (e.g. 'firestore-data-modeling'). Default emitter is 'host'.",
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 64 },
  },
  {
    name: '--phase',
    type: 'enum',
    choices: ['plan', 'commit', 'rollback'] as const,
    description: 'Restrict to one lifecycle phase.',
  },
  {
    name: '--since',
    type: 'string',
    description: 'ISO-8601 lower bound (inclusive). Example: 2026-05-11T00:00:00Z.',
    validate: { rejectControlChars: true, maxLength: 40 },
  },
  {
    name: '--until',
    type: 'string',
    description: 'ISO-8601 upper bound (exclusive).',
    validate: { rejectControlChars: true, maxLength: 40 },
  },
  {
    name: '--include-bookkeeping',
    type: 'boolean',
    description:
      'Include bookkeeping markers (migrate_applied, migrate_intent) in the output. Hidden by default so "what changed?" queries return real mutations.',
  },
];

const UNDO_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--project',
    short: '-p',
    type: 'string',
    required: true,
    description: 'Firebase project id whose log holds the event.',
    validate: {
      rejectControlChars: true,
      rejectPathTraversal: true,
      rejectQueryChars: true,
      maxLength: 64,
      pattern: '^[a-zA-Z0-9_.-]+$',
    },
  },
  {
    name: '--event',
    short: '-e',
    type: 'string',
    required: true,
    description:
      'Event id to undo. Must reference a `commit`-phase event with `reversible: true`. Use `agent events` to find ids.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 64 },
  },
  {
    name: '--events-dir',
    type: 'path',
    description: 'Override the events root. Default: ~/.pyric/projects.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 1024 },
  },
  {
    name: '--dry-run',
    type: 'boolean',
    description:
      'Show the rollback plan (target, reverseOp tool+args, irreversible-flag check) without invoking the reverse op.',
  },
];

const SERVE_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--project',
    short: '-p',
    type: 'string',
    required: true,
    description:
      'Firebase project id. Routes the event log + run log to ~/.pyric/projects/<project>/.',
    validate: {
      rejectControlChars: true,
      rejectPathTraversal: true,
      rejectQueryChars: true,
      maxLength: 64,
      pattern: '^[a-zA-Z0-9_.-]+$',
    },
  },
  {
    name: '--events-dir',
    type: 'path',
    description: 'Override the events + runs root. Default: ~/.pyric/projects. Tests use this.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 1024 },
  },
  {
    name: '--dry-run',
    type: 'boolean',
    description: 'Print the catalog (agent + tool list) without binding stdio. Exit 0.',
  },
];

const MIGRATE_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--project',
    short: '-p',
    type: 'string',
    required: true,
    description: 'Firebase project id whose log holds the events to replay.',
    validate: {
      rejectControlChars: true,
      rejectPathTraversal: true,
      rejectQueryChars: true,
      maxLength: 64,
      pattern: '^[a-zA-Z0-9_.-]+$',
    },
  },
  {
    name: '--events-dir',
    type: 'path',
    description: 'Override the events root. Default: ~/.pyric/projects.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 1024 },
  },
  {
    name: '--since-event',
    type: 'string',
    description:
      'Replay only events with id >= this id. Use `agent events --project … --phase commit | head -1 | jq -r .id` to get an anchor.',
    validate: { rejectControlChars: true, rejectQueryChars: true, maxLength: 64 },
  },
  {
    name: '--tools',
    type: 'string[]',
    description: 'Comma-separated tool allowlist. Only events for these tools are planned.',
    validate: { rejectControlChars: true, maxLength: 512 },
  },
  {
    name: '--record',
    type: 'boolean',
    description:
      'Append a `migrate_intent` event to the log for host pickup. Without --record, the command is a pure plan (no log mutation).',
  },
];

const DESCRIBE_OPTIONS: readonly OptionSpec[] = [
  {
    name: '--target',
    short: '-t',
    type: 'enum',
    choices: ['commands', 'scenarios', 'events', 'all'] as const,
    default: 'all',
    description:
      'Which subject to describe. commands: subcommand tree. scenarios: scripted LLM fixtures. ' +
      'events: NDJSON event types. all: a single combined object.',
  },
];

export const CLI_SPEC: CliSpec = {
  name: 'agent',
  version: '0.0.0',
  description:
    'Headless runner for @inbrowser/agent sessions. NDJSON-by-default in non-TTY contexts, ' +
    'JSON stdin payloads, schema introspection, automatic per-session NDJSON logs, ' +
    'observability totals. See AGENTS.md for invariants.',
  globalOptions: GLOBAL_OPTIONS,
  commands: [
    {
      name: 'run',
      description: 'Run a single agent session against a scripted LLM and a fake sandbox.',
      mutating: true,
      options: RUN_OPTIONS,
      positional: {
        name: 'prompt',
        description:
          'Free-form prompt text. Equivalent to --prompt. Ignored when --json is supplied.',
      },
      examples: [
        {
          input: 'agent run "build a chess board"',
          description: 'Echo scenario, text output to TTY, NDJSON log to ~/.pyric/sessions/.',
        },
        {
          input: 'echo \'{"prompt":"reset rules","scenario":"write-rules"}\' | agent run --json -',
          description: 'Raw JSON payload from stdin. Output streams as NDJSON.',
        },
        {
          input: 'agent run --prompt "hi" --dry-run',
          description: 'Validates the run plan without invoking the LLM.',
        },
      ],
    },
    {
      name: 'fleet',
      description: 'Launch N concurrent agent sessions for isolation testing.',
      mutating: true,
      options: FLEET_OPTIONS,
      examples: [
        {
          input: 'agent fleet --size 10',
          description: '10 isolated sessions, NDJSON event stream, summary table at end.',
        },
        { input: 'agent fleet --size 3 --dry-run', description: 'Print the fleet plan only.' },
      ],
    },
    {
      name: 'describe',
      description:
        'Emit machine-readable descriptions of CLI subjects (commands, scenarios, events).',
      mutating: false,
      options: DESCRIBE_OPTIONS,
      examples: [
        { input: 'agent describe', description: 'Combined description as JSON.' },
        { input: 'agent describe --target events', description: 'NDJSON event-type catalog.' },
      ],
    },
    {
      name: 'events',
      description:
        'Stream the per-project mutation event log (~/.pyric/projects/<project>/events.ndjson). Each event is one NDJSON line. Supports filtering by session / tool / agent / phase / time.',
      mutating: false,
      options: EVENTS_OPTIONS,
      examples: [
        { input: 'agent events --project my-app', description: 'Full log as NDJSON.' },
        {
          input: 'agent events --project my-app --phase commit --tool writeRules',
          description: 'Just the committed writeRules events.',
        },
        {
          input: 'agent events --project my-app --session sess-123',
          description: 'Audit one session end-to-end.',
        },
      ],
    },
    {
      name: 'undo',
      description:
        'Reverse a previously-committed mutation by invoking its recorded reverseOp. Refuses on `reversible: false` events. `--dry-run` shows the plan.',
      mutating: true,
      options: UNDO_OPTIONS,
      examples: [
        {
          input: 'agent undo --project my-app --event abc123-xyz --dry-run',
          description: 'Plan the rollback only.',
        },
        {
          input: 'agent undo --project my-app --event abc123-xyz',
          description: 'Execute the recorded reverseOp; appends a `rollback` event to the log.',
        },
      ],
    },
    {
      name: 'serve',
      description:
        'Inverse-mode MCP server. Exposes the named AgentDefinition(s) over stdio MCP so an external host (Claude Code, Claude Desktop, Cursor) can call their behavior-named tools. Process holds stdin/stdout for the transport; do not pipe through it.',
      mutating: true,
      options: SERVE_OPTIONS,
      examples: [
        {
          input: 'agent serve --project demo --dry-run',
          description: 'Print the tool catalog without binding stdio.',
        },
        {
          input: 'agent serve --project demo',
          description:
            "Boot the MCP server. Exposes every built-in agent's tools flat. " +
            'Wire via Claude Code mcpServers config.',
        },
      ],
    },
    {
      name: 'migrate',
      description:
        'Plan the forward replay of a project event log against a production dispatch. The CLI emits one `migrate_plan` per replayable commit; `--record` appends a `migrate_intent` marker for host pickup. Like `undo`, the CLI does not invoke tools — call `replayEvents()` from `@inbrowser/agent` against your prod registry. ' +
        'Marked `mutating: true` because `--record` appends to the log; without `--record` the command is pure plan-only (no log mutation), which is the implicit dry-run shape.',
      mutating: true,
      options: MIGRATE_OPTIONS,
      examples: [
        {
          input: 'agent migrate --project my-app',
          description: 'Plan every replayable commit (NDJSON).',
        },
        {
          input:
            'agent migrate --project my-app --since-event ksx91m3-0001-a4f --tools setDoc,writeRules',
          description: 'Filtered plan.',
        },
        {
          input: 'agent migrate --project my-app --record',
          description: 'Plan + append `migrate_intent` for host pickup.',
        },
      ],
    },
    {
      name: 'schema',
      description: 'Dump the full CLI command-and-option schema as JSON.',
      mutating: false,
      options: [],
      examples: [
        {
          input: 'agent schema',
          description: 'Full schema. Stable contract for agent integrations.',
        },
      ],
    },
    {
      name: 'version',
      description: 'Print the package version.',
      mutating: false,
      options: [],
    },
    {
      name: 'help',
      description: 'Show top-level help. Add a subcommand name to scope it.',
      mutating: false,
      options: [],
    },
  ],
};

export function findCommand(name: string): CommandSpec | undefined {
  return CLI_SPEC.commands.find((c) => c.name === name);
}
