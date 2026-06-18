import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStep, VisitedCard } from './agent-types';

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
  };
}
