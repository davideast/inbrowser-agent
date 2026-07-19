import type { LoadProgress } from '@inbrowser/model/local';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentStreamHandlers, VisitedCard } from '../../lib/agent-types';
import { buildDocsContextWindowSnapshot, traceHostContextForConfig } from '../../lib/agent-usage';
import { useChatStore } from '../../lib/chat-store';
import { type JobEvent, runWithLeader, subscribeJob } from '../../lib/durable-jobs';
import type { AgentJobSpec, AgentProvider } from '../../lib/job-producer';
import { type DurableEvent, dispatchDurableEvent, runLocalAgent } from '../../lib/local-agent';
import { type ModelSourceConfig, useModelSource } from '../../lib/model-source';
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
import { SiteHeader } from '../SiteHeader';
import { AgentUsageDialog, AgentUsageMeterButton } from './AgentUsage';
import { ChatSidebar } from './ChatSidebar';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { ModelSourcePanel, type ModelStatus } from './ModelSourcePanel';

/** The CLOUD sources whose agent loop runs as a durable job in the worker. The
 *  on-device WebGPU source stays on the inline `runLocalAgent` path (it owns the
 *  loaded engine; durable jobs would have to ship weights across `postMessage`). */
function isCloudSource(s: ModelSourceConfig['source']): s is AgentProvider {
  return s === 'gemini' || s === 'openrouter' || s === 'ollama' || s === 'llama';
}

/**
 * Build the serializable `AgentJobSpec` for a cloud source from the live config +
 * this turn's question + prior history. Mirrors `buildLocalModelClient`'s cloud
 * branches, but flattened to plain spec fields the worker reconstitutes the
 * `ModelClient` from (provider / model / apiKey / baseUrl).
 */
function buildAgentJobSpec(
  provider: AgentProvider,
  config: ModelSourceConfig,
  question: string,
  history: { role: 'user' | 'assistant'; text: string }[],
): AgentJobSpec {
  const base = {
    kind: 'agent' as const,
    provider,
    question,
    history,
    hostContext: traceHostContextForConfig(config),
  };
  if (provider === 'gemini') {
    return { ...base, model: config.geminiModel, apiKey: config.geminiKey };
  }
  if (provider === 'openrouter') {
    return { ...base, model: config.openrouterModel, apiKey: config.openrouterKey };
  }
  if (provider === 'ollama') {
    return { ...base, model: config.ollamaModel, baseUrl: config.ollamaBaseUrl };
  }
  // llama
  return {
    ...base,
    model: config.llamaModel,
    baseUrl: config.llamaBaseUrl,
    apiKey: config.llamaKey || undefined,
  };
}

/** How long after a RESUBSCRIBE we wait for a live event before deciding the job
 *  is stalled (its driver tab died with no SharedWorker keeping it alive) and
 *  offering "Continue". Replay events (the catch-up from `from`) don't count —
 *  only NEW events after the resubscribe reset this. */
const STALL_MS = 3_000;

/** The "what produced this" stamp for a turn (e.g. "cloud · Gemini"). `backend`
 *  (webgpu only) appends the runtime, e.g. "· webgpu". */
function sourceLabel(config: ModelSourceConfig, backend?: string): string {
  switch (config.source) {
    case 'gemini':
      return 'cloud · Gemini';
    case 'webgpu':
      return `on-device · ${PRESET_META[config.webgpuPreset].label}${backend ? ` · ${backend}` : ''}`;
    case 'openrouter':
      return `openrouter · ${config.openrouterModel}`;
    case 'llama':
      return `llama · ${config.llamaModel}`;
    default:
      return `ollama · ${config.ollamaModel}`;
  }
}

/** The per-event store writes a durable subscription needs, so one mapping
 *  function serves both the live send and the resubscribe (each passes its own
 *  position- vs jobId-targeted setters). */
interface DurableSink {
  onTurnStarted(turnId: string): void;
  onTrace: AgentStreamHandlers['onTrace'];
  onUsage: AgentStreamHandlers['onUsage'];
  onToken(text: string): void;
  onTool(name: string, detail: string): void;
  onVisited(card: VisitedCard): void;
  /** Record the highest applied seq (for resubscribe `from`). */
  onSeq(seq: number): void;
  /** The job reached terminal status. */
  onTerminal(status: 'done' | 'error' | 'cancelled', reason: string | undefined): void;
}

