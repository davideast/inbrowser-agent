/**
 * Run view — OpenTUI/React renderer for `agent run` when stdout is a
 * TTY. Subscribes to the `AgentSession` event stream and projects it
 * into a four-section layout: header (run metadata) → thinking
 * (scrollable trace) → output (markdown) → tool cards → footer
 * (token/cost/elapsed).
 *
 * Wiring lives in `cli/commands/run.ts` — the runCommand picks this
 * over the NDJSON emitter when `pickMode()` resolves to `text` AND
 * stdout.isTTY. NDJSON / piped / `--output ndjson` keep the existing
 * emitter behavior; agent integrations + tests rely on it.
 *
 * v0 scaffold (this file): state machine + placeholder layout. The
 * scrollbox / markdown / code components plug in over the next two
 * phases.
 */

import { useEffect, useReducer } from 'react';
import { RGBA, SyntaxStyle } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { SessionEvent } from '../../types/session.js';

/**
 * Shared syntax-highlighting palette for the `<markdown>` and `<code>`
 * components. Dark-on-default; close enough to GitHub-dark for
 * markdown headings + code fences. Tree-sitter capture names follow
 * the upstream highlight-queries convention (`markup.heading.1`,
 * `keyword`, `string`, …) — fall back to `default` for unmapped
 * captures.
 */
const SYNTAX_STYLE = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromHex('#e6edf3') },
  'markup.heading.1': { fg: RGBA.fromHex('#58a6ff'), bold: true },
  'markup.heading.2': { fg: RGBA.fromHex('#58a6ff'), bold: true },
  'markup.heading.3': { fg: RGBA.fromHex('#58a6ff'), bold: true },
  'markup.list': { fg: RGBA.fromHex('#ff7b72') },
  'markup.bold': { fg: RGBA.fromHex('#e6edf3'), bold: true },
  'markup.italic': { fg: RGBA.fromHex('#e6edf3'), italic: true },
  'markup.raw': { fg: RGBA.fromHex('#a5d6ff') },
  'markup.link': { fg: RGBA.fromHex('#79c0ff'), underline: true },
  keyword: { fg: RGBA.fromHex('#ff7b72') },
  string: { fg: RGBA.fromHex('#a5d6ff') },
  number: { fg: RGBA.fromHex('#79c0ff') },
  function: { fg: RGBA.fromHex('#d2a8ff') },
  comment: { fg: RGBA.fromHex('#8b949e'), italic: true },
  type: { fg: RGBA.fromHex('#ffa657') },
  variable: { fg: RGBA.fromHex('#e6edf3') },
  punctuation: { fg: RGBA.fromHex('#8b949e') },
});

// ─── State machine ───────────────────────────────────────────────────

type Status = 'idle' | 'thinking' | 'streaming' | 'tool' | 'done' | 'error';

export interface ToolCard {
  callId: string;
  name: string;
  args: unknown;
  result?: { ok: boolean; summary?: string };
}

export interface ViewState {
  // Header — set once from session_start + llm_selected. Kept here
  // even though it's mostly static so a single useReducer can own all
  // view state without splitting refs.
  sessionId: string;
  scenario: string;
  llmLabel: string;
  llmFallbackReason?: string;
  promptPreview: string;
  logPath?: string;

  // Per-session accumulators.
  currentTurn: number;
  thinking: string;
  output: string;
  tools: ToolCard[];

  // Footer / status.
  status: Status;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  costUsd: number;
  startedAtMs: number;
  elapsedMs: number;
  errorMessage?: string;

  // UI toggles.
  thinkingCollapsed: boolean;
}

type Action =
  | { type: 'session_start'; sessionId: string; scenario: string; promptPreview: string }
  | { type: 'llm_selected'; label: string; fallbackReason?: string }
  | { type: 'turn_started'; turnNo: number }
  | { type: 'thinking'; chunk: string }
  | { type: 'text'; chunk: string }
  | { type: 'tool_started'; callId: string; name: string; args: unknown }
  | { type: 'tool_finished'; callId: string; ok: boolean; summary?: string }
  | {
      type: 'turn_completed';
      tokensIn: number;
      tokensOut: number;
      tokensCached: number;
      tokensReasoning: number;
      costUsd: number;
    }
  | { type: 'session_end' }
  | { type: 'error'; message: string }
  | { type: 'tick'; nowMs: number }
  | { type: 'toggle_thinking' };

export const initialState: ViewState = {
  sessionId: '',
  scenario: '',
  llmLabel: '',
  promptPreview: '',
  currentTurn: 0,
  thinking: '',
  output: '',
  tools: [],
  status: 'idle',
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  tokensReasoning: 0,
  costUsd: 0,
  startedAtMs: Date.now(),
  elapsedMs: 0,
  thinkingCollapsed: false,
};

