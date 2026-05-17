/**
 * `agent run` — single-session headless runner.
 *
 * Inputs (via parsed args): prompt (positional or --prompt) OR a full
 * JSON payload via --json (stdin or file). Emits events to the chosen
 * Emitter (ndjson default in non-TTY, text default in TTY) AND writes
 * the same NDJSON stream to <log-dir>/<sessionId>.ndjson unless
 * --no-log is set. The final `session_end` event includes the metrics
 * totals so the log file is self-describing.
 *
 * --dry-run short-circuits: emits a single `dry_run_plan` event and
 * returns 0. No LLM call, no tool dispatch, no sandbox.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import type {
  ChatMessage,
  LlmClient,
  ObserverEvent,
  SessionEvent,
  ToolContext,
} from '../../index.js';
import { createMetricsCollector } from '../../metrics.js';
import { createAgentSession } from '../../session.js';
import { createReactLoopStrategy } from '../../strategy.js';
import { createDispatch, createToolRegistry } from '../../tools.js';
import { combineObservers } from '../../types/observer.js';
import { fakeSandbox, scriptedLlm, writeCodeTool, writeRulesTool } from '../fixtures.js';
import type { ScenarioId } from '../fixtures.js';
import { openRouterClient } from '../llm/openrouter.js';
import type { Emitter } from '../output.js';
import { errorEvent } from '../output.js';
import type { ParsedArgs } from '../parse.js';
import { type SessionLog, openSessionLog } from '../session-log.js';

export interface RunPayload {
  prompt: string;
  scenario?: ScenarioId;
  maxTurns?: number;
  sessionId?: string;
  history?: ChatMessage[];
}

export interface RunCommandIO {
  emit: Emitter;
  /** Reads --json file content. Defaults to fs.readFileSync. */
  readFile?: (path: string) => string;
  /** Reads stdin synchronously. Defaults to a Bun/Node compatible reader. */
  readStdin?: () => string;
  /** Override the timer for deterministic tests. */
  now?: () => string;
  /** Inject a session-log factory (tests pass a no-op or an in-memory one). */
  openLog?: typeof openSessionLog;
}

