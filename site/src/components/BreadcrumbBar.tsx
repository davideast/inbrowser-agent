interface Crumb {
  label: string;
  href?: string;
}

interface BreadcrumbBarProps {
  crumbs: Crumb[];
}

/**
 * Sticky top navigation bar tracking the Home / Package / Category / Page
 * hierarchy. Primary wayfinding for the site (the example's left sidebar
 * is intentionally dropped). Rendered statically — no interactivity, so
 * no client directive is needed.
 *
 * Exposed as a labelled breadcrumb: nav[aria-label] > ol > li, with
 * aria-current on the final crumb and decorative separators hidden from
 * assistive tech.
 */
export function BreadcrumbBar({ crumbs }: BreadcrumbBarProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur-[20px]">
      <div className="max-w-[860px] mx-auto px-6 flex items-center justify-between gap-4">
        <nav aria-label="Breadcrumb" className="py-3 text-[12px] min-w-0">
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {crumbs.map((crumb, i) => {
              const isLast = i === crumbs.length - 1;
              return (
                <li key={`${crumb.label}-${i}`} className="flex items-center gap-x-2">
                  {i > 0 ? (
                    <span className="text-dim select-none" aria-hidden="true">
                      /
                    </span>
                  ) : null}
                  {crumb.href && !isLast ? (
                    <a
                      className="text-secondary hover:text-primary transition-colors"
                      href={crumb.href}
                    >
                      {crumb.label}
                    </a>
                  ) : (
                    <span
                      className={isLast ? 'text-primary' : 'text-secondary'}
                      aria-current={isLast ? 'page' : undefined}
                    >
                      {crumb.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <a
          href="/chat"
          className="text-[12px] text-secondary hover:text-primary transition-colors shrink-0"
        >
          Chat <span aria-hidden="true">→</span>
        </a>
      </div>
    </header>
  );
}
