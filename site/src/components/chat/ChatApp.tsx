import type { LoadProgress } from '@inbrowser/model';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../../lib/chat-store';
import {
  type OnDevicePreset,
  PRESET_META,
  hasWebGPU,
  loadOnDeviceEngine,
  streamOnDeviceAgent,
} from '../../lib/on-device-agent';
import { type AgentStreamHandlers, streamAgent } from '../../lib/stream-client';
import { getSuggestions } from '../../lib/suggestions';
import { PackageCards } from '../PackageCards';
import { PoweredByStrip } from '../PoweredByStrip';
import { SiteHeader } from '../SiteHeader';
import { ChatSidebar } from './ChatSidebar';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';

type ModelStatus =
  | { phase: 'idle' }
  | { phase: 'loading'; detail: string }
  | { phase: 'ready'; backend: string }
  | { phase: 'error'; msg: string };

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
  const [onDevice, setOnDevice] = useState(false);
  const [preset, setPreset] = useState<OnDevicePreset>('smollm2_360m');
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ phase: 'idle' });
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
    // preventScroll: focusing the composer must not yank the page. On the
    // landing the hero should stay in view, not get scrolled past.
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  }, []);

  // Focus the composer on mount.
  useEffect(() => focusComposer(), [focusComposer]);

  // Pin to the latest while streaming, but only in a conversation and only if
  // the user hasn't scrolled up. The empty-state landing must stay at the top
  // (hero first), never jump to the bottom (the package cards).
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on content growth
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current && hasMessages) el.scrollTop = el.scrollHeight;
  }, [messages, busy, hasMessages]);

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
    const url = id ? `/c/${id}` : '/';
    if (url === window.location.pathname) return;
    window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
  }, []);

  // Download + compile the chosen on-device preset (in a Web Worker). The
  // weights (~180-350 MB) are fetched once, then cached for instant reloads.
  const loadModel = useCallback(async () => {
    setModelStatus({ phase: 'loading', detail: 'starting…' });
    const backend = hasWebGPU() ? 'webgpu' : 'wasm';
    try {
      await loadOnDeviceEngine(preset, {
        onProgress: (p: LoadProgress) => {
          if (p.phase === 'fetch') {
            const pct = p.totalBytes ? Math.round((p.loadedBytes / p.totalBytes) * 100) : 0;
            const file = p.file.split('/').pop() ?? p.file;
            setModelStatus({ phase: 'loading', detail: `downloading ${file} ${pct}%` });
          } else if (p.phase === 'init') {
            // The engine reports the configured backend ('auto'); show the
            // resolved one we inferred from WebGPU presence instead.
            setModelStatus({ phase: 'loading', detail: `compiling (${backend})…` });
          } else if (p.phase === 'warmup') {
            setModelStatus({ phase: 'loading', detail: 'warming up…' });
          }
        },
      });
      setModelStatus({ phase: 'ready', backend });
    } catch (e) {
      setModelStatus({ phase: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }, [preset]);

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

      if (onDevice && modelStatus.phase !== 'ready') {
        setError('Load the on-device model first (use the bar above).');
        finalize();
        return;
      }

      // Stamp the answer with what produced it, so it is never ambiguous which
      // path (and which on-device model + backend) ran for this turn.
      const backend = modelStatus.phase === 'ready' ? modelStatus.backend : '';
      const source = onDevice
        ? `on-device · ${PRESET_META[preset].label}${backend ? ` · ${backend}` : ''}`
        : 'cloud · Gemini';
      let sourced = false;
      const stampSource = () => {
        if (!sourced) {
          sourced = true;
          store.setAssistantSource(sid, source);
        }
      };

      const handlers: AgentStreamHandlers = {
        onToken: (t) => {
          stampSource();
          setPhase('relay');
          store.appendAssistantText(sid, t);
        },
        onTool: (name, detail) => {
          stampSource();
          setPhase('agent');
          store.addAssistantStep(sid, { name, detail });
        },
        onVisited: (card) => store.addAssistantCard(sid, card),
        onError: (message) => {
          setError(message);
          finalize();
        },
        onDone: finalize,
      };

      try {
        if (onDevice) {
          // Run the agent entirely in the browser: retrieval strategy + the
          // on-device engine, no server round-trip.
          await streamOnDeviceAgent(
            text,
            convo.slice(0, -1) as { role: 'user' | 'assistant'; text: string }[],
            handlers,
            ctrl.signal,
          );
        } else {
          await streamAgent('/api/chat', { messages: convo }, handlers, ctrl.signal);
        }
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
    [input, busy, store, finalize, setUrl, onDevice, preset, modelStatus],
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
      const id = window.location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? null;
      store.selectSession(id && store.sessions.some((s) => s.id === id) ? id : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [store, finalize]);

  return (
    <div className="h-dvh flex flex-col">
      <SiteHeader onMenu={() => setDrawerOpen((o) => !o)} menuOpen={drawerOpen} onHome={goEmpty} />

      <OnDeviceBar
        onDevice={onDevice}
        onToggle={setOnDevice}
        preset={preset}
        onPreset={(p) => {
          setPreset(p);
          setModelStatus({ phase: 'idle' });
        }}
        status={modelStatus}
        onLoad={loadModel}
      />

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
            relayLive={!onDevice && busy && phase === 'relay'}
            resumableLive={!onDevice && busy}
            modelLive={onDevice && busy && phase === 'relay'}
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
              This assistant is built on it: the agent runs the lookup, the relay streams the
              answer, and resumable keeps it alive if your connection drops. Ask it anything about
              the packages.
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

/** Thin control bar to enable on-device inference + load a small model.
 *  Experimental: cloud (Gemini) stays the default; this runs the whole agent
 *  in the browser for testing. */
function OnDeviceBar({
  onDevice,
  onToggle,
  preset,
  onPreset,
  status,
  onLoad,
}: {
  onDevice: boolean;
  onToggle: (v: boolean) => void;
  preset: OnDevicePreset;
  onPreset: (p: OnDevicePreset) => void;
  status: ModelStatus;
  onLoad: () => void;
}) {
  return (
    <div
      className={`shrink-0 border-b ${onDevice ? 'border-border-strong bg-surface' : 'border-border bg-bg'}`}
    >
      <div className="max-w-[760px] mx-auto px-4 md:px-6 min-h-9 flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-[11px] text-secondary">
        <button
          type="button"
          onClick={() => onToggle(!onDevice)}
          aria-pressed={onDevice}
          className="flex items-center gap-2 cursor-pointer select-none"
        >
          <span
            className={`inline-flex h-3.5 w-3.5 items-center justify-center border text-[9px] leading-none ${
              onDevice
                ? 'bg-primary border-primary text-bg'
                : 'border-border-strong text-transparent'
            }`}
          >
            ✓
          </span>
          <span className={onDevice ? 'text-primary font-medium' : 'text-secondary'}>
            {onDevice ? 'On-device ON' : 'Run on-device'}
          </span>
          <span className="text-dim-text">
            {onDevice ? 'experimental' : 'experimental · cloud otherwise'}
          </span>
        </button>
        {onDevice ? (
          <>
            <select
              value={preset}
              onChange={(e) => onPreset(e.target.value as OnDevicePreset)}
              disabled={status.phase === 'loading'}
              className="bg-bg border border-border px-1.5 py-0.5 text-[11px] text-secondary"
            >
              {(Object.keys(PRESET_META) as OnDevicePreset[]).map((p) => (
                <option key={p} value={p}>
                  {PRESET_META[p].label}
                </option>
              ))}
            </select>
            {status.phase === 'idle' ? (
              <button type="button" onClick={onLoad} className="text-primary hover:underline">
                download &amp; load · {PRESET_META[preset].note}
              </button>
            ) : status.phase === 'loading' ? (
              <span className="text-dim-text">{status.detail}</span>
            ) : status.phase === 'ready' ? (
              <span className="text-primary">
                <span aria-hidden="true">▸ </span>
                {PRESET_META[preset].label} · {status.backend}
                {status.backend === 'wasm' ? (
                  <span className="text-dim-text"> (slow; no WebGPU)</span>
                ) : null}
              </span>
            ) : (
              <span className="text-secondary">
                load failed: {status.msg}{' '}
                <button type="button" onClick={onLoad} className="text-primary underline">
                  retry
                </button>
              </span>
            )}
            {!hasWebGPU() ? <span className="text-dim-text">· no WebGPU → WASM</span> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
