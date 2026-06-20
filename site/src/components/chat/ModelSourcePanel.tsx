/**
 * Unified model-source selector for the docs chat (replaces the old OnDeviceBar).
 * Terminal Modernism: mono, brightness not colour, `▸` liveness, thin borders, no
 * status dots. A compact PILL summarizes the active source + state; clicking it
 * opens an upward POPOVER holding the source rows, a divider, and the active
 * source's full config (and, for WebGPU, the redesigned loading panel). The pill
 * lives just below the composer, so the popover opens upward (`bottom-full`).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type ModelSource, SOURCE_META, fetchOaiModels } from '../../lib/model-source';
import { type OnDevicePreset, PRESET_META, hasWebGPU } from '../../lib/on-device-agent';
import { connectOpenRouter, connectOpenRouterPopup } from '../../lib/openrouter-oauth';

/**
 * On-device load status. The `loading` variant carries the redesigned panel's
 * data: `step` is the named phase (download/compile/warmup) — named `step`, not
 * `phase`, because `phase` is already the outer union discriminant — plus the
 * aggregate `pct` + byte totals (only meaningful during `download`).
 */
export type ModelStatus =
  | { phase: 'idle' }
  | {
      phase: 'loading';
      step: 'download' | 'compile' | 'warmup';
      pct: number;
      loadedBytes: number;
      totalBytes: number;
    }
  | { phase: 'ready'; backend: string }
  | { phase: 'error'; msg: string };

const SOURCE_ORDER: ModelSource[] = ['gemini', 'webgpu', 'openrouter', 'ollama', 'llama'];

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = n / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

const STEP_TEXT: Record<'download' | 'compile' | 'warmup', string> = {
  download: 'Downloading model',
  compile: 'Compiling',
  warmup: 'Warming up',
};

interface ModelSourcePanelProps {
  source: ModelSource;
  onSource(source: ModelSource): void;
  // Gemini (BYOK, browser-direct)
  geminiKey: string;
  onGeminiKey(v: string): void;
  geminiModel: string;
  onGeminiModel(v: string): void;
  // WebGPU
  webgpuPreset: OnDevicePreset;
  onWebgpuPreset(preset: OnDevicePreset): void;
  status: ModelStatus;
  onLoad(): void;
  cachedPresets: ReadonlySet<OnDevicePreset>;
  /** Whether the browser granted persistent storage (weights won't be evicted).
   *  null = not yet requested. */
  storagePersisted: boolean | null;
  // OpenRouter
  openrouterKey: string;
  onOpenrouterKey(v: string): void;
  openrouterModel: string;
  onOpenrouterModel(v: string): void;
  /** Last OpenRouter OAuth failure to surface in the config, or null. */
  openrouterOAuthError?: string | null;
  // Ollama
  ollamaModel: string;
  onOllamaModel(v: string): void;
  ollamaBaseUrl: string;
  onOllamaBaseUrl(v: string): void;
  // Llama (self-hosted llama-server / OpenAI-compatible)
  llamaBaseUrl: string;
  onLlamaBaseUrl(v: string): void;
  llamaModel: string;
  onLlamaModel(v: string): void;
  llamaKey: string;
  onLlamaKey(v: string): void;
}

/**
 * Compact pill + click-to-open upward popover. The pill (closed) summarizes the
 * active source + state in one inline control; the popover (open) holds the
 * source rows, a divider, then the active source's full config — the heavy panel
 * that used to hang persistently below the old top bar now lives in here.
 */
