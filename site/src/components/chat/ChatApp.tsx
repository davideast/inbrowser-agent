import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../../lib/chat-store';
import { streamAgent } from '../../lib/stream-client';
import { getSuggestions } from '../../lib/suggestions';
import { PackageCards } from '../PackageCards';
import { PoweredByStrip } from '../PoweredByStrip';
import { SiteHeader } from '../SiteHeader';
import { ChatSidebar } from './ChatSidebar';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';

/** Centered docs chat: a prompt box to begin, an in-flow composer, and a
 *  toggle-only session drawer. */
export function ChatApp() {
  const store = useChatStore();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Which package is working right now, for the powered-by strip. `agent` while
  // a lookup/tool step runs, `relay` while tokens stream.
  const [phase, setPhase] = useState<'agent' | 'relay' | null>(null);
  const [error, setError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const messages = store.active?.messages ?? [];
  const hasMessages = messages.length > 0;

  // Empty-state chips: cold-start orientation for a first-time user, else
  // "learn more" suggestions derived from their prior questions across sessions.
  const suggestions = useMemo(() => getSuggestions(store.sessions), [store.sessions]);

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  // Focus the composer on mount.
  useEffect(() => focusComposer(), [focusComposer]);

  // Pin to bottom while streaming, but only if the user hasn't scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on content growth
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const finalize = useCallback(() => {
    setBusy(false);
    setPhase(null);
    abortRef.current = null;
  }, []);

  // Reflect the active session in the URL, so Back escapes a conversation, a
  // chat is linkable, and a refresh restores it. `/` is the home (empty) state.
  const setUrl = useCallback((id: string | null, mode: 'push' | 'replace') => {
    const url = id ? `/?c=${encodeURIComponent(id)}` : '/';
    if (url === window.location.pathname + window.location.search) return;
    window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
  }, []);

  const send = useCallback(
    async (explicit?: string) => {
      const text = (explicit ?? input).trim();
      if (!text || busy) return;

      // Snapshot prior conversation before mutating; route all streaming
      // writes to this captured session id (a mid-stream session switch
      // can't corrupt another session).
      const convo = [
        ...(store.active?.messages ?? []).map((m) => ({ role: m.role, text: m.text })),
        { role: 'user' as const, text },
      ];
      const sid = store.ensureActiveId();
      store.addUserTurn(sid, text);
      setUrl(sid, 'push');

      setInput('');
      setError('');
      setBusy(true);
      setPhase('agent');
      atBottomRef.current = true;

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        await streamAgent(
          '/api/chat',
          { messages: convo },
          {
            onToken: (t) => {
              setPhase('relay');
              store.appendAssistantText(sid, t);
            },
            onTool: (name, detail) => {
              setPhase('agent');
              store.addAssistantStep(sid, { name, detail });
            },
            onVisited: (card) => store.addAssistantCard(sid, card),
            onError: (message) => {
              setError(message);
              finalize();
            },
            onDone: finalize,
          },
          ctrl.signal,
        );
        finalize();
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          finalize();
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
        finalize();
      }
    },
    [input, busy, store, finalize, setUrl],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    finalize();
  }, [finalize]);

  const switchTo = useCallback(
    (id: string) => {
      abortRef.current?.abort();
      finalize();
      setError('');
      store.selectSession(id);
      setUrl(id, 'push');
      setDrawerOpen(false);
      focusComposer();
    },
    [store, finalize, focusComposer, setUrl],
  );

  // Go to the home (empty) state. With URL state, "empty" is simply no active
  // session (the URL becomes `/`); sending creates the session lazily, so this
  // never piles up blank sessions. Used by the wordmark and "new chat".
  const goEmpty = useCallback(() => {
    abortRef.current?.abort();
    finalize();
    setError('');
    store.selectSession(null);
    setUrl(null, 'push');
    setDrawerOpen(false);
    focusComposer();
  }, [store, finalize, focusComposer, setUrl]);

  // Sync the active session when the user navigates with Back/Forward.
  // biome-ignore lint/correctness/useExhaustiveDependencies: store identity is stable enough; re-subscribing per render is harmless
  useEffect(() => {
    const onPop = () => {
      abortRef.current?.abort();
      finalize();
      setError('');
      const id = new URLSearchParams(window.location.search).get('c');
      store.selectSession(id && store.sessions.some((s) => s.id === id) ? id : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [store, finalize]);

  return (
    <div className="h-dvh flex flex-col">
      <SiteHeader onMenu={() => setDrawerOpen((o) => !o)} menuOpen={drawerOpen} onHome={goEmpty} />

      {drawerOpen ? (
        <button
          type="button"
          aria-label="Close sessions"
          className="fixed inset-0 z-20 bg-bg/70"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}
      <ChatSidebar
        open={drawerOpen}
        sessions={store.sessions}
        activeId={store.activeId}
        onSelect={switchTo}
        onNew={goEmpty}
        onDelete={store.deleteSession}
        onClose={() => setDrawerOpen(false)}
      />

      {hasMessages ? (
        <>
          <PoweredByStrip
            agentLive={busy && phase === 'agent'}
            relayLive={busy && phase === 'relay'}
          />
          {/* Scroll the conversation; the composer is docked below so it is
              always fully visible (no mid-screen float, no mobile-toolbar clip). */}
          <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
            <div className="max-w-[760px] mx-auto px-4 md:px-6 py-8">
              <ChatThread messages={messages} busy={busy} error={error} />
            </div>
          </main>
          <div className="shrink-0 border-t border-border bg-bg">
            <div className="max-w-[760px] mx-auto px-4 md:px-6 py-3">
              <Composer
                inputRef={composerRef}
                value={input}
                onChange={setInput}
                onSend={() => send()}
                onStop={stop}
                busy={busy}
              />
            </div>
          </div>
        </>
      ) : (
        <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
          <div className="max-w-[760px] mx-auto px-4 md:px-6 pt-[12vh] pb-20">
            <div className="mb-5">
              <span className="text-[11px] font-medium uppercase tracking-widest text-label leading-none">
                The in-browser AI stack
              </span>
            </div>
            <h1 className="text-[32px] md:text-[40px] leading-[1.1] tracking-[-0.02em] font-normal text-primary mb-4">
              Resumable, grounded AI in the browser
            </h1>
            <p className="text-secondary text-[14px] leading-[1.75] mb-8 max-w-[54ch]">
              This assistant is built on it: the agent runs the lookup and the relay streams the
              answer, grounded in these docs. Ask it anything about the packages.
            </p>
            <Composer
              inputRef={composerRef}
              value={input}
              onChange={setInput}
              onSend={() => send()}
              onStop={stop}
              busy={busy}
            />
            <div className="mt-8 flex flex-wrap gap-2">
              {suggestions.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => send(ex)}
                  className="text-left text-[12px] text-secondary hover:text-primary border border-border hover:border-border-strong px-3 py-2 transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>

            <div className="mt-16">
              <h2 className="text-[11px] font-medium uppercase tracking-widest text-label mb-5">
                Browse the packages
              </h2>
              <PackageCards />
              <div className="mt-4 text-right">
                <a
                  href="/docs"
                  className="text-[12px] text-dim-text hover:text-primary transition-colors"
                >
                  all docs <span aria-hidden="true">→</span>
                </a>
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