export function reduce(s: ViewState, a: Action): ViewState {
  switch (a.type) {
    case 'session_start':
      return {
        ...s,
        sessionId: a.sessionId,
        scenario: a.scenario,
        promptPreview: a.promptPreview,
        status: 'thinking',
        startedAtMs: Date.now(),
      };
    case 'llm_selected':
      return {
        ...s,
        llmLabel: a.label,
        ...(a.fallbackReason ? { llmFallbackReason: a.fallbackReason } : {}),
      };
    case 'turn_started':
      return { ...s, currentTurn: a.turnNo, status: 'thinking' };
    case 'thinking':
      return { ...s, status: 'thinking', thinking: s.thinking + a.chunk };
    case 'text':
      return { ...s, status: 'streaming', output: s.output + a.chunk };
    case 'tool_started':
      return {
        ...s,
        status: 'tool',
        tools: [...s.tools, { callId: a.callId, name: a.name, args: a.args }],
      };
    case 'tool_finished':
      return {
        ...s,
        tools: s.tools.map((t) =>
          t.callId === a.callId
            ? { ...t, result: { ok: a.ok, ...(a.summary ? { summary: a.summary } : {}) } }
            : t,
        ),
      };
    case 'turn_completed':
      return {
        ...s,
        tokensIn: s.tokensIn + a.tokensIn,
        tokensOut: s.tokensOut + a.tokensOut,
        tokensCached: s.tokensCached + a.tokensCached,
        tokensReasoning: s.tokensReasoning + a.tokensReasoning,
        costUsd: s.costUsd + a.costUsd,
      };
    case 'session_end':
      return { ...s, status: 'done' };
    case 'error':
      return { ...s, status: 'error', errorMessage: a.message };
    case 'tick':
      return { ...s, elapsedMs: a.nowMs - s.startedAtMs };
    case 'toggle_thinking':
      return { ...s, thinkingCollapsed: !s.thinkingCollapsed };
    default:
      return s;
  }
}

// ─── Stream ↔ dispatch bridge ────────────────────────────────────────

/**
 * Consume an async iterable of SessionEvents and dispatch reducer
 * actions. Stops on `completed` or `error`. Caller is responsible for
 * passing the cancellation `signal` through if the user aborts.
 */
async function pumpEvents(
  stream: AsyncIterable<SessionEvent>,
  dispatch: (a: Action) => void,
): Promise<void> {
  let turnNo = 0;
  for await (const ev of stream) {
    switch (ev.kind) {
      case 'turn_started':
        turnNo += 1;
        dispatch({ type: 'turn_started', turnNo });
        break;
      case 'thinking':
        dispatch({ type: 'thinking', chunk: ev.chunk });
        break;
      case 'text':
        dispatch({ type: 'text', chunk: ev.chunk });
        break;
      case 'tool_started':
        dispatch({
          type: 'tool_started',
          callId: ev.callId,
          name: ev.name,
          args: ev.args,
        });
        break;
      case 'tool_finished':
        dispatch({
          type: 'tool_finished',
          callId: ev.callId,
          ok: ev.result.ok,
          ...(ev.result.summary ? { summary: ev.result.summary } : {}),
        });
        break;
      case 'turn_completed':
        dispatch({
          type: 'turn_completed',
          tokensIn: ev.metrics.tokensIn,
          tokensOut: ev.metrics.tokensOut,
          tokensCached: ev.metrics.tokensCached,
          tokensReasoning: ev.metrics.tokensReasoning,
          costUsd: ev.metrics.costUsd,
        });
        break;
      case 'error':
        dispatch({ type: 'error', message: ev.message });
        break;
      case 'completed':
        dispatch({ type: 'session_end' });
        return;
    }
  }
}

// ─── Bootstrap props pushed from the CLI ─────────────────────────────