export function ModelSourcePanel(props: ModelSourcePanelProps) {
  const {
    source,
    onSource,
    status,
    geminiKey,
    geminiModel,
    webgpuPreset,
    openrouterModel,
    openrouterKey,
    ollamaModel,
    llamaBaseUrl,
    llamaModel,
  } = props;
  const webgpuAvailable = hasWebGPU();
  // Recommended source: on-device when the GPU is there, else zero-config cloud.
  const recommended: ModelSource = webgpuAvailable ? 'webgpu' : 'gemini';

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const summary = useMemo(
    () =>
      summarizeSource(source, {
        status,
        geminiKey,
        geminiModel,
        webgpuPreset,
        openrouterModel,
        openrouterKey,
        ollamaModel,
        llamaBaseUrl,
        llamaModel,
      }),
    [
      source,
      status,
      geminiKey,
      geminiModel,
      webgpuPreset,
      openrouterModel,
      openrouterKey,
      ollamaModel,
      llamaBaseUrl,
      llamaModel,
    ],
  );

  // WebGPU loading drives the glyph (◐) + the progress underline + a trailing
  // ` · {pct}%` on the pill text.
  const loading = source === 'webgpu' && status.phase === 'loading';
  const pct = loading ? (status as Extract<ModelStatus, { phase: 'loading' }>).pct : 0;
  const glyph = summary.live ? '▸' : loading ? '◐' : '▹';
  const pillText = loading ? `${summary.text} · ${pct}%` : summary.text;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // When opening, point the active row at the current source.
  useEffect(() => {
    if (open) setActive(SOURCE_ORDER.indexOf(source));
  }, [open, source]);

  const canSelect = useCallback(
    (s: ModelSource) => s !== 'webgpu' || webgpuAvailable,
    [webgpuAvailable],
  );

  const choose = useCallback(
    (s: ModelSource) => {
      if (!canSelect(s)) return;
      onSource(s);
      // Keep the popover open so the newly-active source's config is right there.
    },
    [canSelect, onSource],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (!open) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          setOpen(true);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(SOURCE_ORDER.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(SOURCE_ORDER[active]);
      }
    },
    [open, active, choose],
  );

  return (
    <div ref={rootRef} className="relative inline-block">
      {/* PILL — fixed width so the loading underline reads as progress. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        className="relative inline-flex w-[260px] items-center gap-2 overflow-hidden border border-border hover:border-border-strong bg-surface px-2 py-1 text-[11px] text-primary transition-colors"
      >
        <span aria-hidden="true" className={summary.live ? 'text-primary' : 'text-dim-text'}>
          {glyph}
        </span>
        <span className="truncate">{pillText}</span>
        <span aria-hidden="true" className="ml-auto text-dim-text">
          ▾
        </span>
        {/* Loading progress underline (brightness fill, width = pct). */}
        {loading ? (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-[1.5px] bg-secondary transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        ) : null}
      </button>
      {open ? (
        <div className="absolute bottom-full right-0 z-30 mb-1 min-w-[300px] border border-border-strong bg-surface shadow-lg">
          {/* 1. Source rows (keyboard nav + click-outside live on the root). */}
          <div
            id={listId}
            // biome-ignore lint/a11y/useSemanticElements: a native <select> can't carry the rich rows (kind · requirement · ★ recommended · capability gating) the plan calls for
            role="listbox"
            aria-label="Model source"
            aria-activedescendant={`${listId}-${active}`}
            tabIndex={-1}
          >
            {SOURCE_ORDER.map((s, i) => {
              const meta = SOURCE_META[s];
              const disabled = !canSelect(s);
              const isActive = i === active;
              return (
                <div
                  key={s}
                  id={`${listId}-${i}`}
                  // biome-ignore lint/a11y/useSemanticElements: custom option row carries badges + dim/gated state a native <option> can't render
                  role="option"
                  tabIndex={disabled ? -1 : 0}
                  aria-selected={s === source}
                  aria-disabled={disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(s)}
                  onKeyDown={onKeyDown}
                  className={`grid grid-cols-[0.9rem_1fr_auto] items-center gap-2 px-2.5 py-1.5 cursor-pointer select-none ${
                    isActive ? 'bg-bg' : ''
                  } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <span className="text-primary" aria-hidden="true">
                    {s === source ? '▸' : ''}
                  </span>
                  <span className={disabled ? 'text-secondary' : 'text-primary'}>{meta.label}</span>
                  <span className="flex items-center justify-end gap-1.5 text-dim-text">
                    {s === recommended && !disabled ? (
                      <span title="recommended" aria-label="recommended">
                        ★
                      </span>
                    ) : null}
                    <span>{disabled ? 'needs WebGPU' : meta.requirement}</span>
                  </span>
                </div>
              );
            })}
          </div>
          {/* 2. Divider. */}
          <div className="border-t border-border" />
          {/* 3. The active source's config (the heavy panel, now inside). A fixed
              min-height keeps the popover the SAME height across sources, so
              switching providers never makes it jump. */}
          <div className="min-h-[136px] px-2.5 pb-2.5 text-[11px] text-secondary">
            <SourceConfig {...props} webgpuAvailable={webgpuAvailable} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The one-line summary shown on the closed dropdown trigger. */
function summarizeSource(
  source: ModelSource,
  ctx: {
    status: ModelStatus;
    geminiKey: string;
    geminiModel: string;
    webgpuPreset: OnDevicePreset;
    openrouterModel: string;
    openrouterKey: string;
    ollamaModel: string;
    llamaBaseUrl: string;
    llamaModel: string;
  },
): { text: string; live: boolean } {
  const meta = SOURCE_META[source];
  let model: string;
  let ready: boolean;
  let blocker = '';
  if (source === 'gemini') {
    model = shortModel(ctx.geminiModel);
    ready = !!ctx.geminiKey.trim();
    if (!ready) blocker = 'needs key';
  } else if (source === 'webgpu') {
    model = PRESET_META[ctx.webgpuPreset].label;
    ready = ctx.status.phase === 'ready';
    if (!ready)
      blocker =
        ctx.status.phase === 'loading'
          ? STEP_TEXT[ctx.status.step].toLowerCase()
          : ctx.status.phase === 'error'
            ? 'load failed'
            : 'not loaded';
  } else if (source === 'openrouter') {
    model = shortModel(ctx.openrouterModel);
    ready = !!ctx.openrouterKey.trim();
    if (!ready) blocker = 'needs key';
  } else if (source === 'ollama') {
    model = ctx.ollamaModel || 'no model';
    ready = !!ctx.ollamaModel.trim();
    if (!ready) blocker = 'needs model';
  } else {
    model = shortModel(ctx.llamaModel) || 'no model';
    ready = !!ctx.llamaBaseUrl.trim();
    if (!ready) blocker = 'needs server';
  }
  // The trigger stays clean when ready ("Name · model"); it shows the one
  // actionable blocker only when action is needed. Full state lives in the
  // config panel directly below, and `live` drives the ▸ brightness.
  return {
    text: blocker ? `${meta.label} · ${model} · ${blocker}` : `${meta.label} · ${model}`,
    live: ready,
  };
}

function shortModel(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Per-source configuration (shown when that source is active). */
function SourceConfig(props: ModelSourcePanelProps & { webgpuAvailable: boolean }) {
  const { source } = props;
  if (source === 'gemini') return <GeminiConfig {...props} />;
  if (source === 'webgpu') return <WebgpuConfig {...props} />;
  if (source === 'openrouter') return <OpenrouterConfig {...props} />;
  if (source === 'llama') return <LlamaConfig {...props} />;
  return <OllamaConfig {...props} />;
}

function WebgpuConfig({
  webgpuPreset,
  status,
  onLoad,
  cachedPresets,
  storagePersisted,
  webgpuAvailable,
}: ModelSourcePanelProps & { webgpuAvailable: boolean }) {
  // Single on-device model now, so there's no preset picker: when its weights
  // are already in the Cache API, the load button + loading panel re-LOAD from
  // cache (no network), so a refresh doesn't look like a re-download.
  const cached = cachedPresets.has(webgpuPreset);
  return (
    <div className="mt-2 space-y-2">
      {/* Load button + redesigned loading panel / ready / error. */}
      {status.phase === 'idle' ? (
        <button
          type="button"
          onClick={onLoad}
          disabled={PRESET_META[webgpuPreset].needsWebGPU && !webgpuAvailable}
          className="text-primary hover:underline disabled:opacity-40 disabled:no-underline"
        >
          {cached
            ? 'load · cached (no download)'
            : `download & load · ${PRESET_META[webgpuPreset].note}`}
        </button>
      ) : status.phase === 'loading' ? (
        <LoadingPanel preset={webgpuPreset} status={status} cached={cached} />
      ) : status.phase === 'ready' ? (
        <div className="text-primary">
          <span aria-hidden="true">▸ </span>
          {PRESET_META[webgpuPreset].label} · {status.backend} · ready
          {status.backend === 'wasm' ? (
            <span className="text-dim-text"> (slow; no WebGPU)</span>
          ) : null}
        </div>
      ) : (
        <div className="text-secondary">
          load failed: {status.msg}{' '}
          <button type="button" onClick={onLoad} className="text-primary underline">
            retry
          </button>
        </div>
      )}
      {!webgpuAvailable ? (
        <div className="text-dim-text">
          no WebGPU on this device — only SmolLM2 (WASM) runs; it is slow.
        </div>
      ) : null}
      {storagePersisted !== null ? (
        <div className="text-dim-text">
          {storagePersisted
            ? 'storage: persistent · weights are kept across visits'
            : 'storage: best-effort · the browser may evict the weights (re-download)'}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Calm, fixed-height loading panel. A `div` bar with a CSS width transition
 * during download; compile/warm-up are steady labels (no %). Named-phase
 * breadcrumb with `▸` on the current step. No raw filenames, no per-file %.
 *
 * `cached`: the weights are already in the Cache API, so the `download` step is
 * really a fast local read — label it "loading from cache" and drop the byte
 * counts + % (there's nothing to download); compile/warm-up are unchanged.
 */
function LoadingPanel({
  preset,
  status,
  cached,
}: {
  preset: OnDevicePreset;
  status: Extract<ModelStatus, { phase: 'loading' }>;
  cached: boolean;
}) {
  const downloading = status.step === 'download';
  // A real network download shows bytes + %; a cache read does not.
  const showBytes = downloading && !cached;
  const stepText = downloading && cached ? 'Loading from cache' : STEP_TEXT[status.step];
  const phases: Array<{ key: 'download' | 'compile' | 'warmup'; label: string }> = [
    { key: 'download', label: cached ? 'load' : 'download' },
    { key: 'compile', label: 'compile' },
    { key: 'warmup', label: 'warm up' },
  ];
  return (
    <div className="min-h-[68px] border border-border bg-surface px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-secondary">
        <span className="min-w-0">
          {stepText}
          <span className="text-dim-text"> · {PRESET_META[preset].label}</span>
        </span>
        {showBytes ? (
          // nowrap + shrink-0 so "224 MB / 262 MB" never breaks the unit onto a
          // second line; the label on the left shrinks/wraps instead.
          <span className="text-dim-text tabular-nums whitespace-nowrap shrink-0">
            {formatBytes(status.loadedBytes)} / {formatBytes(status.totalBytes)}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 h-1.5 w-full bg-bg border border-border overflow-hidden">
        <div
          className="h-full bg-primary transition-[width] duration-200 ease-out"
          style={{ width: showBytes ? `${status.pct}%` : '100%' }}
        />
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-dim-text">
        {phases.map((ph) => {
          const isCurrent = ph.key === status.step;
          return (
            <span key={ph.key} className={isCurrent ? 'text-primary' : ''}>
              {isCurrent ? <span aria-hidden="true">▸ </span> : null}
              {ph.label}
            </span>
          );
        })}
        {showBytes ? (
          <span className="ml-auto text-secondary tabular-nums">{status.pct}%</span>
        ) : null}
      </div>
    </div>
  );
}

function GeminiConfig({
  geminiKey,
  onGeminiKey,
  geminiModel,
  onGeminiModel,
}: ModelSourcePanelProps) {
  const keyId = useId();
  const modelId = useId();
  const ready = geminiKey.trim().length > 0;
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label htmlFor={keyId} className="text-dim-text">
          API key
        </label>
        <input
          id={keyId}
          type="password"
          autoComplete="off"
          value={geminiKey}
          onChange={(e) => onGeminiKey(e.target.value)}
          placeholder="AIza…"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[220px] transition-colors"
        />
        <label htmlFor={modelId} className="text-dim-text">
          model
        </label>
        <input
          id={modelId}
          type="text"
          value={geminiModel}
          onChange={(e) => onGeminiModel(e.target.value)}
          placeholder="gemini-3.5-flash"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[200px] transition-colors"
        />
        <span className={ready ? 'text-primary' : 'text-dim-text'}>
          <span aria-hidden="true">{ready ? '▸ ' : '· '}</span>
          {ready ? 'ready' : 'needs key'}
        </span>
      </div>
      <div className="text-dim-text">Direct to Google; key stored only in your browser.</div>
    </div>
  );
}

function OpenrouterConfig({
  openrouterKey,
  onOpenrouterKey,
  openrouterModel,
  onOpenrouterModel,
  openrouterOAuthError,
}: ModelSourcePanelProps) {
  const keyId = useId();
  const modelId = useId();
  const ready = openrouterKey.trim().length > 0;
  const [connecting, setConnecting] = useState(false);
  const [popupError, setPopupError] = useState<string | null>(null);
  // Prefer the popup (no navigation, the chat stays put); fall back to the
  // full-page redirect if the popup is blocked. On success set the key directly
  // — the OpenRouter source is already active here, so no source switch needed.
  const onConnect = useCallback(async () => {
    setPopupError(null);
    setConnecting(true);
    const result = await connectOpenRouterPopup();
    if (result.status === 'blocked') {
      connectOpenRouter().catch(() => setConnecting(false));
      return;
    }
    setConnecting(false);
    if (result.status === 'ok') onOpenrouterKey(result.key);
    else if (result.status === 'error') setPopupError(result.message);
  }, [onOpenrouterKey]);
  const error = popupError ?? openrouterOAuthError;
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="bg-primary/10 border border-primary/40 hover:bg-primary/20 disabled:opacity-50 outline-none px-2.5 py-1 text-[11px] text-primary transition-colors"
        >
          {connecting ? 'Connecting…' : ready ? 'Reconnect OpenRouter' : 'Connect OpenRouter'}
        </button>
        <label htmlFor={keyId} className="text-dim-text">
          API key
        </label>
        <input
          id={keyId}
          type="password"
          autoComplete="off"
          value={openrouterKey}
          onChange={(e) => onOpenrouterKey(e.target.value)}
          placeholder="sk-or-…"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[200px] transition-colors"
        />
        <label htmlFor={modelId} className="text-dim-text">
          model
        </label>
        <input
          id={modelId}
          type="text"
          value={openrouterModel}
          onChange={(e) => onOpenrouterModel(e.target.value)}
          placeholder="z-ai/glm-5.2"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[180px] transition-colors"
        />
        <span className={ready ? 'text-primary' : 'text-dim-text'}>
          <span aria-hidden="true">{ready ? '▸ ' : '· '}</span>
          {ready ? 'ready' : 'needs key'}
        </span>
      </div>
      {error ? (
        <div className="text-primary">
          <span aria-hidden="true">! </span>
          Sign-in failed: {error}. Try Connect again.
        </div>
      ) : (
        <div className="text-dim-text">
          Connect provisions a revocable OpenRouter key, or paste your own; stored only in your
          browser.
        </div>
      )}
    </div>
  );
}

/** A one-line command shown as a click-to-copy chip. Copy needs a secure
 *  context (we're on HTTPS), so `navigator.clipboard` is available. */
function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="group flex w-full items-center justify-between gap-2 border border-border bg-bg px-2 py-1 text-left transition-colors hover:border-primary"
    >
      <code className="truncate text-[11px] text-primary">{text}</code>
      <span
        className="shrink-0 text-[10px] text-dim-text group-hover:text-secondary"
        aria-hidden="true"
      >
        {copied ? '✓ copied' : 'copy'}
      </span>
    </button>
  );
}

function OllamaConfig({
  ollamaModel,
  onOllamaModel,
  ollamaBaseUrl,
  onOllamaBaseUrl,
}: ModelSourcePanelProps) {
  const modelId = useId();
  const urlId = useId();
  const ready = ollamaModel.trim().length > 0;
  // `http://localhost` is a *potentially-trustworthy* origin, so an HTTPS page
  // CAN reach it — it is NOT mixed content. It only needs Ollama to allow this
  // page's origin (CORS) via OLLAMA_ORIGINS. A non-localhost `http://` server
  // (e.g. a LAN IP) IS mixed content and genuinely blocked.
  const onHttps = typeof location !== 'undefined' && location.protocol === 'https:';
  const url = ollamaBaseUrl.trim();
  const isHttp = /^http:\/\//i.test(url);
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
  const mixedBlocked = onHttps && isHttp && !isLocalhost;
  const origin = typeof location !== 'undefined' ? location.origin : 'https://inbrowser.io';
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label htmlFor={modelId} className="text-dim-text">
          model
        </label>
        <input
          id={modelId}
          type="text"
          value={ollamaModel}
          onChange={(e) => onOllamaModel(e.target.value)}
          placeholder="llama3.2"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[160px] transition-colors"
        />
        <label htmlFor={urlId} className="text-dim-text">
          server
        </label>
        <input
          id={urlId}
          type="text"
          value={ollamaBaseUrl}
          onChange={(e) => onOllamaBaseUrl(e.target.value)}
          placeholder="http://localhost:11434"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[200px] transition-colors"
        />
        <span className={ready ? 'text-primary' : 'text-dim-text'}>
          <span aria-hidden="true">{ready ? '▸ ' : '· '}</span>
          {ready ? 'ready' : 'needs model'}
        </span>
      </div>
      {mixedBlocked ? (
        <div className="text-secondary">
          this page is HTTPS, so a plain <code className="text-primary">http://</code> server on the
          network is blocked (mixed content). Use an <code className="text-primary">https://</code>{' '}
          URL — e.g. expose it with <code className="text-primary">tailscale serve</code>.{' '}
          <code className="text-primary">localhost</code> works without HTTPS.
        </div>
      ) : (
        <div className="space-y-1.5 text-dim-text">
          <div>Let Ollama accept this page — set its allowed origin, then restart it:</div>
          <CopyCommand text={`OLLAMA_ORIGINS=${origin} ollama serve`} />
          <div className="text-[10px]">
            Using the macOS menu-bar app?{' '}
            <code className="text-secondary">launchctl setenv OLLAMA_ORIGINS "{origin}"</code>, then
            restart Ollama.
          </div>
        </div>
      )}
    </div>
  );
}

function LlamaConfig({
  llamaBaseUrl,
  onLlamaBaseUrl,
  llamaModel,
  onLlamaModel,
  llamaKey,
  onLlamaKey,
}: ModelSourcePanelProps) {
  const urlId = useId();
  const modelId = useId();
  const keyId = useId();
  const ready = llamaBaseUrl.trim().length > 0;
  // A browser on an HTTPS page can't reach an http:// server (mixed content).
  const httpsBlocked =
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    /^http:\/\//.test(llamaBaseUrl.trim());

  // Auto-populate the model picker from the server's /v1/models (browser-direct,
  // debounced on the SERVER url/key). Falls back to a manual text input on any
  // failure (server down / no CORS / bad URL).
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch only when the server (url/key) changes, not when the user picks a model
  useEffect(() => {
    const url = llamaBaseUrl.trim();
    if (!/^https?:\/\//.test(url) || httpsBlocked) {
      setModels([]);
      setModelsLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setModelsLoading(true);
    const t = setTimeout(() => {
      fetchOaiModels(url, llamaKey || undefined, ctrl.signal)
        .then((ids) => {
          setModels(ids);
          // Auto-select the first served model when the current one isn't offered.
          if (ids.length && !ids.includes(llamaModel)) onLlamaModel(ids[0]);
        })
        .catch(() => setModels([]))
        .finally(() => setModelsLoading(false));
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [llamaBaseUrl, llamaKey, httpsBlocked]);

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label htmlFor={urlId} className="text-dim-text">
          server
        </label>
        <input
          id={urlId}
          type="text"
          value={llamaBaseUrl}
          onChange={(e) => onLlamaBaseUrl(e.target.value)}
          placeholder="http://localhost:8080"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[200px] transition-colors"
        />
        <label htmlFor={modelId} className="text-dim-text">
          model
        </label>
        {models.length ? (
          <select
            id={modelId}
            value={models.includes(llamaModel) ? llamaModel : models[0]}
            onChange={(e) => onLlamaModel(e.target.value)}
            className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary w-[200px] transition-colors"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={modelId}
            type="text"
            value={llamaModel}
            onChange={(e) => onLlamaModel(e.target.value)}
            placeholder={modelsLoading ? 'loading models…' : 'local-model'}
            className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[160px] transition-colors"
          />
        )}
        <label htmlFor={keyId} className="text-dim-text">
          API key
        </label>
        <input
          id={keyId}
          type="password"
          autoComplete="off"
          value={llamaKey}
          onChange={(e) => onLlamaKey(e.target.value)}
          placeholder="Bearer token (optional)"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[200px] transition-colors"
        />
        <span className={ready ? 'text-primary' : 'text-dim-text'}>
          <span aria-hidden="true">{ready ? '▸ ' : '· '}</span>
          {ready
            ? `ready${models.length ? ` · ${models.length} model${models.length > 1 ? 's' : ''}` : ''}`
            : 'needs server'}
        </span>
      </div>
      {httpsBlocked ? (
        <div className="text-secondary">
          served over HTTPS — a browser can't reach http://localhost (open the site on localhost, or
          expose the server over HTTPS).
        </div>
      ) : null}
      <div className="text-dim-text">
        Self-hosted OpenAI-compatible server (llama.cpp, vLLM, …). Needs CORS for this origin;
        expose it over HTTPS (e.g. tailscale serve) if the docs page is HTTPS.
      </div>
    </div>
  );
}
