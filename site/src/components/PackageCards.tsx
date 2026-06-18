import { NODES, PACKAGE_LABELS, type PackageId } from '../content/graph';

/** Value-first copy: each card leads with the problem the package solves, not
 *  its doc structure. Diataxis navigation lives on the package page and /docs. */
const BLURB: Record<'agent' | 'relay' | 'resumable' | 'model', string> = {
  agent:
    'An agent runtime you own: sessions, tools, and an MCP server, in your code or an external host.',
  relay:
    'Resumable LLM inference. A backgrounded tab, a dropped network, or a reload never loses the stream.',
  resumable:
    'The durable job engine underneath it all: an append-only log you can replay from any offset.',
  model:
    'Open models, on-device. Inference in the browser with no API key and nothing leaving the page.',
};

const PKGS = ['agent', 'relay', 'resumable', 'model'] as const;

/** The package's first tutorial, the best newcomer door; falls back to the
 *  package overview if it has no tutorial yet. */
const tutorialRoute = (pkg: PackageId): string =>
  NODES.find((n) => n.package === pkg && n.category === 'tutorial')?.route ?? `/${pkg}`;

export function PackageCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-px border border-border bg-border">
      {PKGS.map((pkg) => (
        <div
          key={pkg}
          className="group relative bg-bg p-5 transition-colors hover:bg-surface focus-within:ring-1 focus-within:ring-inset focus-within:ring-border-strong"
        >
          {/* The package name is the card's primary link; its stretched ::after
              makes the whole card a click target for the package overview while
              staying a single, properly-named link for keyboard + screen reader. */}
          <a
            href={`/${pkg}`}
            className="text-[12px] text-dim-text transition-colors group-hover:text-secondary after:absolute after:inset-0 after:content-[''] focus:outline-none"
          >
            {PACKAGE_LABELS[pkg]}
          </a>
          <p className="text-primary text-[14px] leading-[1.6] my-3">{BLURB[pkg]}</p>
          {/* Sits above the stretched link (z-10) so it stays independently
              clickable; aria-label names its destination out of context. */}
          <a
            href={tutorialRoute(pkg)}
            aria-label={`Start with the ${PACKAGE_LABELS[pkg]} tutorial`}
            className="relative z-10 text-[12px] text-dim-text transition-colors hover:text-primary focus-visible:text-primary"
          >
            Start here <span aria-hidden="true">→</span>
          </a>
        </div>
      ))}
    </div>
  );
}