export interface RunViewProps {
  /** Stream of events produced by `session.submit(prompt, signal)`. */
  events: AsyncIterable<SessionEvent>;
  /**
   * Header data the CLI already has at startup. Pushed in once rather
   * than discovered via the event stream — `session_start` event has
   * a subset of this anyway, so the bootstrap props avoid a flash of
   * empty-header content.
   */
  bootstrap: {
    sessionId: string;
    scenario: string;
    llmLabel: string;
    llmFallbackReason?: string;
    promptPreview: string;
    /** Per-session NDJSON log destination, surfaced in FinalSummary. */
    logPath?: string;
  };
  /**
   * Fires when the user is ready to exit — after the session has
   * ended (status `done` / `error`) AND they pressed `q` or
   * `Escape`. The renderer should be destroyed after this fires.
   * If the user hits `q` while the session is still running, the
   * keypress is ignored (we don't have a cancellation handle from
   * inside the view).
   */
  onQuit?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────

/**
 * v0 stub. Phase 4 fills in the actual layout (header, scrollbox of
 * thinking, markdown output, tool cards, footer). For now this just
 * proves the pipe works — reducer dispatch, async-iterable pump, and
 * a single `<box>` showing live status.
 */
export function RunView({ events, bootstrap, onQuit }: RunViewProps) {
  const [state, dispatch] = useReducer(reduce, {
    ...initialState,
    sessionId: bootstrap.sessionId,
    scenario: bootstrap.scenario,
    llmLabel: bootstrap.llmLabel,
    promptPreview: bootstrap.promptPreview,
    ...(bootstrap.llmFallbackReason ? { llmFallbackReason: bootstrap.llmFallbackReason } : {}),
    ...(bootstrap.logPath ? { logPath: bootstrap.logPath } : {}),
  });

  // Pump events into the reducer. Restarts only if the iterator
  // identity changes (it won't, mid-session).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await pumpEvents(events, (a) => {
          if (!cancelled) dispatch(a);
        });
      } catch (err) {
        if (!cancelled) {
          dispatch({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // No onComplete fire here — the TUI stays up after stream end
      // so the user can read the FinalSummary. They exit via `q` /
      // `Escape` (handled below).
    })();
    return () => {
      cancelled = true;
    };
  }, [events]);

  // Elapsed-timer tick — once a second, dispatch a tick so the footer
  // re-renders with a live elapsed counter even when no events fire.
  useEffect(() => {
    if (state.status === 'done' || state.status === 'error') return;
    const id = setInterval(() => dispatch({ type: 'tick', nowMs: Date.now() }), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  // Keyboard:
  //   `t`            — toggle thinking-section visibility (works any time)
  //   `q` / Escape   — exit, but only after the session has ended.
  //                    Pressing q mid-stream is a no-op rather than
  //                    aborting; aborting would need a cancellation
  //                    handle we don't thread through the view today.
  //   Ctrl-C         — handled by the renderer (`exitOnCtrlC: true`)
  //                    in `runWithTui`. Hard exit; runs the post-
  //                    teardown summary path.
  useKeyboard((key) => {
    if (key.name === 't') {
      dispatch({ type: 'toggle_thinking' });
      return;
    }
    if (key.name === 'q' || key.name === 'escape') {
      if (state.status === 'done' || state.status === 'error') onQuit?.();
    }
  });

  const done = state.status === 'done' || state.status === 'error';

  return (
    <box style={{ flexDirection: 'column', padding: 1, gap: 1 }}>
      <Header state={state} />
      <ThinkingSection state={state} dispatch={dispatch} />
      <OutputSection state={state} />
      <ToolsSection state={state} />
      {done ? <FinalSummary state={state} /> : <Footer state={state} />}
    </box>
  );
}

// ─── Sections ────────────────────────────────────────────────────────

/**
 * Header — session id, llm label, prompt preview. Rendered every tick
 * (cheap) so a single component owns the chrome. The data is set once
 * via bootstrap and `llm_selected` and doesn't change again.
 */
function Header({ state }: { state: ViewState }) {
  return (
    <box style={{ border: true, padding: 1, flexDirection: 'column' }}>
      <text>
        <text fg="#888">session  </text>
        {state.sessionId}
      </text>
      <text>
        <text fg="#888">llm      </text>
        {state.llmLabel}
      </text>
      {state.llmFallbackReason ? (
        <text fg="#888">         ({state.llmFallbackReason})</text>
      ) : null}
      <text>
        <text fg="#888">prompt   </text>
        {state.promptPreview}
      </text>
    </box>
  );
}

/**
 * Thinking — accumulates reasoning chunks into a scrollable trace.
 * Hidden until the first chunk arrives. Auto-scrolls to bottom on new
 * content via `stickyScroll`. A char counter in the heading gives a
 * sense of magnitude even when the trace overflows.
 */
function ThinkingSection({
  state,
  dispatch,
}: {
  state: ViewState;
  dispatch: React.Dispatch<Action>;
}) {
  void dispatch; // dispatch isn't used here directly — the `t` keyboard
                  // handler in RunView owns toggling. Accepted as a prop
                  // for future affordances (clickable header, etc.).
  if (state.thinking.length === 0) return null;
  const collapsed = state.thinkingCollapsed;
  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg="#888">
        {collapsed ? '▸' : '▾'} Thinking · {state.thinking.length} chars
        <text fg="#666"> [t to {collapsed ? 'expand' : 'collapse'}]</text>
      </text>
      {collapsed ? null : (
        <scrollbox style={{ height: 8, border: true, padding: 1 }} stickyScroll>
          <text fg="#888">{state.thinking}</text>
        </scrollbox>
      )}
    </box>
  );
}

/**
 * Output — the model's answer rendered as markdown so headings, code
 * fences, and lists land formatted instead of as raw prose. While
 * streaming, partial markdown will re-render mid-construct (open code
 * fence, half a header) — that's expected; the render settles when
 * the chunk completes the syntax.
 */
function OutputSection({ state }: { state: ViewState }) {
  if (state.output.length === 0) {
    return <text fg="#888">  ⠹ waiting for output…</text>;
  }
  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg="#888">Output</text>
      <markdown content={state.output} syntaxStyle={SYNTAX_STYLE} />
    </box>
  );
}