/**
 * Map a durable `JobEvent` stream onto a `DurableSink`. The SAME mapping the old
 * inline handlers did: `event` → switch on the `DurableEvent.kind`
 * (token/tool/visited) via the shared `dispatchDurableEvent`, plus advance the
 * seq cursor; `terminal` → onTerminal. Returns the `(e) => void` callback
 * `runWithLeader` / `subscribeJob` feed.
 */
function makeDurableHandler(sink: DurableSink): (e: JobEvent<DurableEvent>) => void {
  const handlers: AgentStreamHandlers = {
    onTurnStarted: sink.onTurnStarted,
    onTrace: sink.onTrace,
    onUsage: sink.onUsage,
    onToken: sink.onToken,
    onTool: sink.onTool,
    onVisited: sink.onVisited,
  };
  return (e) => {
    if (e.kind === 'event') {
      dispatchDurableEvent(e.value, handlers);
      sink.onSeq(e.seq);
    } else {
      sink.onTerminal(e.status, e.reason);
    }
  };
}

/** Centered docs chat: a prompt box to begin, an in-flow composer, and a
 *  toggle-only session drawer. */
export function ChatApp() {
  const store = useChatStore();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const { config, setSource, setField, oauthError } = useModelSource();
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ phase: 'idle' });
  const [cachedPresets, setCachedPresets] = useState<ReadonlySet<string>>(() => new Set());
  // Whether the browser granted persistent storage (so model weights survive).
  // null until requested.
  const [storagePersisted, setStoragePersisted] = useState<boolean | null>(null);
  // jobIds whose resubscribe replayed a partial answer but went quiet (the driver
  // tab died with no SharedWorker / extended-lifetime keeping it alive). These get
  // a "Continue" affordance to re-run the turn.
  const [stalledJobs, setStalledJobs] = useState<ReadonlySet<string>>(() => new Set());
  const abortRef = useRef<AbortController | null>(null);
  // Active resubscriptions, keyed by jobId, so we can tear them down on switch.
  const resubRef = useRef<Map<string, AbortController>>(new Map());
  // jobIds this tab is driving LIVE right now (a fresh send / continue). The
  // resubscribe effect skips these so a live stream isn't double-applied.
  const liveJobsRef = useRef<Set<string>>(new Set());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const messages = store.active?.messages ?? [];
  const hasMessages = messages.length > 0;
  const contextWindow = useMemo(
    () => buildDocsContextWindowSnapshot({ messages, currentPrompt: input, config }),
    [messages, input, config],
  );

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

  // Ask once for PERSISTENT storage on mount, so the durable-jobs IndexedDB log
  // (and the on-device weights) survive eviction. We request it unconditionally
  // — durable chat relies on the IDB log even with no on-device model loaded —
  // but only once, and only surface the honest result (no nagging).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    let cancelled = false;
    navigator.storage.persisted().then((already) => {
      if (cancelled) return;
      if (already) {
        setStoragePersisted(true);
        return;
      }
      navigator.storage.persist().then((granted) => {
        if (!cancelled) setStoragePersisted(granted);
      });
    });
    return () => {
      cancelled = true;
    };
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

  // Drive ONE cloud turn as a durable job: start it under leader-election, wire
  // this tab's live subscription to the trailing assistant turn of `sid`, persist
  // the jobId for later resubscribe, and own busy/abort. Shared by a fresh send
  // and the "Continue" re-run. `source` is stamped up front. Assumes the trailing
  // turn of `sid` is the assistant turn for this run (true while `busy` blocks a
  // concurrent send and the turn was just (re)opened).
  const runCloudJob = useCallback(
    async (sid: string, turnKey: string, spec: AgentJobSpec, source: string) => {
      setBusy(true);
      atBottomRef.current = true;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      store.setAssistantSource(sid, source);
      let liveJobId = '';
      const dispatch = makeDurableHandler({
        onTurnStarted: (turnId) => store.setAssistantTurnId(sid, turnId),
        onTrace: (event, hostContext) => store.addAssistantTrace(sid, event, hostContext),
        onUsage: (turnId, metrics, details) =>
          store.setAssistantUsage(sid, turnId, metrics, details),
        onToken: (t) => store.appendAssistantText(sid, t),
        onTool: (name, detail) => store.addAssistantStep(sid, { name, detail }),
        onVisited: (card) => store.addAssistantCard(sid, card),
        onSeq: (seq) => store.setAssistantSeq(sid, seq),
        onTerminal: (status, reason) => {
          store.setAssistantJobDone(sid);
          if (liveJobId) liveJobsRef.current.delete(liveJobId);
          if (status === 'done') finalize();
          else {
            setError(reason ?? 'The agent run failed.');
            finalize();
          }
        },
      });
      try {
        const jobId = await runWithLeader(turnKey, spec, dispatch, ctrl.signal);
        liveJobId = jobId;
        liveJobsRef.current.add(jobId);
        // Persist the jobId so a reload / another tab can resubscribe + replay.
        store.setAssistantJob(sid, jobId);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          finalize();
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
        finalize();
      }
    },
    [store, finalize],
  );

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
      if (config.source === 'llama' && !config.llamaBaseUrl.trim()) {
        setError('Set the Llama server URL in the model bar above.');
        finalize();
        return;
      }

      // Stamp the answer with what produced it, so it is never ambiguous which
      // path (source + model + backend) ran for this turn.
      const backend = modelStatus.phase === 'ready' ? modelStatus.backend : '';
      const source = sourceLabel(config, backend);

      const history = convo.slice(0, -1) as { role: 'user' | 'assistant'; text: string }[];

      // ── CLOUD path: run the agent loop as a DURABLE job in the worker ────────
      // The job persists every event to IndexedDB, so a reload / another tab can
      // resubscribe and replay it; this tab subscribes to the live stream. The
      // ON-DEVICE (webgpu) path below is the unchanged inline `runLocalAgent`.
      if (isCloudSource(config.source)) {
        const spec = buildAgentJobSpec(config.source, config, text, history);
        // turnKey is a stable per-turn id; leader-election maps it to one jobId.
        const turnId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        await runCloudJob(sid, `${sid}:${turnId}`, spec, source);
        return;
      }

      // ── ON-DEVICE path (webgpu): inline `runLocalAgent`, UNCHANGED ───────────
      let sourced = false;
      const stampSource = () => {
        if (!sourced) {
          sourced = true;
          store.setAssistantSource(sid, source);
        }
      };
      const handlers: AgentStreamHandlers = {
        onTurnStarted: (turnId) => store.setAssistantTurnId(sid, turnId),
        onTrace: (event, hostContext) => store.addAssistantTrace(sid, event, hostContext),
        onUsage: (turnId, metrics, details) =>
          store.setAssistantUsage(sid, turnId, metrics, details),
        onToken: (t) => {
          stampSource();
          store.appendAssistantText(sid, t);
        },
        onTool: (name, detail) => {
          stampSource();
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
        // The on-device engine runs the agent loop entirely in the browser; the
        // tiny model always uses the single-shot retrieval strategy (default opts).
        const client = createOnDeviceModelClient();
        if (!client) {
          setError('Load the on-device model first (use the model bar above).');
          finalize();
          return;
        }
        await runLocalAgent(client, text, history, handlers, ctrl.signal, {
          hostContext: traceHostContextForConfig(config, 'retrieval', 'provider-default'),
        });
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
    [input, busy, store, finalize, setUrl, config, modelStatus, runCloudJob],
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

  // ── Durable RESUBSCRIBE on mount / session switch ──────────────────────────
  // For every assistant turn in the active session whose job is still NON-terminal
  // and isn't being driven live in this tab, tail it from `lastSeq + 1` so a
  // reload / another tab replays the partial answer and keeps streaming. A
  // resubscribed job that goes quiet for STALL_MS (its driver tab died with no
  // SharedWorker/extended-lifetime) is marked stalled → "Continue" is offered.
  //
  // Keyed on the active SESSION id (not its messages): runs on mount + switch,
  // not on every streamed token. The live send wires its own subscription, so we
  // skip live-driven jobs here. The store's jobId-targeted setters land each
  // replayed event on its own turn regardless of position.
  const activeSessionId = store.activeId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on session switch, read the latest turns via the store
  useEffect(() => {
    if (!activeSessionId) return;
    const session = store.sessions.find((s) => s.id === activeSessionId);
    if (!session) return;

    const subs = resubRef.current;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    for (const turn of session.messages) {
      if (turn.role !== 'assistant' || !turn.jobId || turn.jobDone) continue;
      const jobId = turn.jobId;
      if (liveJobsRef.current.has(jobId) || subs.has(jobId)) continue; // already streaming here

      const ctrl = new AbortController();
      subs.set(jobId, ctrl);

      // Stall watchdog: (re)arm on every arriving event (replay OR live). If it
      // fires, the stream has been quiet for STALL_MS → offer Continue. The
      // terminal event clears it (a completed/failed job isn't stalled).
      const arm = () => {
        const prev = timers.get(jobId);
        if (prev) clearTimeout(prev);
        timers.set(
          jobId,
          setTimeout(() => {
            if (!ctrl.signal.aborted) {
              setStalledJobs((prev2) => new Set(prev2).add(jobId));
            }
          }, STALL_MS),
        );
      };

      const dispatch = makeDurableHandler({
        onTurnStarted: (turnId) => store.setAssistantTurnIdForJob(activeSessionId, jobId, turnId),
        onTrace: (event, hostContext) =>
          store.addAssistantTraceForJob(activeSessionId, jobId, event, hostContext),
        onUsage: (turnId, metrics, details) =>
          store.setAssistantUsageForJob(activeSessionId, jobId, turnId, metrics, details),
        onToken: (t) => store.appendAssistantTextForJob(activeSessionId, jobId, t),
        onTool: (name, detail) =>
          store.addAssistantStepForJob(activeSessionId, jobId, { name, detail }),
        onVisited: (card) => store.addAssistantCardForJob(activeSessionId, jobId, card),
        onSeq: (seq) => store.setAssistantSeqForJob(activeSessionId, jobId, seq),
        onTerminal: () => {
          store.setAssistantJobDoneForJob(activeSessionId, jobId);
          const prev = timers.get(jobId);
          if (prev) clearTimeout(prev);
          timers.delete(jobId);
          // A job that resumed and finished is no longer stalled.
          setStalledJobs((prev2) => {
            if (!prev2.has(jobId)) return prev2;
            const next = new Set(prev2);
            next.delete(jobId);
            return next;
          });
        },
      });

      arm();
      // Replay from the turn's cursor. `lastSeq` is the highest applied 0-based
      // index (undefined = none), so `from` = that + 1 (or 0). Advancing `lastSeq`
      // as events arrive makes a re-mount idempotent (no re-applied tokens).
      const from = (turn.lastSeq ?? -1) + 1;
      void (async () => {
        try {
          for await (const e of subscribeJob(jobId, {
            from,
            signal: ctrl.signal,
          })) {
            arm();
            dispatch(e);
          }
        } catch {
          /* aborted on switch/unmount — nothing to surface */
        }
      })();
    }

    return () => {
      // Tear down this session's resubscriptions on switch/unmount.
      for (const t of timers.values()) clearTimeout(t);
      for (const [jobId, ctrl] of subs) {
        ctrl.abort();
        subs.delete(jobId);
      }
    };
  }, [
    activeSessionId,
    store.appendAssistantTextForJob,
    store.addAssistantStepForJob,
    store.addAssistantCardForJob,
    store.setAssistantTurnIdForJob,
    store.addAssistantTraceForJob,
    store.setAssistantUsageForJob,
    store.setAssistantSeqForJob,
    store.setAssistantJobDoneForJob,
  ]);

  // ── "Continue" a stalled turn ──────────────────────────────────────────────
  // Re-run the turn from its original question as a FRESH durable job (the prior
  // driver tab died mid-answer). Clears the partial answer + the stalled flag,
  // then drives a new job into the SAME trailing assistant turn. Requires a cloud
  // source selected (re-runs on the current config).
  const continueTurn = useCallback(
    async (turnIndex: number) => {
      const session = store.sessions.find((s) => s.id === store.activeId);
      if (!session) return;
      const turn = session.messages[turnIndex];
      if (!turn || turn.role !== 'assistant') return;
      // The question is the user turn immediately before this assistant turn.
      const userTurn = session.messages[turnIndex - 1];
      if (!userTurn || userTurn.role !== 'user') return;
      if (!isCloudSource(config.source)) {
        setError('Select a cloud source (Gemini / OpenRouter / Ollama / Llama) to continue.');
        return;
      }
      const sid = session.id;
      // Stop any lingering resubscription for the old (stalled) job + clear flag.
      if (turn.jobId) {
        resubRef.current.get(turn.jobId)?.abort();
        resubRef.current.delete(turn.jobId);
        liveJobsRef.current.delete(turn.jobId);
      }
      setStalledJobs((prev) => {
        if (!turn.jobId || !prev.has(turn.jobId)) return prev;
        const next = new Set(prev);
        next.delete(turn.jobId);
        return next;
      });
      // Reset the trailing assistant turn so the fresh job streams cleanly. (The
      // turn is the last message; Continue only shows on a non-terminal trailing
      // turn whose job stalled.)
      store.resetAssistantTurn(sid);
      setError('');

      const history = session.messages
        .slice(0, turnIndex - 1)
        .map((m) => ({ role: m.role, text: m.text }));
      const source = sourceLabel(config);
      const spec = buildAgentJobSpec(config.source, config, userTurn.text, history);
      const turnId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await runCloudJob(sid, `${sid}:${turnId}`, spec, source);
    },
    [store, config, runCloudJob],
  );

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
      openrouterOAuthError={oauthError}
      ollamaModel={config.ollamaModel}
      onOllamaModel={(v) => setField('ollamaModel', v)}
      ollamaBaseUrl={config.ollamaBaseUrl}
      onOllamaBaseUrl={(v) => setField('ollamaBaseUrl', v)}
      llamaBaseUrl={config.llamaBaseUrl}
      onLlamaBaseUrl={(v) => setField('llamaBaseUrl', v)}
      llamaModel={config.llamaModel}
      onLlamaModel={(v) => setField('llamaModel', v)}
      llamaKey={config.llamaKey}
      onLlamaKey={(v) => setField('llamaKey', v)}
    />
  );

  // Landing-only discoverability nudge: source-aware so the hint is accurate.
  const pillHint =
    config.source === 'webgpu'
      ? 'runs in your browser'
      : config.source === 'ollama'
        ? 'your local server'
        : config.source === 'llama'
          ? 'your self-hosted server'
          : 'browser-direct · your key';

  // Honest, unobtrusive persistent-storage indicator: only shown once we KNOW the
  // state (storagePersisted !== null), and only the truthful word — durable chat
  // survives reload when granted, is best-effort (evictable) otherwise. No nag.
  const persistDot =
    storagePersisted === null ? null : (
      <span
        className="text-[11px] text-dim-text"
        title={
          storagePersisted
            ? 'Persistent storage granted: chats and the durable job log survive reloads and eviction.'
            : 'Storage is best-effort: the browser may evict chats and the durable job log under disk pressure.'
        }
      >
        {storagePersisted ? 'persistent' : 'best-effort'}
      </span>
    );

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
      <AgentUsageDialog
        open={usageOpen}
        snapshot={contextWindow}
        onClose={() => setUsageOpen(false)}
      />

      {hasMessages ? (
        <>
          {/* Scroll the conversation; the composer is docked below so it is
              always fully visible (no mid-screen float, no mobile-toolbar clip). */}
          <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
            <div className="max-w-[760px] mx-auto px-4 md:px-6 py-8">
              <ChatThread
                messages={messages}
                busy={busy}
                error={error}
                stalledJobs={stalledJobs}
                onContinue={continueTurn}
              />
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
              <div className="mt-2 flex items-center justify-end gap-2">
                {persistDot}
                <AgentUsageMeterButton snapshot={contextWindow} onOpen={() => setUsageOpen(true)} />
                {modelPill}
              </div>
            </div>
          </div>
        </>
      ) : (
        <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
          <div className="max-w-[760px] mx-auto px-4 md:px-6 pt-[12vh] pb-20">
            <div className="mb-5">
              <span className="text-[11px] font-medium uppercase tracking-widest text-label leading-none">
                Resumable. Grounded. BYOK. In browser
              </span>
            </div>
            <h1 className="text-[32px] md:text-[40px] leading-[1.1] tracking-[-0.02em] font-normal text-primary mb-4">
              The in-browser AI stack
            </h1>
            <p className="text-secondary text-[14px] leading-[1.75] mb-8 max-w-[54ch]">
              A collection of libraries that simplifies running AI inference in the browser. Great
              for rapid prototyping and just having a good time.
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
              <AgentUsageMeterButton snapshot={contextWindow} onOpen={() => setUsageOpen(true)} />
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
