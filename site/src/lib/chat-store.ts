import type { TraceEvent, TurnDetails } from '@inbrowser/agent';
import type { ContextWindowTraceHostContext } from '@inbrowser/agent/usage';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStep, AgentTurnMetrics, VisitedCard } from './agent-types';

/**
 * Client-side chat persistence. Sessions + messages live in localStorage
 * (no backend, no auth) under a versioned key. A `useChatStore` hook
 * exposes the sessions plus immutable mutators; writes are debounced so
 * per-token streaming updates don't thrash localStorage.
 *
 * The active session id is mirrored in a ref so the streaming mutators
 * (which fire rapidly within one handler) never read a stale closure
 * value right after a session was created.
 */

const STORAGE_KEY = 'inbrowser-docs-chat:v1';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  cards?: VisitedCard[];
  /** The agent's tool-call activity log for this turn (persisted). */
  steps?: AgentStep[];
  /** What produced this answer, e.g. "cloud · Gemini" or
   *  "on-device · SmolLM2 360M · webgpu". Stamped on the assistant turn so
   *  there's never ambiguity about which path ran. */
  source?: string;
  /** Agent-runtime turn id. Used to correlate provider request traces and usage
   *  rows with this visible assistant message. */
  turnId?: string;
  /** Whole-turn token/cost metrics, accumulated across all provider requests. */
  metrics?: AgentTurnMetrics;
  /** Provider/model details reported by the agent runtime. */
  details?: TurnDetails;
  /** Provider-visible request/response trace events for this assistant turn. */
  traceEvents?: TraceEvent[];
  /** Host labels captured with the trace, e.g. provider/model/strategy. */
  traceHostContext?: ContextWindowTraceHostContext;
  /** Durable-jobs id for a CLOUD turn (the agent loop runs in the job worker,
   *  not inline). Persisted so a reload / another tab can RESUBSCRIBE to the
   *  same job and replay its stream from `lastSeq`. Absent on the on-device
   *  inline path (which has no durable job). */
  jobId?: string;
  /** Highest durable-event `seq` (a 0-based event index) already applied to this
   *  turn's text/steps/cards. A resubscribe passes `{ from: (lastSeq ?? -1) + 1 }`
   *  so it replays only what this turn hasn't seen yet (no double-applied tokens).
   *  UNDEFINED = nothing seen (resume from 0), distinct from 0 = event 0 applied. */
  lastSeq?: number;
  /** Whether this turn's job reached a terminal status (done/error). A resub only
   *  fires for a NON-terminal turn, so a completed cloud answer doesn't re-stream. */
  jobDone?: boolean;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatTurn[];
}

function isSession(x: unknown): x is Session {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.title === 'string' &&
    typeof s.createdAt === 'number' &&
    typeof s.updatedAt === 'number' &&
    Array.isArray(s.messages) &&
    s.messages.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.text === 'string',
    )
  );
}

function load(): Session[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    // Drop anything that doesn't match the expected shape (hand-edited /
    // corrupted / version-skewed storage).
    return sessions.filter(isSession);
  } catch {
    return [];
  }
}

function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 48 ? `${t.slice(0, 48)}…` : t || 'New chat';
}

// Short, URL-friendly session id (7 base36 chars), so chat URLs stay readable.
// Collisions are vanishingly unlikely for the handful of sessions a browser holds.
const uid = () => Math.random().toString(36).slice(2, 9).padEnd(7, '0');

