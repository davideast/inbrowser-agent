/**
 * `createAgentSession()` — the host-facing session container.
 *
 * Generic over the strategy. Translates a `StrategyEvent` stream
 * into the typed `SessionEvent` stream the host consumes. Tracks
 * workspace + runtime patches as tool results flow in.
 */

import type {
  AgentSession,
  AgentSessionConfig,
  SessionEvent,
} from './types/session.js';
import type { ChatMessage } from './types/chat.js';
import type { RuntimeState } from './types/runtime.js';
import type { StrategyEvent } from './types/strategy.js';
import type { Workspace } from './types/workspace.js';
import type { ToolResult } from './types/tools.js';

let sessionCounter = 0;

export function createAgentSession(config: AgentSessionConfig): AgentSession {
  const id = config.id ?? `session-${++sessionCounter}-${Date.now().toString(36)}`;
  let workspace: Workspace = freezeWorkspace(config.history.length > 0 ? extractInitialWorkspace(config) : initialWorkspace());
  let runtime: RuntimeState = initialRuntime();
  let history: ChatMessage[] = [...config.history];
  let currentAbort: AbortController | null = null;

  const session: AgentSession = {
    id,
    get workspace() { return workspace; },
    get runtime() { return runtime; },
    submit(prompt, externalSignal): AsyncIterable<SessionEvent> {
      // Compose an internal controller that listens to both the
      // external signal and our `cancel()` override.
      const inner = new AbortController();
      currentAbort = inner;
      const linked = linkSignals(externalSignal, inner.signal);
      return run(prompt, linked);
    },
    cancel() {
      currentAbort?.abort();
    },
  };

  function bumpWorkspace(patch: Partial<Workspace> | undefined): boolean {
    if (!patch) return false;
    workspace = freezeWorkspace({ ...workspace, ...patch });
    return true;
  }
  function bumpRuntime(patch: Partial<RuntimeState> | undefined): boolean {
    if (!patch) return false;
    runtime = freezeRuntime({ ...runtime, ...patch });
    return true;
  }

  async function* run(prompt: string, signal: AbortSignal): AsyncIterable<SessionEvent> {
    const turnId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    yield { kind: 'turn_started', turnId };

    // Capture the user message in history so the next turn sees it.
    const userMsg: ChatMessage = {
      id: `u-${turnId}`,
      role: 'user',
      text: prompt,
      timestamp: Date.now(),
    };
    history = [...history, userMsg];

    const systemPrompt = config.systemPromptBuilder(workspace, runtime);

    const strategyEvents = config.strategy.run({
      prompt,
      history,
      workspace,
      runtime,
      llm: config.llm,
      tools: config.tools,
      toolList: config.toolList,
      toolContext: config.toolContext,
      systemPrompt,
      ...(config.tracer ? { tracer: config.tracer } : {}),
      turnId,
    }, signal);

    let assistantText = '';
    const assistantId = `a-${turnId}`;

    for await (const ev of strategyEvents as AsyncIterable<StrategyEvent>) {
      if (ev.kind === 'text') {
        assistantText += ev.chunk;
        yield { kind: 'text', turnId, chunk: ev.chunk };
      } else if (ev.kind === 'thinking') {
        yield { kind: 'thinking', turnId, chunk: ev.chunk };
      } else if (ev.kind === 'tool_call') {
        yield {
          kind: 'tool_started',
          turnId,
          callId: ev.id,
          name: ev.name,
          args: ev.args,
          ...(ev.signature ? { signature: ev.signature } : {}),
        };
      } else if (ev.kind === 'tool_result') {
        const wsBumped = bumpWorkspace((ev.result as ToolResult).workspacePatch);
        const rtBumped = bumpRuntime((ev.result as ToolResult).runtimePatch);
        yield { kind: 'tool_finished', turnId, callId: ev.id, result: ev.result };
        if (wsBumped) yield { kind: 'workspace_changed', workspace };
        if (rtBumped) yield { kind: 'runtime_changed', runtime };
      } else if (ev.kind === 'turn_complete') {
        const metrics = config.metrics.recordTurn({
          llmId: config.llm.id,
          model: ev.details.requestedModel,
          durationMs: 0,
          rawUsage: ev.usage,
        });
        // Append assistant message to history.
        const assistantMsg: ChatMessage = {
          id: assistantId,
          role: 'assistant',
          text: assistantText,
          metrics,
          details: ev.details,
          timestamp: Date.now(),
        };
        history = [...history, assistantMsg];
        yield { kind: 'turn_completed', turnId, metrics, details: ev.details };
      } else if (ev.kind === 'error') {
        yield { kind: 'error', turnId, message: ev.message };
        return;
      } else if (ev.kind === 'custom') {
        yield { kind: 'strategy_event', name: ev.name, data: ev.data };
      }
    }

    yield { kind: 'completed' };
  }

  return session;
}

function initialWorkspace(): Workspace {
  return freezeWorkspace({
    presetId: '',
    rules: '',
    code: '',
    appSource: '',
    stitch: { projectId: null, latestScreenUrl: null, brief: null },
  });
}

function extractInitialWorkspace(config: AgentSessionConfig): Workspace {
  // History-only resume — workspace can be threaded in by the caller
  // via a follow-up patch, but the session's initial workspace shape
  // matches the empty defaults until then.
  void config;
  return initialWorkspace();
}

function initialRuntime(): RuntimeState {
  return freezeRuntime({
    terminal: [],
    runSummary: null,
    deploy: null,
    parseError: null,
    uiErrors: [],
    sandboxVersion: 0,
  });
}

function freezeWorkspace(w: Workspace): Workspace {
  return Object.freeze({ ...w, stitch: Object.freeze({ ...w.stitch }) }) as Workspace;
}

function freezeRuntime(r: RuntimeState): RuntimeState {
  return Object.freeze({
    ...r,
    terminal: Object.freeze([...r.terminal]) as unknown as RuntimeState['terminal'],
    uiErrors: Object.freeze([...r.uiErrors]) as unknown as RuntimeState['uiErrors'],
  }) as RuntimeState;
}

/** Combine two abort signals into one that fires when either fires. */
function linkSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  a.addEventListener('abort', () => controller.abort(), { once: true });
  b.addEventListener('abort', () => controller.abort(), { once: true });
  return controller.signal;
}
