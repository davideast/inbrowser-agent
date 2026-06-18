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
        <div key={pkg} className="bg-bg p-5">
          <a
            href={`/${pkg}`}
            className="text-[12px] text-dim-text hover:text-primary transition-colors"
          >
            {PACKAGE_LABELS[pkg]}
          </a>
          <p className="text-primary text-[14px] leading-[1.6] my-3">{BLURB[pkg]}</p>
          <a
            href={tutorialRoute(pkg)}
            className="text-[12px] text-dim-text hover:text-primary transition-colors"
          >
            Start here <span aria-hidden="true">→</span>
          </a>
        </div>
      ))}
    </div>
  );
}
