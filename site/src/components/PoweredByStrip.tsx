interface PoweredByStripProps {
  /** The agent is running the lookup loop (a tool/lookup step is active). */
  agentLive: boolean;
  /** The relay provider is streaming the answer (tokens are arriving). */
  relayLive: boolean;
  /** A durable resumable job is in flight (every event is stored + replayable). */
  resumableLive: boolean;
}

const ITEMS = [
  { key: 'agent', label: 'agent', href: '/agent' },
  { key: 'relay', label: 'relay', href: '/relay' },
  { key: 'resumable', label: 'resumable', href: '/resumable' },
] as const;

/**
 * Honest provenance. Shows the inbrowser packages this chat actually runs on -
 * the agent runs the lookup, the relay streams the answer, and resumable keeps
 * every answer a durable, replayable job - and brightens the ones working right
 * now. Liveness is by brightness, never colour (no status dots). `model` is
 * deliberately absent until the chat genuinely runs on-device (phase 5b);
 * showing it dark would imply a claim we have not earned.
 */
export function PoweredByStrip({ agentLive, relayLive, resumableLive }: PoweredByStripProps) {
  const live: Record<string, boolean> = {
    agent: agentLive,
    relay: relayLive,
    resumable: resumableLive,
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