function blankSession(): Session {
  const now = Date.now();
  return { id: uid(), title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
}

export interface ChatStore {
  sessions: Session[];
  activeId: string | null;
  active: Session | null;
  newSession(): void;
  /** Select a session, or `null` for the home (empty) state. */
  selectSession(id: string | null): void;
  deleteSession(id: string): void;
  /** Ensure an active session exists and return its id (synchronous). */
  ensureActiveId(): string;
  /** Append a user turn to a specific session. */
  addUserTurn(id: string, text: string): void;
  /** Append assistant text to a session, creating the assistant turn on
   *  first call (so an aborted/errored stream never leaves an empty turn). */
  appendAssistantText(id: string, text: string): void;
  /** Add a source card to a session's assistant turn (created lazily). */
  addAssistantCard(id: string, card: VisitedCard): void;
  /** Append a tool-call step to a session's assistant turn (created lazily). */
  addAssistantStep(id: string, step: AgentStep): void;
  /** Stamp the assistant turn with what produced it (created lazily). */
  setAssistantSource(id: string, source: string): void;
  /** Stamp the assistant turn with the runtime turn id (created lazily). */
  setAssistantTurnId(id: string, turnId: string): void;
  /** Add a trace event to the assistant turn (created lazily). */
  addAssistantTrace(
    id: string,
    event: TraceEvent,
    hostContext?: ContextWindowTraceHostContext,
  ): void;
  /** Store accumulated whole-turn usage on the assistant turn (created lazily). */
  setAssistantUsage(
    id: string,
    turnId: string,
    metrics: AgentTurnMetrics,
    details: TurnDetails,
  ): void;
  /** Attach the durable-jobs id to the assistant turn (created lazily), so a
   *  reload / another tab can resubscribe to the same job. Resets the durable
   *  cursor for a fresh job (`lastSeq` cleared = nothing applied, not done). */
  setAssistantJob(id: string, jobId: string): void;
  /** Advance the assistant turn's durable cursor to the highest seq it has
   *  applied (no-op if it would move backwards). */
  setAssistantSeq(id: string, seq: number): void;
  /** Mark the assistant turn's job terminal (done/error), so a future mount
   *  won't resubscribe to a completed cloud answer. */
  setAssistantJobDone(id: string): void;
  /** Clear the trailing assistant turn's answer (text/steps/cards/job fields) so
   *  a fresh "Continue" job streams into a clean turn. Keeps the turn in place. */
  resetAssistantTurn(id: string): void;
  // jobId-targeted variants for the durable resubscribe path (address the turn
  // by its jobId, not by position):
  appendAssistantTextForJob(id: string, jobId: string, text: string): void;
  addAssistantCardForJob(id: string, jobId: string, card: VisitedCard): void;
  addAssistantStepForJob(id: string, jobId: string, step: AgentStep): void;
  setAssistantTurnIdForJob(id: string, jobId: string, turnId: string): void;
  addAssistantTraceForJob(
    id: string,
    jobId: string,
    event: TraceEvent,
    hostContext?: ContextWindowTraceHostContext,
  ): void;
  setAssistantUsageForJob(
    id: string,
    jobId: string,
    turnId: string,
    metrics: AgentTurnMetrics,
    details: TurnDetails,
  ): void;
  setAssistantSeqForJob(id: string, jobId: string, seq: number): void;
  setAssistantJobDoneForJob(id: string, jobId: string): void;
}

export function useChatStore(): ChatStore {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const loaded = useRef(false);

  const setActive = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveIdState(id);
  }, []);

  // Load once on mount (client only). The active session is taken from the URL
  // path (`/c/<id>`), so `/` lands on the home/empty state and a chat link
  // restores its conversation.
  useEffect(() => {
    const s = load();
    setSessions(s);
    const urlId =
      typeof window === 'undefined'
        ? null
        : (window.location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? null);
    setActive(urlId && s.some((x) => x.id === urlId) ? urlId : null);
    loaded.current = true;
  }, [setActive]);

  // Keep the latest sessions in a ref so the unload handler can flush
  // synchronously without re-registering.
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;

  const persist = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions: sessionsRef.current }));
    } catch {
      /* quota / private mode — ignore */
    }
  }, []);

  // Debounced persist on change. `sessions` is the intentional change trigger:
  // the effect re-runs to debounce a persist whenever sessions mutate, and the
  // body calls persist (which reads the latest via sessionsRef).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessions is the change trigger
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(persist, 400);
    return () => clearTimeout(t);
  }, [sessions, persist]);

  // Flush immediately when the tab is hidden/closed so a fast reload
  // within the debounce window doesn't lose the last change.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') persist();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', persist);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', persist);
    };
  }, [persist]);

  const touch = useCallback((id: string, fn: (s: Session) => Session) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...fn(s), updatedAt: Date.now() } : s)));
  }, []);

  const newSession = useCallback(() => {
    const s = blankSession();
    setSessions((prev) => [s, ...prev]);
    setActive(s.id);
  }, [setActive]);

  const selectSession = useCallback((id: string | null) => setActive(id), [setActive]);

  const deleteSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (activeIdRef.current === id) setActive(next[0]?.id ?? null);
        return next;
      });
    },
    [setActive],
  );

  /** Ensure an active session exists; return its id synchronously. */
  const ensureActive = useCallback((): string => {
    if (activeIdRef.current) return activeIdRef.current;
    const s = blankSession();
    setSessions((prev) => [s, ...prev]);
    setActive(s.id);
    return s.id;
  }, [setActive]);

  const addUserTurn = useCallback(
    (id: string, text: string) => {
      touch(id, (s) => ({
        ...s,
        title: s.messages.length === 0 ? titleFrom(text) : s.title,
        messages: [...s.messages, { role: 'user', text }],
      }));
    },
    [touch],
  );

  // Ensure the session's trailing turn is an assistant turn, then mutate
  // it. Creating it lazily means a stream that produces nothing (abort /
  // early error) never leaves a dangling empty assistant block.
  const mutateAssistant = useCallback(
    (id: string, fn: (turn: ChatTurn) => ChatTurn) => {
      touch(id, (s) => {
        const messages = s.messages.slice();
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          messages[messages.length - 1] = fn(last);
        } else {
          messages.push(fn({ role: 'assistant', text: '' }));
        }
        return { ...s, messages };
      });
    },
    [touch],
  );

  // Mutate the assistant turn that OWNS a given jobId (no positional guess, no
  // lazy creation). Used by the durable RESUBSCRIBE path so a replayed stream
  // can't contaminate a different turn if the session shape shifted; a no-op if
  // no turn carries the jobId (e.g. the turn was deleted between mount + replay).
  const mutateAssistantByJob = useCallback(
    (id: string, jobId: string, fn: (turn: ChatTurn) => ChatTurn) => {
      touch(id, (s) => ({
        ...s,
        messages: s.messages.map((m) => (m.role === 'assistant' && m.jobId === jobId ? fn(m) : m)),
      }));
    },
    [touch],
  );

  const appendAssistantText = useCallback(
    (id: string, text: string) => {
      mutateAssistant(id, (t) => ({ ...t, text: t.text + text }));
    },
    [mutateAssistant],
  );

  const addAssistantCard = useCallback(
    (id: string, card: VisitedCard) => {
      mutateAssistant(id, (t) => {
        const cards = t.cards ?? [];
        if (cards.some((c) => c.route === card.route)) return t;
        return { ...t, cards: [...cards, card] };
      });
    },
    [mutateAssistant],
  );

  const addAssistantStep = useCallback(
    (id: string, step: AgentStep) => {
      mutateAssistant(id, (t) => ({ ...t, steps: [...(t.steps ?? []), step] }));
    },
    [mutateAssistant],
  );

  const setAssistantSource = useCallback(
    (id: string, source: string) => {
      mutateAssistant(id, (t) => ({ ...t, source }));
    },
    [mutateAssistant],
  );

  const setAssistantTurnId = useCallback(
    (id: string, turnId: string) => {
      mutateAssistant(id, (t) => ({ ...t, turnId }));
    },
    [mutateAssistant],
  );

  const addAssistantTrace = useCallback(
    (id: string, event: TraceEvent, hostContext?: ContextWindowTraceHostContext) => {
      mutateAssistant(id, (t) => ({
        ...t,
        traceEvents: [...(t.traceEvents ?? []), event],
        ...(hostContext ? { traceHostContext: hostContext } : {}),
      }));
    },
    [mutateAssistant],
  );

  const setAssistantUsage = useCallback(
    (id: string, turnId: string, metrics: AgentTurnMetrics, details: TurnDetails) => {
      mutateAssistant(id, (t) => ({ ...t, turnId, metrics, details }));
    },
    [mutateAssistant],
  );

  const setAssistantJob = useCallback(
    (id: string, jobId: string) => {
      // A fresh job → reset the durable cursor. `lastSeq` is the highest applied
      // 0-based event index; UNDEFINED means "nothing applied" (resume `from: 0`),
      // distinct from 0 which means "event index 0 was applied".
      mutateAssistant(id, (t) => ({ ...t, jobId, lastSeq: undefined, jobDone: false }));
    },
    [mutateAssistant],
  );

  const setAssistantSeq = useCallback(
    (id: string, seq: number) => {
      // Monotonic: never move the cursor backwards (out-of-order / replayed event).
      // `?? -1` so the first event (seq 0) advances from "nothing applied".
      mutateAssistant(id, (t) => (seq > (t.lastSeq ?? -1) ? { ...t, lastSeq: seq } : t));
    },
    [mutateAssistant],
  );

  const setAssistantJobDone = useCallback(
    (id: string) => {
      mutateAssistant(id, (t) => ({ ...t, jobDone: true }));
    },
    [mutateAssistant],
  );

  const resetAssistantTurn = useCallback(
    (id: string) => {
      // Keep the role + source; drop the partial answer and all job state so a
      // fresh job streams cleanly (and the old jobId stops matching any setter).
      mutateAssistant(id, (t) => ({
        role: 'assistant',
        text: '',
        source: t.source,
      }));
    },
    [mutateAssistant],
  );

  // ── jobId-targeted setters (durable resubscribe) ───────────────────────────
  // Same effects as the trailing-turn setters above, but addressed by jobId so a
  // replayed stream lands on its own turn regardless of position.
  const appendAssistantTextForJob = useCallback(
    (id: string, jobId: string, text: string) => {
      mutateAssistantByJob(id, jobId, (t) => ({ ...t, text: t.text + text }));
    },
    [mutateAssistantByJob],
  );

  const addAssistantCardForJob = useCallback(
    (id: string, jobId: string, card: VisitedCard) => {
      mutateAssistantByJob(id, jobId, (t) => {
        const cards = t.cards ?? [];
        if (cards.some((c) => c.route === card.route)) return t;
        return { ...t, cards: [...cards, card] };
      });
    },
    [mutateAssistantByJob],
  );

  const addAssistantStepForJob = useCallback(
    (id: string, jobId: string, step: AgentStep) => {
      mutateAssistantByJob(id, jobId, (t) => ({ ...t, steps: [...(t.steps ?? []), step] }));
    },
    [mutateAssistantByJob],
  );

  const setAssistantTurnIdForJob = useCallback(
    (id: string, jobId: string, turnId: string) => {
      mutateAssistantByJob(id, jobId, (t) => ({ ...t, turnId }));
    },
    [mutateAssistantByJob],
  );

  const addAssistantTraceForJob = useCallback(
    (id: string, jobId: string, event: TraceEvent, hostContext?: ContextWindowTraceHostContext) => {
      mutateAssistantByJob(id, jobId, (t) => ({
        ...t,
        traceEvents: [...(t.traceEvents ?? []), event],
        ...(hostContext ? { traceHostContext: hostContext } : {}),
      }));
    },
    [mutateAssistantByJob],
  );

  const setAssistantUsageForJob = useCallback(
    (
      id: string,
      jobId: string,
      turnId: string,
      metrics: AgentTurnMetrics,
      details: TurnDetails,
    ) => {
      mutateAssistantByJob(id, jobId, (t) => ({ ...t, turnId, metrics, details }));
    },
    [mutateAssistantByJob],
  );

  const setAssistantSeqForJob = useCallback(
    (id: string, jobId: string, seq: number) => {
      // `?? -1` so the first event (seq 0) advances from "nothing applied".
      mutateAssistantByJob(id, jobId, (t) =>
        seq > (t.lastSeq ?? -1) ? { ...t, lastSeq: seq } : t,
      );
    },
    [mutateAssistantByJob],
  );

  const setAssistantJobDoneForJob = useCallback(
    (id: string, jobId: string) => {
      mutateAssistantByJob(id, jobId, (t) => ({ ...t, jobDone: true }));
    },
    [mutateAssistantByJob],
  );

  const active = sessions.find((s) => s.id === activeId) ?? null;

  return {
    sessions,
    activeId,
    active,
    newSession,
    selectSession,
    deleteSession,
    ensureActiveId: ensureActive,
    addUserTurn,
    appendAssistantText,
    addAssistantCard,
    addAssistantStep,
    setAssistantSource,
    setAssistantTurnId,
    addAssistantTrace,
    setAssistantUsage,
    setAssistantJob,
    setAssistantSeq,
    setAssistantJobDone,
    resetAssistantTurn,
    appendAssistantTextForJob,
    addAssistantCardForJob,
    addAssistantStepForJob,
    setAssistantTurnIdForJob,
    addAssistantTraceForJob,
    setAssistantUsageForJob,
    setAssistantSeqForJob,
    setAssistantJobDoneForJob,
  };
}
