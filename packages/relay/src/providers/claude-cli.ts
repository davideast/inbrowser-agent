import { type ChildProcess, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { InferenceEvent, InferenceProvider, LegacyChatMessage } from '../types.js';

/**
 * Claude Code CLI provider — spawns `claude -p` (print mode) as a
 * subprocess and adapts its `stream-json` output to `InferenceEvent`s.
 *
 * Why: model access through a Claude subscription (the CLI's own
 * login) instead of API-key metering. The relay caller sends messages
 * and gets a completion back; auth, retries, and the wire protocol
 * are the CLI's problem.
 *
 * ## Semantic differences from a raw model call — READ THIS
 *
 * `claude -p` runs Claude *Code*, an agentic CLI, not the bare
 * Messages API. This provider pins it as close to a pure model call
 * as the CLI allows (flags grounded in `claude --help`, v2.1.172):
 *
 *   - `--tools ""`             disables all built-in tools (no Bash/Edit/
 *                              Read…). Re-enable selectively via
 *                              `ClaudeCliOptions.tools`.
 *   - `--strict-mcp-config`    with no `--mcp-config` ⇒ zero MCP servers.
 *   - `--disable-slash-commands` disables skills.
 *   - `--no-session-persistence` nothing written to the session store.
 *   - `--system-prompt <s>`    when the request carries system messages,
 *                              they REPLACE Claude Code's default agentic
 *                              system prompt. With no system message the
 *                              CLI's default prompt applies.
 *
 * What can NOT be turned off / mapped:
 *
 *   - The CLI still injects its own context (current date, user
 *     email, memory paths) around the prompt. Responses are "Claude
 *     via Claude Code", not raw `/v1/messages`.
 *   - There is no `--max-turns` in this CLI version; with all tools
 *     disabled the run is effectively single-turn anyway.
 *   - Caller-defined tools (`NormalizedRequest.tools`) have no CLI
 *     equivalent — the provider yields an `error` event if any are
 *     passed rather than silently dropping them.
 *   - `temperature` / `topP` / `topK` have no CLI flags and are
 *     ignored. `reasoningEffort` maps to `--effort` (`off` is
 *     omitted; the CLI has no off level).
 *   - Multi-turn histories are flattened into a single transcript
 *     prompt (`claude -p` accepts one prompt, piped via stdin). For
 *     one-shot user messages the text is passed through verbatim.
 *
 * ## Wire shape
 *
 * `--output-format stream-json --include-partial-messages --verbose`
 * emits NDJSON on stdout. The lines this provider consumes (captured
 * from a real run; see `test/fixtures/claude-cli-stream-json.ndjson`):
 *
 *   - `{type:"stream_event", event:{type:"content_block_delta",
 *      delta:{type:"text_delta"|"thinking_delta", ...}}}` → incremental
 *      `text` / `thinking` chunks.
 *   - `{type:"result", subtype:"success", result:"…", usage:{…},
 *      total_cost_usd:…}` → terminal `usage` event (input/output/
 *      cache-read tokens + real dollar cost). `is_error: true` →
 *      `error` event.
 *
 * Everything else (`system`, `assistant` snapshots, `rate_limit_event`,
 * unknown/malformed lines) is skipped.
 *
 * ## Auth
 *
 * If `NormalizedRequest.apiKey` is non-empty it is exported as
 * `ANTHROPIC_API_KEY` to the subprocess; otherwise the CLI's own
 * credentials (subscription OAuth / keychain) apply — pass `apiKey: ''`
 * for the common subscription case.
 *
 * ## Subprocess hygiene
 *
 * Spawned with an argv array (never through a shell — no injection
 * surface), prompt piped via stdin (no argv-length limit), stdout
 * parsed incrementally line-by-line (no unbounded buffering), stderr
 * capped at 16 KiB, hard timeout (default 5 min) followed by SIGKILL,
 * `AbortSignal` kills the child, ENOENT and non-zero exits surface as
 * typed `error` events.
 */
export interface ClaudeCliOptions {
  /** Path to the executable. Default `'claude'` (resolved via PATH). */
  claudePath?: string;
  /** Hard wall-clock cap; the child is SIGKILLed after this. Default 300_000 ms. */
  timeoutMs?: number;
  /**
   * Working directory for the subprocess. Defaults to `os.tmpdir()` so
   * the CLI doesn't pick up the host project's CLAUDE.md / settings.
   */
  cwd?: string;
  /**
   * Built-in CLI tools to allow (e.g. `['Read', 'Grep']`), passed to
   * `--tools`. Default `[]` ⇒ `--tools ""` ⇒ all tools disabled —
   * the pure-model configuration.
   */
  tools?: string[];
  /** Extra argv appended verbatim — escape hatch for new CLI flags. */
  extraArgs?: string[];
  /** Extra environment for the subprocess (merged over `process.env`). */
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const STDERR_CAP = 16 * 1024;

/** Map the relay's `reasoningEffort` onto `--effort` (no `off` level in the CLI). */
function toEffortFlag(effort: string | undefined): string | undefined {
  return effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined;
}

/**
 * Flatten relay messages into (system, prompt). A single user message
 * passes through verbatim; anything longer becomes a labeled
 * transcript with an explicit "reply with the next assistant message"
 * framing — `claude -p` takes one prompt, not a message array.
 */
export function renderPrompt(messages: LegacyChatMessage[]): {
  system: string;
  prompt: string;
} {
  let system = '';
  const turns: { role: string; text: string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (m.text ?? '');
      continue;
    }
    if (m.role === 'user') {
      turns.push({ role: 'User', text: m.text ?? '' });
      continue;
    }
    if (m.role === 'assistant') {
      let text = m.text ?? '';
      for (const c of m.toolCalls ?? []) {
        text += `${text ? '\n' : ''}[called tool ${c.name} with ${JSON.stringify(c.args ?? {})}]`;
      }
      turns.push({ role: 'Assistant', text });
      continue;
    }
    if (m.role === 'tool') {
      turns.push({ role: 'Tool result', text: `${m.name ?? ''}: ${m.resultJson ?? ''}` });
    }
  }
  if (turns.length === 1 && turns[0]?.role === 'User') {
    return { system, prompt: turns[0].text };
  }
  const transcript = turns.map((t) => `${t.role}: ${t.text}`).join('\n\n');
  return {
    system,
    prompt: `The following is a conversation transcript. Reply with the next Assistant message only — no role label, no commentary.\n\n${transcript}`,
  };
}

/** Subset of the NDJSON lines `claude -p --output-format stream-json` emits. */
interface CliLine {
  type?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Build a Claude Code CLI provider. `createClaudeCliProvider()` with no
 * options is the pure-model default; register it like any other provider:
 *
 * ```ts
 * const relay = createRelay({
 *   store,
 *   providers: { 'claude-cli': createClaudeCliProvider() },
 * });
 * // client request: { provider: 'claude-cli', model: 'claude-opus-4-8',
 * //                   messages, tools: [], apiKey: '' }
 * ```
 */
export function createClaudeCliProvider(options: ClaudeCliOptions = {}): InferenceProvider {
  const claudePath = options.claudePath ?? 'claude';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? tmpdir();
  const tools = options.tools ?? [];
  const extraArgs = options.extraArgs ?? [];

  return async function* claudeCli(req): AsyncIterable<InferenceEvent> {
    if (req.signal?.aborted) return;

    if (req.tools.length > 0) {
      yield {
        kind: 'error',
        message:
          'claude-cli provider does not support caller-defined tools — `claude -p` has no flag to register external tool schemas. Send `tools: []` (or use an API provider for tool calling).',
      };
      return;
    }

    const { system, prompt } = renderPrompt(req.messages);
    if (!prompt) {
      yield { kind: 'error', message: 'claude-cli provider: no user message to send.' };
      return;
    }

    // Every flag below is grounded in `claude --help` (v2.1.172).
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--tools',
      tools.join(','),
    ];
    if (req.model) args.push('--model', req.model);
    if (system) args.push('--system-prompt', system);
    const effort = toEffortFlag(req.reasoningEffort);
    if (effort) args.push('--effort', effort);
    args.push(...extraArgs);

    let child: ChildProcess;
    try {
      child = spawn(claudePath, args, {
        cwd,
        env: {
          ...process.env,
          ...(req.apiKey ? { ANTHROPIC_API_KEY: req.apiKey } : {}),
          ...options.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
      return;
    }

    let spawnError: NodeJS.ErrnoException | undefined;
    let timedOut = false;
    let stderr = '';

    child.on('error', (e) => {
      spawnError = e as NodeJS.ErrnoException;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.slice(0, STDERR_CAP - stderr.length);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    // Also destroy our pipe ends on kill: a grandchild process can
    // inherit the stdout fd and keep the stream open past SIGKILL,
    // which would wedge the read loop.
    const killChild = () => {
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    const onAbort = () => killChild();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    // Pipe the prompt via stdin. Swallow EPIPE — a child that dies
    // before reading stdin is reported through exit-code handling.
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);

    let sawText = false;
    let sawResult = false;

    try {
      child.stdout?.setEncoding('utf8');
      let buf = '';
      const lines = async function* () {
        if (!child.stdout) return;
        try {
          for await (const chunk of child.stdout as AsyncIterable<string>) {
            buf += chunk;
            let nl = buf.indexOf('\n');
            while (nl !== -1) {
              yield buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              nl = buf.indexOf('\n');
            }
          }
        } catch {
          // stream destroyed by kill/abort — handled after the loop
        }
        if (buf.trim()) yield buf;
      };

      for await (const rawLine of lines()) {
        const line = rawLine.trim();
        if (!line) continue;
        let msg: CliLine;
        try {
          msg = JSON.parse(line) as CliLine;
        } catch {
          continue; // tolerate non-JSON noise on stdout
        }

        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
          const delta = msg.event.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            sawText = true;
            yield { kind: 'text', chunk: delta.text };
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            yield { kind: 'thinking', chunk: delta.thinking };
          }
          continue;
        }

        if (msg.type === 'result') {
          sawResult = true;
          if (msg.is_error) {
            yield {
              kind: 'error',
              message: `claude -p reported ${msg.subtype ?? 'error'}: ${
                typeof msg.result === 'string' && msg.result
                  ? msg.result.slice(0, 400)
                  : '(no detail)'
              }`,
            };
            return;
          }
          // Defensive: if no deltas streamed (e.g. partial messages
          // unavailable), fall back to the terminal result text.
          if (!sawText && typeof msg.result === 'string' && msg.result) {
            yield { kind: 'text', chunk: msg.result };
          }
          yield {
            kind: 'usage',
            promptTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
            ...(typeof msg.usage?.cache_read_input_tokens === 'number'
              ? { cachedTokens: msg.usage.cache_read_input_tokens }
              : {}),
            ...(typeof msg.total_cost_usd === 'number' ? { costUsd: msg.total_cost_usd } : {}),
          };
          return; // result is terminal
        }
        // system / assistant / rate_limit_event / unknown — skipped.
      }

      const exitCode = await exited;
      if (timedOut) {
        yield { kind: 'error', message: `claude -p timed out after ${timeoutMs}ms.` };
        return;
      }
      if (req.signal?.aborted) return;
      if (spawnError) {
        const hint =
          spawnError.code === 'ENOENT'
            ? `claude CLI not found at '${claudePath}'. Install Claude Code (https://claude.com/claude-code) or set ClaudeCliOptions.claudePath.`
            : `failed to spawn '${claudePath}': ${spawnError.message}`;
        yield { kind: 'error', message: hint };
        return;
      }
      if (!sawResult) {
        yield {
          kind: 'error',
          message:
            exitCode !== 0
              ? `claude -p exited with code ${exitCode}: ${stderr.trim().slice(0, 400) || '(no stderr)'}`
              : 'claude -p exited without emitting a result event.',
        };
      }
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  };
}

/** Ready-made instance with pure-model defaults (no tools, tmpdir cwd, 5-min timeout). */
export const claudeCliProvider: InferenceProvider = createClaudeCliProvider();
