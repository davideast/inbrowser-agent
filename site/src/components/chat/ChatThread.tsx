import type { ChatTurn } from '../../lib/chat-store';
import { AgentActivity } from '../answer/AgentActivity';
import { MarkdownAnswer } from '../answer/MarkdownAnswer';
import { SourceCards } from '../answer/SourceCard';

interface ChatThreadProps {
  messages: ChatTurn[];
  busy: boolean;
  error: string;
}

/** The conversation: labeled USER / ASSISTANT blocks (Terminal Modernism).
 *  Each assistant turn keeps a collapsible activity log (persisted on the turn).
 *  The in-flight turn shows live progress + a skeleton; source cards reveal once
 *  that turn is done. */
export function ChatThread({ messages, busy, error }: ChatThreadProps) {
  const lastIsAssistant = messages[messages.length - 1]?.role === 'assistant';

  return (
    <div>
      {messages.map((m, i) => {
        const isLast = i === messages.length - 1;
        const turnBusy = busy && isLast;
        return (
          <div key={`${m.role}-${i}`} className="mb-10">
            <div className="text-[10px] font-medium uppercase tracking-widest text-dim-text mb-2">
              {m.role === 'user' ? 'You' : 'Assistant'}
            </div>
            {m.role === 'user' ? (
              <p className="text-primary text-[15px] leading-[1.7] whitespace-pre-wrap">{m.text}</p>
            ) : (
              <>
                <AgentActivity steps={m.steps ?? []} busy={turnBusy} hasText={!!m.text} />
                <MarkdownAnswer answer={m.text} />
                {/* Sources reveal once the turn is done — surfacing the clickable
                    cards mid-stream pulls focus from the answer. */}
                {turnBusy ? null : <SourceCards cards={m.cards ?? []} />}
              </>
            )}
          </div>
        );
      })}

      {/* Pre-assistant phase: busy before the first tool/token creates the
          assistant turn — show the working header + skeleton so there's no dead air. */}
      {busy && !lastIsAssistant ? (
        <div className="mb-10">
          <div className="text-[10px] font-medium uppercase tracking-widest text-dim-text mb-2">
            Assistant
          </div>
          <AgentActivity steps={[]} busy hasText={false} />
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
