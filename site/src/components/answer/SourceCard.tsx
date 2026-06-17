import type { VisitedCard } from '../../lib/agent-types';

/** A grounding source: links to the real doc page the agent opened. */
export function SourceCard({ card }: { card: VisitedCard }) {
  return (
    <a
      href={card.route}
      aria-label={card.title}
      className="group block border border-border-strong bg-surface p-4 hover:border-secondary transition-colors"
    >
      <div className="text-[10px] uppercase tracking-widest text-dim-text mb-1.5">
        {card.breadcrumb.slice(1).join(' / ')}
      </div>
      <div className="text-primary text-[14px] group-hover:underline">
        {card.title} <span aria-hidden="true">→</span>
      </div>
      <p className="text-secondary text-[12px] leading-[1.6] mt-1">{card.summary}</p>
    </a>
  );
}

/** Grid of source cards under an answer. */
export function SourceCards({ cards }: { cards: VisitedCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div className="mt-6">
      <div className="text-[10px] uppercase tracking-widest text-dim-text mb-3">Sources</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {cards.map((card) => (
          <SourceCard key={card.route} card={card} />
        ))}
      </div>
    </div>
  );
}
