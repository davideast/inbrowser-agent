import type { Session } from '../../lib/chat-store';

interface ChatSidebarProps {
  open: boolean;
  sessions: Session[];
  activeId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  onDelete(id: string): void;
  onClose(): void;
}

/** Session history as a slide-over drawer, toggled from the header. */
export function ChatSidebar({
  open,
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: ChatSidebarProps) {
  return (
    <aside
      id="chat-sidebar"
      aria-hidden={!open}
      className={`fixed inset-y-0 left-0 z-30 w-72 max-w-[85vw] bg-surface border-r border-border-strong flex flex-col transition-transform duration-200 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-border">
        <span className="text-[10px] font-medium uppercase tracking-widest text-dim-text">
          Sessions
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close sessions"
          className="text-secondary hover:text-primary text-[16px] leading-none px-1"
        >
          ×
        </button>
      </div>

      <div className="p-3">
        <button
          type="button"
          onClick={onNew}
          className="w-full text-left text-[11px] font-medium uppercase tracking-widest text-secondary hover:text-primary border border-border-strong hover:border-secondary px-3 py-2 transition-colors"
        >
          + New chat
        </button>
      </div>

      <nav aria-label="Chat history" className="flex-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 ? (
          <p className="text-dim-text text-[12px] px-2 py-2">No conversations yet.</p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => {
              const active = s.id === activeId;
              return (
                <li key={s.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(s.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`w-full text-left text-[13px] px-2 py-2 pr-8 truncate transition-colors ${
                      active ? 'bg-bg text-primary' : 'text-secondary hover:text-primary'
                    }`}
                  >
                    {s.title}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${s.title}`}
                    onClick={() => onDelete(s.id)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-dim-text hover:text-primary opacity-60 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 text-[16px] px-1"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
