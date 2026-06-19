import { createReactLoopStrategy } from '@inbrowser/agent';
import type { LoadProgress } from '@inbrowser/model';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentStreamHandlers } from '../../lib/agent-types';
import { useChatStore } from '../../lib/chat-store';
import { REACT_SYSTEM_PROMPT, runLocalAgent } from '../../lib/local-agent';
import { buildLocalModelClient, useModelSource } from '../../lib/model-source';
import {
  PRESET_META,
  createOnDeviceModelClient,
  getCachedPresets,
  hasWebGPU,
  loadOnDeviceEngine,
  requestPersistentStorage,
} from '../../lib/on-device-agent';
import { getSuggestions } from '../../lib/suggestions';
import { PackageCards } from '../PackageCards';
import { PoweredByStrip } from '../PoweredByStrip';
import { SiteHeader } from '../SiteHeader';
import { ChatSidebar } from './ChatSidebar';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { ModelSourcePanel, type ModelStatus } from './ModelSourcePanel';

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
  const { config, setSource, setField } = useModelSource();
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ phase: 'idle' });
  const [cachedPresets, setCachedPresets] = useState<ReadonlySet<string>>(() => new Set());
  // Whether the browser granted persistent storage (so model weights survive).
  // null until requested.
  const [storagePersisted, setStoragePersisted] = useState<boolean | null>(null);
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

  // Hydrate the `✓ cached` badge from the REAL model cache (Cache API), and
  // reflect the current persisted-storage state, on mount.
  useEffect(() => {
    getCachedPresets().then(setCachedPresets);
    if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
      navigator.storage.persisted().then(setStoragePersisted);
    }
  }, []);

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

  // Download + compile the chosen on-device preset (in a Web Worker). Progress
  // is AGGREGATED across files (overall % = Σloaded/Σtotal, no per-file resets,
  // no filenames) and THROTTLED to ~150 ms so the panel glides instead of
  // thrashing. The weights are fetched once, then cached for instant reloads.
  const loadModel = useCallback(async () => {
    const preset = config.webgpuPreset;
    const backend = hasWebGPU() ? 'webgpu' : 'wasm';
    setModelStatus({ phase: 'loading', step: 'download', pct: 0, loadedBytes: 0, totalBytes: 0 });
    // Ask the browser to keep these weights so they aren't evicted + re-downloaded.
    requestPersistentStorage().then(setStoragePersisted);

    // Per-file byte tallies; the overall bar reads their sums.
    const files = new Map<string, { loaded: number; total: number }>();
    let lastTick = 0;
    let raf = 0;
    const flushDownload = () => {
      raf = 0;
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      setModelStatus({
        phase: 'loading',
        step: 'download',
        pct,
        loadedBytes: loaded,
        totalBytes: total,
      });
    };

    try {
      await loadOnDeviceEngine(preset, {
        onProgress: (p: LoadProgress) => {
          if (p.phase === 'fetch') {
            files.set(p.file, { loaded: p.loadedBytes, total: p.totalBytes });
            // Coalesce the 100s/sec fetch events behind a ~150 ms gate + rAF.
            const now = Date.now();
            if (now - lastTick >= 150 && !raf) {
              lastTick = now;
              if (typeof requestAnimationFrame === 'function') {
                raf = requestAnimationFrame(flushDownload);
              } else {
                flushDownload();
              }
            }
          } else if (p.phase === 'init') {
            if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
            raf = 0;
            setModelStatus({
              phase: 'loading',
              step: 'compile',
              pct: 100,
              loadedBytes: 0,
              totalBytes: 0,
            });
          } else if (p.phase === 'warmup') {
            setModelStatus({
              phase: 'loading',
              step: 'warmup',
              pct: 100,
              loadedBytes: 0,
              totalBytes: 0,
            });
          }
        },
      });
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      setModelStatus({ phase: 'ready', backend });
      // Reflect the now-cached weights from the real cache (not a guessed flag).
      getCachedPresets().then(setCachedPresets);
    } catch (e) {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      setModelStatus({ phase: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }, [config.webgpuPreset]);

  // Auto re-LOAD from cache on refresh: the in-memory engine is always gone
  // after a reload, but if the weights are still in the Cache API we load them
  // back seamlessly (no click, no "download"). We only do this when the model
  // is the active source, sits at 'idle', and is actually cached — never an
  // auto-download. `loadModel` moves status off 'idle', so this can't loop.
  useEffect(() => {
    if (
      config.source === 'webgpu' &&
      modelStatus.phase === 'idle' &&
      cachedPresets.has(config.webgpuPreset)
    ) {
      loadModel();
    }
  }, [config.source, config.webgpuPreset, cachedPresets, modelStatus.phase, loadModel]);

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

      // Per-source pre-send guards.
      if (config.source === 'gemini' && !config.geminiKey.trim()) {
        setError('Add your Gemini API key (in the model bar above).');
        finalize();
        return;
      }
      if (config.source === 'webgpu' && modelStatus.phase !== 'ready') {
        setError('Load the on-device model first (use the model bar above).');
        finalize();
        return;
      }
      if (config.source === 'openrouter' && !config.openrouterKey.trim()) {
        setError('Add your OpenRouter API key in the model bar above.');
        finalize();
        return;
      }
      if (config.source === 'ollama' && !config.ollamaModel.trim()) {
        setError('Set an Ollama model name in the model bar above.');
        finalize();
        return;
      }

      // Stamp the answer with what produced it, so it is never ambiguous which
      // path (source + model + backend) ran for this turn.
      const backend = modelStatus.phase === 'ready' ? modelStatus.backend : '';
      const source =
        config.source === 'gemini'
          ? 'cloud · Gemini'
          : config.source === 'webgpu'
            ? `on-device · ${PRESET_META[config.webgpuPreset].label}${backend ? ` · ${backend}` : ''}`
            : config.source === 'openrouter'
              ? `openrouter · ${config.openrouterModel}`
              : `ollama · ${config.ollamaModel}`;
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
        // Every source now runs the agent loop entirely in the browser against
        // a `ModelClient`: webgpu = the loaded on-device engine; gemini /
        // openrouter / ollama = a browser-direct provider (BYOK for the cloud
        // ones). No server round-trip.
        const history = convo.slice(0, -1) as { role: 'user' | 'assistant'; text: string }[];
        const client =
          config.source === 'webgpu' ? createOnDeviceModelClient() : buildLocalModelClient(config);
        if (!client) {
          setError('Load the on-device model first (use the model bar above).');
          finalize();
          return;
        }
        // Tiny on-device models use single-shot retrieval (the default opts);
        // capable cloud/local models drive the ReAct multi-tool loop.
        const opts =
          config.source === 'webgpu'
            ? undefined
            : {
                strategy: createReactLoopStrategy({ maxTurns: 10 }),
                systemPrompt: REACT_SYSTEM_PROMPT,
              };
        await runLocalAgent(client, text, history, handlers, ctrl.signal, opts);
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
    [input, busy, store, finalize, setUrl, config, modelStatus],
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

  // The model-source pill is shared by both render branches (conversation +
  // landing); build it once so neither branch re-declares the ~16 props.
  const modelPill = (
    <ModelSourcePanel
      source={config.source}
      onSource={setSource}
      geminiKey={config.geminiKey}
      onGeminiKey={(v) => setField('geminiKey', v)}
      geminiModel={config.geminiModel}
      onGeminiModel={(v) => setField('geminiModel', v)}
      webgpuPreset={config.webgpuPreset}
      onWebgpuPreset={(p) => {
        setField('webgpuPreset', p);
        // Switching the preset invalidates the loaded engine status.
        setModelStatus({ phase: 'idle' });
      }}
      status={modelStatus}
      onLoad={loadModel}
      cachedPresets={cachedPresets as ReadonlySet<typeof config.webgpuPreset>}
      storagePersisted={storagePersisted}
      openrouterKey={config.openrouterKey}
      onOpenrouterKey={(v) => setField('openrouterKey', v)}
      openrouterModel={config.openrouterModel}
      onOpenrouterModel={(v) => setField('openrouterModel', v)}
      ollamaModel={config.ollamaModel}
      onOllamaModel={(v) => setField('ollamaModel', v)}
      ollamaBaseUrl={config.ollamaBaseUrl}
      onOllamaBaseUrl={(v) => setField('ollamaBaseUrl', v)}
    />
  );

  // Landing-only discoverability nudge: source-aware so the hint is accurate.
  const pillHint =
    config.source === 'webgpu'
      ? 'runs in your browser'
      : config.source === 'ollama'
        ? 'your local server'
        : 'browser-direct · your key';

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
            modelLive={busy && phase === 'relay'}
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
              <div className="mt-2 flex justify-end">{modelPill}</div>
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
            <div className="mt-3 flex items-center justify-end gap-3">
              <span className="text-[11px] text-dim-text">{pillHint}</span>
              {modelPill}
            </div>
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
