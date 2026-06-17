import type { ChatTurn } from '../../lib/chat-store';
import { MarkdownAnswer } from '../answer/MarkdownAnswer';
import { SourceCards } from '../answer/SourceCard';

interface ChatThreadProps {
  messages: ChatTurn[];
  busy: boolean;
  status: string;
  error: string;
}

/** The conversation: labeled USER / ASSISTANT blocks (Terminal Modernism). */
export function ChatThread({ messages, busy, status, error }: ChatThreadProps) {
  const lastIsAssistant = messages[messages.length - 1]?.role === 'assistant';

  return (
    <div>
      {messages.map((m, i) => {
        const isLast = i === messages.length - 1;
        const showStatus = busy && isLast && m.role === 'assistant' && !m.text;
        return (
          <div key={`${m.role}-${i}`} className="mb-10">
            <div className="text-[10px] font-medium uppercase tracking-widest text-dim-text mb-2">
              {m.role === 'user' ? 'You' : 'Assistant'}
            </div>
            {m.role === 'user' ? (
              <p className="text-primary text-[15px] leading-[1.7] whitespace-pre-wrap">{m.text}</p>
            ) : (
              <>
                {showStatus ? (
                  <div className="text-[12px] text-dim-text" aria-live="polite">
                    <span className="inline-block animate-pulse" aria-hidden="true">
                      ▸
                    </span>{' '}
                    {status || 'thinking'}…
                  </div>
                ) : null}
                <MarkdownAnswer answer={m.text} />
                <SourceCards cards={m.cards ?? []} />
              </>
            )}
          </div>
        );
      })}

      {/* Status while the agent works before the assistant turn exists. */}
      {busy && !lastIsAssistant ? (
        <div className="mb-10 text-[12px] text-dim-text" aria-live="polite">
          <span className="inline-block animate-pulse" aria-hidden="true">
            ▸
          </span>{' '}
          {status || 'thinking'}…
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mb-10 text-[13px] text-primary border border-border-strong bg-surface p-4"
        >
          <span className="text-dim-text uppercase text-[10px] tracking-widest">Error</span>
          <p className="mt-2">{error}</p>
          <p className="mt-2 text-secondary text-[12px]">
            If this persists, confirm the agent backend is configured (API key / model).
          </p>
        </div>
      ) : null}
    </div>
  );
}