/**
 * Tools — one card per tool call. While in flight, the card shows a
 * spinner; on `tool_finished` it switches to ✓/✗ + summary. Args are
 * rendered as JSON via the `<code>` component so they get
 * syntax-highlighted (useful for big payloads).
 */
function ToolsSection({ state }: { state: ViewState }) {
  if (state.tools.length === 0) return null;
  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg="#888">Tools</text>
      {state.tools.map((t) => (
        <box
          key={t.callId}
          style={{ border: true, padding: 1, flexDirection: 'column' }}
        >
          <text>
            {t.result ? (t.result.ok ? '✓' : '✗') : '⠹'} {t.name}
            {t.result?.summary ? (
              <text fg="#aaa"> · {t.result.summary}</text>
            ) : null}
          </text>
          <code
            content={safeStringify(t.args)}
            filetype="json"
            syntaxStyle={SYNTAX_STYLE}
          />
        </box>
      ))}
    </box>
  );
}

/**
 * Footer — running totals + elapsed timer + status. Updates every
 * 1s via the `tick` action AND on every event. Freezes on
 * `session_end`; the bottom border + `done`/`error` status make the
 * frozen state obvious so the user knows the run is over.
 */
function Footer({ state }: { state: ViewState }) {
  const statusColor =
    state.status === 'error'
      ? '#f55'
      : state.status === 'done'
        ? '#5f5'
        : '#aaa';
  return (
    <box style={{ border: true, padding: 1, flexDirection: 'column' }}>
      <text>
        <text fg={statusColor}>{state.status}</text>
        <text fg="#888"> · turn </text>
        {state.currentTurn || 0}
        <text fg="#888"> · </text>
        {state.tokensIn}+{state.tokensOut} tok
        <text fg="#888"> · $</text>
        {state.costUsd.toFixed(6)}
        <text fg="#888"> · </text>
        {(state.elapsedMs / 1000).toFixed(1)}s
      </text>
      {state.errorMessage ? (
        <text fg="#f55">error: {state.errorMessage}</text>
      ) : null}
    </box>
  );
}

/**
 * Final summary — replaces the live Footer once status flips to
 * `done` or `error`. Shows the full token breakdown (cached +
 * reasoning surfaced separately so the user understands provider
 * cost composition), elapsed time, log path, and exit status.
 *
 * Visible only briefly today — runWithTui awaits `onComplete` then
 * immediately destroys the renderer. Phase 6 will keep the TUI alive
 * until the user presses `q`, at which point this is what they read.
 */
function FinalSummary({ state }: { state: ViewState }) {
  const statusColor = state.status === 'error' ? '#f55' : '#5f5';
  const tokensTotal = state.tokensIn + state.tokensOut;
  return (
    <box style={{ border: true, padding: 1, flexDirection: 'column' }}>
      <text>
        <text fg={statusColor}>
          {state.status === 'error' ? '✗ Session failed' : '✓ Session complete'}
        </text>
      </text>
      <text> </text>
      <text>
        <text fg="#888">turns      </text>
        {state.currentTurn || 0}
      </text>
      <text>
        <text fg="#888">tokens     </text>
        {formatNum(tokensTotal)}
        <text fg="#888"> (in {formatNum(state.tokensIn)} · out {formatNum(state.tokensOut)}</text>
        {state.tokensCached > 0 ? (
          <text fg="#888"> · cached {formatNum(state.tokensCached)}</text>
        ) : null}
        {state.tokensReasoning > 0 ? (
          <text fg="#888"> · reasoning {formatNum(state.tokensReasoning)}</text>
        ) : null}
        <text fg="#888">)</text>
      </text>
      <text>
        <text fg="#888">cost       </text>
        ${state.costUsd.toFixed(6)}
      </text>
      <text>
        <text fg="#888">elapsed    </text>
        {(state.elapsedMs / 1000).toFixed(1)}s
      </text>
      {state.logPath ? (
        <text>
          <text fg="#888">log        </text>
          {state.logPath}
        </text>
      ) : null}
      {state.errorMessage ? (
        <text fg="#f55">error: {state.errorMessage}</text>
      ) : null}
      <text> </text>
      <text fg="#666">Press q or Esc to exit · t to toggle thinking</text>
    </box>
  );
}

// ─── Utilities ───────────────────────────────────────────────────────

/** US-style thousands separator. Cheap; no Intl. */
function formatNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
