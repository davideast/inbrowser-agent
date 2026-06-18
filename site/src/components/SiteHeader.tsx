interface SiteHeaderProps {
  /** Toggle the sessions drawer. */
  onMenu: () => void;
  menuOpen: boolean;
}

const GITHUB_URL = 'https://github.com/davideast/inbrowser-agent';

/**
 * Persistent top bar shared by the home (empty state) and the active chat: the
 * sessions toggle, the wordmark, and site nav. It stays put as the empty state
 * collapses into the conversation, so orientation never disappears.
 */
export function SiteHeader({ onMenu, menuOpen }: SiteHeaderProps) {
  return (
    <header className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 md:px-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="text-secondary hover:text-primary text-[18px] leading-none"
          aria-label="Toggle sessions"
          aria-expanded={menuOpen}
          aria-controls="chat-sidebar"
          onClick={onMenu}
        >
          ☰
        </button>
        <a href="/" className="text-[13px] text-primary">
          inbrowser
        </a>
      </div>
      <nav className="flex items-center gap-4 text-[12px] text-secondary">
        <a href="/docs" className="hover:text-primary transition-colors">
          docs
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="hover:text-primary transition-colors"
        >
          GitHub <span aria-hidden="true">↗</span>
        </a>
      </nav>
    </header>
  );
}