function readStdinSync(): string {
  // Bun and modern Node both support readFileSync('/dev/stdin'). It blocks
  // until EOF, which is what we want for an agent piping a small payload.
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Load `packages/agent/.env` into `process.env` if present. Bun
 * auto-loads `.env` from CWD; this fallback covers the case where the
 * user runs `bun packages/agent/bin/agent.ts run ...` from the
 * worktree root (CWD is worktree root, not packages/agent). Existing
 * process.env values are NOT overwritten — explicit env beats the
 * file.
 */
function loadPackageEnv(): void {
  try {
    // src/cli/commands → ../../.. → packages/agent
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgRoot = resolve(here, '..', '..', '..');
    const envPath = resolve(pkgRoot, '.env');
    if (!existsSync(envPath)) return;
    const text = readFileSync(envPath, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const raw = line.slice(eq + 1).trim();
      // Strip surrounding single/double quotes if present.
      const value = raw.replace(/^["']|["']$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Silent — env file is a convenience, not load-bearing.
  }
}

// ─── TUI mode ────────────────────────────────────────────────────────

/**
 * Map a SessionEvent to the NDJSON shape that goes into the session
 * log file. Used by both the existing text/NDJSON emitter (via inline
 * objects in the switch below) and by the TUI mode's log-tee
 * (lifted here so the on-disk format stays identical regardless of
 * which stdout renderer is in use). `runtime_changed` + `completed`
 * return null — they don't surface to the log.
 */
function eventToLogShape(
  ev: SessionEvent,
  now: () => string,
  sessionId: string,
): Record<string, unknown> | null {
  switch (ev.kind) {
    case 'turn_started':
      return { type: 'turn_start', ts: now(), sessionId, turn: ev.turnId };
    case 'thinking':
      return { type: 'thinking', ts: now(), sessionId, chunk: ev.chunk };
    case 'text':
      return { type: 'text', ts: now(), sessionId, chunk: ev.chunk };
    case 'tool_started':
      return {
        type: 'tool_call',
        ts: now(),
        sessionId,
        name: ev.name,
        callId: ev.callId,
        args: ev.args,
      };
    case 'tool_finished':
      return {
        type: 'tool_result',
        ts: now(),
        sessionId,
        callId: ev.callId,
        ok: ev.result.ok,
        summary: ev.result.summary,
      };
    case 'workspace_changed':
      return {
        type: 'workspace_changed',
        ts: now(),
        sessionId,
        rulesLength: ev.workspace.rules.length,
        codeLength: ev.workspace.code.length,
      };
    case 'turn_completed':
      return {
        type: 'turn_end',
        ts: now(),
        sessionId,
        turn: ev.turnId,
        metrics: {
          tokensIn: ev.metrics.tokensIn,
          tokensOut: ev.metrics.tokensOut,
          costUsd: ev.metrics.costUsd,
        },
      };
    case 'strategy_event':
      return { type: 'strategy_event', ts: now(), sessionId, name: ev.name, data: ev.data };
    case 'error':
      return { type: 'session_error', ts: now(), sessionId, message: ev.message };
    case 'runtime_changed':
    case 'completed':
      return null;
  }
}

interface RunWithTuiInput {
  stream: AsyncIterable<SessionEvent>;
  log: SessionLog;
  now: () => string;
  sessionId: string;
  llmLabel: string;
  llmFallbackReason?: string;
  scenario: string;
  promptPreview: string;
  metrics: ReturnType<typeof createMetricsCollector>;
}

/**
 * Drive the session stream through the OpenTUI/React `RunView`
 * renderer. The TUI is the only consumer; it tees each event back to
 * the session log file so the persisted record matches NDJSON mode
 * byte-for-byte. On completion (or error) the renderer tears down
 * and a one-line summary lands on stdout AFTER the alt-screen exits —
 * preserves the "you can scroll back and see what ran" affordance.
 */
async function runWithTui(input: RunWithTuiInput): Promise<number> {
  // Lazy-import OpenTUI + RunView so the NDJSON / non-TTY path doesn't
  // pay the native-binary load cost (the Zig core compiles + loads on
  // import), and so `@opentui/react`'s internal extensionless ESM
  // imports don't break consumers that only need the non-TUI surface.
  const [{ createCliRenderer }, { createRoot }, { RunView }] = await Promise.all([
    import('@opentui/core'),
    import('@opentui/react'),
    import('../ui/RunView.js'),
  ]);

  // Tee the session stream: write each event to the log file BEFORE
  // forwarding to the TUI. RunView's pumpEvents consumes the
  // forwarded events from `events`.
  const teed: AsyncIterable<SessionEvent> = (async function* () {
    for await (const ev of input.stream) {
      const shape = eventToLogShape(ev, input.now, input.sessionId);
      if (shape) input.log.write(shape);
      yield ev;
    }
  })();

  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const exit = 0;
  // Wait for the user to press `q` / Escape AFTER the session has
  // ended. The TUI stays alive between session_end and user-quit so
  // the FinalSummary is readable — destroying immediately would flash
  // the summary for one frame and clear the alt-screen.
  await new Promise<void>((resolve) => {
    createRoot(renderer).render(
      createElement(RunView, {
        events: teed,
        bootstrap: {
          sessionId: input.sessionId,
          scenario: input.scenario,
          llmLabel: input.llmLabel,
          ...(input.llmFallbackReason ? { llmFallbackReason: input.llmFallbackReason } : {}),
          promptPreview: input.promptPreview,
          ...(input.log.path ? { logPath: input.log.path } : {}),
        },
        onQuit: () => resolve(),
      }),
    );
  });
  await renderer.destroy();

  // Final summary lands on stdout after the alt-screen tears down so
  // it stays in the user's scrollback.
  const totals = input.metrics.totals();
  const finalShape = {
    type: 'session_end',
    ts: input.now(),
    sessionId: input.sessionId,
    totals: {
      turnCount: totals.turnCount,
      tokensTotal: totals.tokensTotal,
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      tokensCached: totals.tokensCached,
      tokensReasoning: totals.tokensReasoning,
      costUsd: totals.costUsdTotal,
    },
    logPath: input.log.path,
    exit,
  };
  input.log.write(finalShape);
  input.log.close();

  // Multi-line summary lands in scrollback so the user can see all
  // the run metadata after the TUI tears down. The TUI's
  // <FinalSummary> shows the same data inside the alt-screen, but
  // that disappears on destroy; this is the persisted version. Plain
  // text — ANSI codes intentionally omitted so it pipes/grep's
  // cleanly.
  const lines: string[] = [
    '',
    '─── session complete ──────────────────────────────',
    `  status    ${exit === 0 ? 'ok' : 'failed'}`,
    `  turns     ${totals.turnCount}`,
    `  tokens    ${totals.tokensTotal.toLocaleString()}` +
      ` (in ${totals.tokensIn.toLocaleString()}` +
      ` · out ${totals.tokensOut.toLocaleString()}` +
      (totals.tokensCached > 0 ? ` · cached ${totals.tokensCached.toLocaleString()}` : '') +
      (totals.tokensReasoning > 0
        ? ` · reasoning ${totals.tokensReasoning.toLocaleString()}`
        : '') +
      ')',
    `  cost      $${totals.costUsdTotal.toFixed(6)}`,
  ];
  if (input.log.path) lines.push(`  log       ${input.log.path}`);
  lines.push('───────────────────────────────────────────────────');
  lines.push('');
  process.stdout.write(lines.join('\n'));
  return exit;
}

function parsePayload(raw: string): RunPayload {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--json payload is not valid JSON: ${(err as Error).message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('--json payload must be a JSON object');
  }
  const p = obj as Record<string, unknown>;
  if (typeof p['prompt'] !== 'string' || p['prompt'].length === 0) {
    throw new Error('--json payload missing required string field "prompt"');
  }
  const out: RunPayload = { prompt: p['prompt'] };
  if (typeof p['scenario'] === 'string') out.scenario = p['scenario'] as ScenarioId;
  if (typeof p['maxTurns'] === 'number') out.maxTurns = p['maxTurns'];
  if (typeof p['sessionId'] === 'string') out.sessionId = p['sessionId'];
  if (Array.isArray(p['history'])) out.history = p['history'] as ChatMessage[];
  return out;
}

function genSessionId(now: () => string): string {
  const ts = now().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `sess-${ts}-${rand}`;
}

export async function runCommand(args: ParsedArgs, io: RunCommandIO): Promise<number> {
  loadPackageEnv();
  const emit = io.emit;
  const readFile = io.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const readStdin = io.readStdin ?? readStdinSync;
  const now = io.now ?? (() => new Date().toISOString());
  const openLog = io.openLog ?? openSessionLog;

  // Resolve payload — either from --json or from --prompt/positional.
  let payload: RunPayload;
  if (args.options['json'] !== undefined) {
    const target = args.options['json'] as string;
    const raw = target === '-' ? readStdin() : readFile(target);
    if (!raw || raw.trim().length === 0) {
      throw new Error('--json payload is empty');
    }
    payload = parsePayload(raw);
  } else {
    const prompt =
      (args.options['prompt'] as string | undefined) ??
      (args.positional.length > 0 ? args.positional.join(' ') : '');
    if (!prompt) {
      throw new Error('missing prompt: pass --prompt, a positional, or --json -');
    }
    payload = {
      prompt,
      scenario: (args.options['scenario'] as ScenarioId | undefined) ?? 'echo',
      maxTurns: (args.options['max-turns'] as number | undefined) ?? 8,
      sessionId: args.options['session-id'] as string | undefined,
    };
  }

  if (payload.maxTurns !== undefined && (payload.maxTurns < 1 || payload.maxTurns > 64)) {
    throw new Error('maxTurns must be 1..64');
  }

  const sessionId = payload.sessionId ?? genSessionId(now);
  const scenario: ScenarioId = payload.scenario ?? 'echo';
  const logDir = (args.options['log-dir'] as string | undefined) ?? null;
  const disableLog = Boolean(args.options['no-log']);

  if (args.options['dry-run']) {
    emit.event(
      {
        type: 'dry_run_plan',
        ts: now(),
        command: 'run',
        sessionId,
        scenario,
        maxTurns: payload.maxTurns ?? 8,
        promptPreview: payload.prompt.slice(0, 120),
        logPath: disableLog ? null : `${logDir ?? '~/.pyric/sessions'}/${sessionId}.ndjson`,
      },
      () =>
        `[plan] run · session=${sessionId} · scenario=${scenario} · turns<=${payload.maxTurns ?? 8} · prompt=${JSON.stringify(payload.prompt.slice(0, 60))}`,
    );
    emit.finish();
    return 0;
  }

  const log = openLog({ logDir, sessionId, disabled: disableLog });

  const emitBoth = (event: Record<string, unknown>, plain?: () => string) => {
    emit.event(event, plain);
    log.write(event);
  };

  emitBoth(
    { type: 'session_start', ts: now(), sessionId, scenario, maxTurns: payload.maxTurns ?? 8 },
    () => `[run] session ${sessionId} (${scenario})`,
  );

  const registry = createToolRegistry();
  registry.register(writeRulesTool);
  registry.register(writeCodeTool);

  const metrics = createMetricsCollector();
  const sandbox = fakeSandbox();

  const sandboxObserver = {
    onEvent(event: ObserverEvent) {
      emitBoth(
        {
          type: 'sandbox_event',
          ts: now(),
          sessionId,
          kind: event.kind,
          detail: event.detail,
        },
        () => `[sandbox.${event.kind}] ${JSON.stringify(event.detail).slice(0, 120)}`,
      );
    },
  };
  void combineObservers(sandboxObserver);

  // LLM selection. `--llm openrouter` (or its env-driven default when
  // OPENROUTER_API_KEY is set) routes to a real model; otherwise we
  // fall back to the scripted-fixture LLM for headless CI work.
  // `bun run` auto-loads a `.env` from CWD, so dropping
  //   OPENROUTER_API_KEY=sk-or-...
  //   OPENROUTER_MODEL=z-ai/glm-4.6   # optional
  // into `packages/agent/.env` and running from that directory is the
  // easiest path. Explicit `--llm` / `--model` flags override env.
  const llmFlag = (args.options['llm'] as string | undefined) ?? 'auto';
  const modelFlag = (args.options['model'] as string | undefined) ?? undefined;
  const reasoningFlag = args.options['reasoning'] as 'off' | 'low' | 'medium' | 'high' | undefined;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const envModel = process.env.OPENROUTER_MODEL;
  const wantOpenRouter = llmFlag === 'openrouter' || (llmFlag === 'auto' && apiKey);

  let llm: LlmClient;
  let llmLabel: string;
  let llmFallbackReason: string | undefined;
  if (wantOpenRouter) {
    if (!apiKey) {
      throw new Error(
        '--llm openrouter requires OPENROUTER_API_KEY in env. Drop a `.env` ' +
          'with the key into packages/agent/ (auto-loaded regardless of CWD) ' +
          'or pass --llm scripted to use the fixture LLM.',
      );
    }
    const model = modelFlag ?? envModel ?? 'z-ai/glm-4.6';
    llm = openRouterClient({
      apiKey,
      model,
      ...(reasoningFlag ? { reasoningEffort: reasoningFlag } : {}),
      referer: 'https://github.com/davideast/inbrowser-agent',
      title: '@inbrowser/agent CLI',
    });
    llmLabel = `openrouter:${model}`;
  } else {
    llm = scriptedLlm(scenario, sessionId.slice(0, 8));
    llmLabel = `scripted:${scenario}`;
    if (llmFlag === 'auto') {
      // Surface WHY we chose scripted, so the user sees `[llm]
      // scripted:echo (no OPENROUTER_API_KEY in env; drop one in
      // packages/agent/.env)` instead of silently going to fixtures.
      llmFallbackReason =
        'no OPENROUTER_API_KEY in env; drop one in packages/agent/.env or pass --llm openrouter';
    }
  }

  emitBoth(
    {
      type: 'llm_selected',
      ts: now(),
      sessionId,
      llm: llmLabel,
      ...(llmFallbackReason ? { fallbackReason: llmFallbackReason } : {}),
    },
    () => `[llm] ${llmLabel}${llmFallbackReason ? ` (${llmFallbackReason})` : ''}`,
  );

  const session = createAgentSession({
    strategy: createReactLoopStrategy(),
    llm,
    tools: createDispatch(registry),
    toolList: registry.list(),
    toolContext: (): ToolContext => ({
      workspace: session.workspace,
      runtime: session.runtime,
      sandbox,
      lint: () => ({ warnings: [] }),
      signal: new AbortController().signal,
    }),
    systemPromptBuilder: (w, r) =>
      `Headless agent. preset=${w.presetId || '(none)'} errors=${r.uiErrors.length}`,
    metrics,
    history: payload.history ?? [],
    id: sessionId,
  });

  // The fixture LLM is instant; real models stream for seconds → minutes.
  // 30s was the fixture's safety net; bump to 5min when an external LLM
  // drives the loop.
  const submitTimeoutMs = wantOpenRouter ? 300_000 : 30_000;

  // TUI mode: when emit is text mode AND stdout is a real TTY, mount
  // the OpenTUI/React `RunView` instead of streaming per-event prose
  // to stdout. Forcing text mode in a piped context (`--output text |
  // tee log`) doesn't qualify — we still need cursor control. NDJSON
  // and piped-text both fall through to the existing event emitter
  // below.
  const tuiEligible =
    emit.mode === 'text' && Boolean(process.stdout.isTTY) && !args.options['no-tui'];
  if (tuiEligible) {
    return await runWithTui({
      stream: session.submit(payload.prompt, AbortSignal.timeout(submitTimeoutMs)),
      log,
      now,
      sessionId,
      llmLabel,
      ...(llmFallbackReason ? { llmFallbackReason } : {}),
      scenario,
      promptPreview: payload.prompt.slice(0, 80),
      metrics,
    });
  }

  let exit = 0;
  try {
    const stream = session.submit(payload.prompt, AbortSignal.timeout(submitTimeoutMs));
    for await (const ev of stream as AsyncIterable<SessionEvent>) {
      switch (ev.kind) {
        case 'turn_started':
          emitBoth(
            { type: 'turn_start', ts: now(), sessionId, turn: ev.turnId },
            () => `[turn ${ev.turnId.slice(0, 12)} start]`,
          );
          break;
        case 'thinking':
          emitBoth(
            { type: 'thinking', ts: now(), sessionId, chunk: ev.chunk },
            () => `[thinking] ${ev.chunk.trim()}`,
          );
          break;
        case 'text':
          emitBoth({ type: 'text', ts: now(), sessionId, chunk: ev.chunk }, () =>
            ev.chunk.trimEnd(),
          );
          break;
        case 'tool_started':
          emitBoth(
            {
              type: 'tool_call',
              ts: now(),
              sessionId,
              name: ev.name,
              callId: ev.callId,
              args: ev.args,
            },
            () => `[tool ${ev.name}(${ev.callId})]`,
          );
          break;
        case 'tool_finished':
          emitBoth(
            {
              type: 'tool_result',
              ts: now(),
              sessionId,
              callId: ev.callId,
              ok: ev.result.ok,
              summary: ev.result.summary,
            },
            () => `[tool ${ev.callId} ${ev.result.ok ? 'ok' : 'fail'}] ${ev.result.summary ?? ''}`,
          );
          break;
        case 'workspace_changed':
          emitBoth(
            {
              type: 'workspace_changed',
              ts: now(),
              sessionId,
              rulesLength: ev.workspace.rules.length,
              codeLength: ev.workspace.code.length,
            },
            () => `[workspace] rules=${ev.workspace.rules.length} code=${ev.workspace.code.length}`,
          );
          break;
        case 'turn_completed':
          emitBoth(
            {
              type: 'turn_end',
              ts: now(),
              sessionId,
              turn: ev.turnId,
              metrics: {
                tokensIn: ev.metrics.tokensIn,
                tokensOut: ev.metrics.tokensOut,
                costUsd: ev.metrics.costUsd,
              },
            },
            () =>
              `[turn ${ev.turnId.slice(0, 12)} done] ${ev.metrics.tokensIn}+${ev.metrics.tokensOut}t · $${ev.metrics.costUsd.toFixed(6)}`,
          );
          break;
        case 'strategy_event':
          emitBoth(
            { type: 'strategy_event', ts: now(), sessionId, name: ev.name, data: ev.data },
            () => `[strategy] ${ev.name}`,
          );
          break;
        case 'error':
          emitBoth(
            { type: 'session_error', ts: now(), sessionId, message: ev.message },
            () => `[error] ${ev.message}`,
          );
          exit = exit || 1;
          break;
        case 'runtime_changed':
          // No-op for the CLI surface.
          break;
        case 'completed':
          // session_end emitted below with totals.
          break;
      }
    }
  } catch (err) {
    emitBoth(errorEvent(err));
    exit = 2;
  }

  const totals = metrics.totals();
  emitBoth(
    {
      type: 'session_end',
      ts: now(),
      sessionId,
      totals: {
        turnCount: totals.turnCount,
        tokensTotal: totals.tokensTotal,
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        tokensCached: totals.tokensCached,
        tokensReasoning: totals.tokensReasoning,
        costUsd: totals.costUsdTotal,
      },
      workspace: {
        rulesLength: session.workspace.rules.length,
        codeLength: session.workspace.code.length,
      },
      logPath: log.path,
      exit,
    },
    () =>
      `[run] done · ${totals.turnCount} turns · ${totals.tokensTotal} tokens · $${totals.costUsdTotal.toFixed(6)}` +
      (log.path ? ` · log=${log.path}` : ''),
  );

  log.close();
  emit.finish();
  return exit;
}
