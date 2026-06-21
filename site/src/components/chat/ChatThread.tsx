import type { ChatTurn } from '../../lib/chat-store';
import { AgentActivity } from '../answer/AgentActivity';
import { MarkdownAnswer } from '../answer/MarkdownAnswer';
import { SourceCards } from '../answer/SourceCard';
import { AgentTurnUsageInline } from './AgentUsage';

interface ChatThreadProps {
  messages: ChatTurn[];
  busy: boolean;
  error: string;
  /** jobIds whose durable stream resumed but went quiet (driver tab died). The
   *  matching assistant turn shows a "Continue" affordance. */
  stalledJobs?: ReadonlySet<string>;
  /** Re-run a stalled assistant turn (by its index) as a fresh durable job. */
  onContinue?(turnIndex: number): void;
}

/** The conversation: labeled USER / ASSISTANT blocks (Terminal Modernism).
 *  Each assistant turn keeps a collapsible activity log (persisted on the turn).
 *  The in-flight turn shows live progress + a skeleton; source cards reveal once
 *  that turn is done. */
export function ChatThread({ messages, busy, error, stalledJobs, onContinue }: ChatThreadProps) {
  const lastIsAssistant = messages[messages.length - 1]?.role === 'assistant';

  return (
    <div>
      {messages.map((m, i) => {
        const isLast = i === messages.length - 1;
        const turnBusy = busy && isLast;
        return (
          <div key={`${m.role}-${i}`} className="mb-10">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-widest text-dim-text">
                {m.role === 'user' ? 'You' : 'Assistant'}
              </span>
              {m.role === 'assistant' && m.source ? (
                <span className="text-[10px] text-label">{m.source}</span>
              ) : null}
              {m.role === 'assistant' ? <AgentTurnUsageInline metrics={m.metrics} /> : null}
              {/* Durable-job badge: legible proof a CLOUD turn is backed by a
                  resumable worker job (it survives reload / resumes cross-tab).
                  Spins while this turn is streaming, static once persisted. */}
              {m.role === 'assistant' && m.jobId ? (
                <span
                  className="inline-flex items-center gap-1 border border-border px-1.5 py-px text-[10px] text-label"
                  title="Durable answer: this turn runs as a resumable job in a background worker, so reloading or reopening it mid-stream resumes from the saved log instead of losing the answer."
                >
                  <span
                    aria-hidden="true"
                    className={
                      turnBusy
                        ? 'motion-safe:animate-spin motion-safe:[animation-duration:2.5s]'
                        : ''
                    }
                  >
                    ⟳
                  </span>
                  resumable
                </span>
              ) : null}
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
                {/* Stalled durable job (driver tab died mid-answer): show the
                    partial answer above + a Continue affordance to re-run it. */}
                {!turnBusy && m.jobId && stalledJobs?.has(m.jobId) ? (
                  <div className="mt-3 flex items-center gap-3 border-l-2 border-border-strong pl-3">
                    <span className="text-[12px] text-secondary">This answer stopped early.</span>
                    <button
                      type="button"
                      onClick={() => onContinue?.(i)}
                      className="text-[12px] text-primary border border-border hover:border-border-strong px-3 py-1 transition-colors"
                    >
                      Continue
                    </button>
                  </div>
                ) : null}
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
