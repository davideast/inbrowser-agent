interface PoweredByStripProps {
  /** The agent is running the lookup loop (a tool/lookup step is active). */
  agentLive: boolean;
  /** The model is generating the answer (token streaming, any source). */
  modelLive: boolean;
}

const ITEMS = [
  { key: 'agent', label: 'agent', href: '/agent' },
  { key: 'model', label: 'model', href: '/model' },
] as const;

/**
 * Honest provenance. Shows the inbrowser packages this chat actually runs on —
 * the agent runs the lookup, the model writes the answer — and brightens the one
 * working right now. The chat is fully in-browser (BYOK / on-device), so it
 * genuinely runs on `agent` + `model` only. Liveness is by brightness, never
 * colour (no status dots).
 */
export function PoweredByStrip({ agentLive, modelLive }: PoweredByStripProps) {
  const live: Record<string, boolean> = {
    agent: agentLive,
    model: modelLive,
  };
  return (
    <div className="shrink-0 border-b border-border px-4 md:px-6">
      <div className="max-w-[760px] mx-auto h-8 flex items-center gap-3 text-[11px]">
        <span className="text-dim-text uppercase tracking-widest">powered by</span>
        {ITEMS.map((it) => (
          <a
            key={it.key}
            href={it.href}
            className={`transition-colors ${
              live[it.key] ? 'text-primary' : 'text-dim-text hover:text-secondary'
            }`}
          >
            {live[it.key] ? <span aria-hidden="true">▸ </span> : null}
            {it.label}
          </a>
        ))}
      </div>
    </div>
  );
}
