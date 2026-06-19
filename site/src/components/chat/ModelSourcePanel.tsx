/**
 * Unified model-source selector for the docs chat (replaces the old OnDeviceBar).
 * Terminal Modernism: mono, brightness not colour, `▸` liveness, thin borders, no
 * status dots. A compact custom dropdown picks the SOURCE; the active source's
 * config (and, for WebGPU, the redesigned loading panel) renders inline below.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type ModelSource, SOURCE_META } from '../../lib/model-source';
import { type OnDevicePreset, PRESET_META, hasWebGPU } from '../../lib/on-device-agent';

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

const SOURCE_ORDER: ModelSource[] = ['gemini', 'webgpu', 'openrouter', 'ollama'];

const PRESET_ORDER: OnDevicePreset[] = ['smollm2_360m', 'gemma4_e2b', 'gemma4_e4b'];

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
  // Ollama
  ollamaModel: string;
  onOllamaModel(v: string): void;
  ollamaBaseUrl: string;
  onOllamaBaseUrl(v: string): void;
}

export function ModelSourcePanel(props: ModelSourcePanelProps) {
  const { source } = props;
  const webgpuAvailable = hasWebGPU();
  // Recommended source: on-device when the GPU is there, else zero-config cloud.
  const recommended: ModelSource = webgpuAvailable ? 'webgpu' : 'gemini';

  return (
    <div className="shrink-0 border-b border-border bg-bg">
      <div className="max-w-[760px] mx-auto px-4 md:px-6 py-2 text-[11px] text-secondary">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-dim-text uppercase tracking-widest">model</span>
          <SourceDropdown
            source={source}
            onSource={props.onSource}
            recommended={recommended}
            webgpuAvailable={webgpuAvailable}
            status={props.status}
            webgpuPreset={props.webgpuPreset}
            openrouterModel={props.openrouterModel}
            openrouterKey={props.openrouterKey}
            ollamaModel={props.ollamaModel}
          />
        </div>
        <SourceConfig {...props} webgpuAvailable={webgpuAvailable} />
      </div>
    </div>
  );
}

/** Closed = one line summarizing the active source + state. Open = 4 rows. */
function SourceDropdown({
  source,
  onSource,
  recommended,
  webgpuAvailable,
  status,
  webgpuPreset,
  openrouterModel,
  openrouterKey,
  ollamaModel,
}: {
  source: ModelSource;
  onSource(s: ModelSource): void;
  recommended: ModelSource;
  webgpuAvailable: boolean;
  status: ModelStatus;
  webgpuPreset: OnDevicePreset;
  openrouterModel: string;
  openrouterKey: string;
  ollamaModel: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const summary = useMemo(
    () =>
      summarizeSource(source, {
        status,
        webgpuPreset,
        openrouterModel,
        openrouterKey,
        ollamaModel,
      }),
    [source, status, webgpuPreset, openrouterModel, openrouterKey, ollamaModel],
  );

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
      setOpen(false);
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
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        className="inline-flex items-center gap-2 border border-border hover:border-border-strong bg-surface px-2 py-1 text-[11px] text-primary transition-colors"
      >
        <span aria-hidden="true" className={summary.live ? 'text-primary' : 'text-dim-text'}>
          ▸
        </span>
        <span>{summary.text}</span>
        <span aria-hidden="true" className="text-dim-text">
          ▾
        </span>
      </button>
      {open ? (
        <div
          id={listId}
          // biome-ignore lint/a11y/useSemanticElements: a native <select> can't carry the rich rows (kind · requirement · ★ recommended · capability gating) the plan calls for
          role="listbox"
          aria-label="Model source"
          aria-activedescendant={`${listId}-${active}`}
          tabIndex={-1}
          className="absolute z-30 mt-1 min-w-[300px] border border-border-strong bg-surface shadow-lg"
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
                className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer select-none ${
                  isActive ? 'bg-bg' : ''
                } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <span
                  className={s === source ? 'text-primary' : 'text-dim-text'}
                  aria-hidden="true"
                >
                  {s === source ? '▸' : '·'}
                </span>
                <span className={disabled ? 'text-secondary' : 'text-primary'}>{meta.label}</span>
                <span className="text-dim-text">· {meta.kind}</span>
                <span className="text-dim-text">
                  · {disabled ? 'needs WebGPU' : meta.requirement}
                </span>
                {s === recommended && !disabled ? (
                  <span className="ml-auto text-secondary" title="recommended">
                    ★ recommended
                  </span>
                ) : null}
              </div>
            );
          })}
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
    webgpuPreset: OnDevicePreset;
    openrouterModel: string;
    openrouterKey: string;
    ollamaModel: string;
  },
): { text: string; live: boolean } {
  const meta = SOURCE_META[source];
  if (source === 'gemini') return { text: `${meta.label} · cloud`, live: false };
  if (source === 'webgpu') {
    const label = PRESET_META[ctx.webgpuPreset].label;
    const state =
      ctx.status.phase === 'ready'
        ? `${ctx.status.backend} · ready`
        : ctx.status.phase === 'loading'
          ? STEP_TEXT[ctx.status.step].toLowerCase()
          : ctx.status.phase === 'error'
            ? 'load failed'
            : 'not loaded';
    return { text: `${meta.label} · ${label} · ${state}`, live: ctx.status.phase === 'ready' };
  }
  if (source === 'openrouter') {
    const state = ctx.openrouterKey.trim() ? 'ready' : 'needs key';
    return { text: `${meta.label} · ${shortModel(ctx.openrouterModel)} · ${state}`, live: false };
  }
  // ollama
  const state = ctx.ollamaModel.trim() ? 'ready' : 'needs model';
  return { text: `${meta.label} · ${ctx.ollamaModel || 'no model'} · ${state}`, live: false };
}

function shortModel(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Per-source configuration (shown when that source is active). */
function SourceConfig(props: ModelSourcePanelProps & { webgpuAvailable: boolean }) {
  const { source } = props;
  if (source === 'gemini') {
    return (
      <div className="mt-1.5 text-dim-text">· cloud · no setup · the server holds the key</div>
    );
  }
  if (source === 'webgpu') return <WebgpuConfig {...props} />;
  if (source === 'openrouter') return <OpenrouterConfig {...props} />;
  return <OllamaConfig {...props} />;
}

function WebgpuConfig({
  webgpuPreset,
  onWebgpuPreset,
  status,
  onLoad,
  cachedPresets,
  storagePersisted,
  webgpuAvailable,
}: ModelSourcePanelProps & { webgpuAvailable: boolean }) {
  return (
    <div className="mt-2 space-y-2">
      {/* Secondary preset picker. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESET_ORDER.map((p) => {
          const meta = PRESET_META[p];
          const gated = meta.needsWebGPU && !webgpuAvailable;
          const selected = p === webgpuPreset;
          return (
            <button
              key={p}
              type="button"
              disabled={gated || status.phase === 'loading'}
              aria-pressed={selected}
              onClick={() => onWebgpuPreset(p)}
              className={`border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed ${
                selected
                  ? 'border-border-strong bg-surface text-primary'
                  : 'border-border text-secondary hover:border-border-strong'
              } ${gated ? 'opacity-40' : ''}`}
              title={gated ? 'needs WebGPU' : meta.note}
            >
              <span>{meta.label}</span>
              <span className="text-dim-text"> {meta.sizeLabel}</span>
              <span className="text-dim-text"> · {meta.quality}</span>
              {meta.needsWebGPU ? <span className="text-dim-text"> · GPU</span> : null}
              {cachedPresets.has(p) ? (
                <span className="text-secondary" title="cached · instant">
                  {' '}
                  ✓
                </span>
              ) : null}
              {gated ? <span className="text-dim-text"> · needs WebGPU</span> : null}
            </button>
          );
        })}
      </div>

      {/* Load button + redesigned loading panel / ready / error. */}
      {status.phase === 'idle' ? (
        <button
          type="button"
          onClick={onLoad}
          disabled={PRESET_META[webgpuPreset].needsWebGPU && !webgpuAvailable}
          className="text-primary hover:underline disabled:opacity-40 disabled:no-underline"
        >
          download &amp; load · {PRESET_META[webgpuPreset].note}
        </button>
      ) : status.phase === 'loading' ? (
        <LoadingPanel preset={webgpuPreset} status={status} />
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
 */
function LoadingPanel({
  preset,
  status,
}: {
  preset: OnDevicePreset;
  status: Extract<ModelStatus, { phase: 'loading' }>;
}) {
  const downloading = status.step === 'download';
  const phases: Array<{ key: 'download' | 'compile' | 'warmup'; label: string }> = [
    { key: 'download', label: 'download' },
    { key: 'compile', label: 'compile' },
    { key: 'warmup', label: 'warm up' },
  ];
  return (
    <div className="min-h-[68px] border border-border bg-surface px-3 py-2">
      <div className="flex items-center justify-between text-secondary">
        <span>
          {STEP_TEXT[status.step]}
          <span className="text-dim-text"> · {PRESET_META[preset].label}</span>
        </span>
        {downloading ? (
          <span className="text-dim-text tabular-nums">
            {formatBytes(status.loadedBytes)} / {formatBytes(status.totalBytes)}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 h-1.5 w-full bg-bg border border-border overflow-hidden">
        <div
          className="h-full bg-primary transition-[width] duration-200 ease-out"
          style={{ width: downloading ? `${status.pct}%` : '100%' }}
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
        {downloading ? (
          <span className="ml-auto text-secondary tabular-nums">{status.pct}%</span>
        ) : null}
      </div>
    </div>
  );
}

function OpenrouterConfig({
  openrouterKey,
  onOpenrouterKey,
  openrouterModel,
  onOpenrouterModel,
}: ModelSourcePanelProps) {
  const keyId = useId();
  const modelId = useId();
  const ready = openrouterKey.trim().length > 0;
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
          value={openrouterKey}
          onChange={(e) => onOpenrouterKey(e.target.value)}
          placeholder="sk-or-…"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[220px] transition-colors"
        />
        <label htmlFor={modelId} className="text-dim-text">
          model
        </label>
        <input
          id={modelId}
          type="text"
          value={openrouterModel}
          onChange={(e) => onOpenrouterModel(e.target.value)}
          placeholder="openai/gpt-4o-mini"
          className="bg-bg border border-border focus:border-primary outline-none px-2 py-1 text-[11px] text-primary placeholder:text-dim-text w-[200px] transition-colors"
        />
        <span className={ready ? 'text-primary' : 'text-dim-text'}>
          <span aria-hidden="true">{ready ? '▸ ' : '· '}</span>
          {ready ? 'ready' : 'needs key'}
        </span>
      </div>
      <div className="text-dim-text">
        Your key is sent browser-direct to OpenRouter and stored only in this browser.
      </div>
    </div>
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
  // A browser on an HTTPS page can't reach http://localhost (mixed content).
  const httpsBlocked =
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    /^http:\/\//.test(ollamaBaseUrl.trim());
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
      {httpsBlocked ? (
        <div className="text-secondary">
          served over HTTPS — a browser can't reach http://localhost (open the site on localhost to
          use Ollama).
        </div>
      ) : null}
      <div className="text-dim-text">
        Browser-direct to your local Ollama. Run it with{' '}
        <code className="text-secondary">OLLAMA_ORIGINS</code> set so this origin is allowed.
      </div>
    </div>
  );
}
