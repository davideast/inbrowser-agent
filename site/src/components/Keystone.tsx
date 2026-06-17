import { useCallback, useRef, useState } from 'react';
import type { VisitedCard } from '../lib/agent-types';
import { streamAgent } from '../lib/stream-client';
import { AgentActivity, type AgentStep } from './answer/AgentActivity';
import { MarkdownAnswer } from './answer/MarkdownAnswer';
import { SourceCards } from './answer/SourceCard';

type Phase = 'idle' | 'streaming' | 'done' | 'error';

/**
 * Keystone demo: ask a question, the server-side agent traverses the
 * content graph (surfaced as a live status + nav cards for each doc it
 * opens) and streams a grounded answer. Cards link to the real pages.
 */
export function Keystone() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [cards, setCards] = useState<VisitedCard[]>([]);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setAnswer('');
    setCards([]);
    setError('');
    setSteps([]);
    setPhase('streaming');

    try {
      await streamAgent(
        '/api/ask',
        { q },
        {
          onToken: (text) => {
            setAnswer((a) => a + text);
          },
          onTool: (name, detail) => {
            setSteps((prev) => [...prev, { name, detail }]);
          },
          onVisited: (card) =>
            setCards((c) => (c.some((x) => x.route === card.route) ? c : [...c, card])),
          onError: (message) => {
            setError(message);
            setPhase('error');
          },
          onDone: () => {
            setPhase('done');
          },
        },
        ctrl.signal,
      );
      setPhase((p) => (p === 'streaming' ? 'done' : p));
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, []);

  const onSubmit = useCallback(
    (e: { preventDefault(): void }) => {
      e.preventDefault();
      const q = question.trim();
      if (q) run(q);
    },
    [question, run],
  );

  const busy = phase === 'streaming';

  return (
    <section className="mb-24" aria-busy={busy}>
      {/* Single polite live region — announces once when the run settles. */}
      <div className="sr-only" aria-live="polite">
        {phase === 'done'
          ? 'Answer ready'
          : phase === 'error'
            ? 'The assistant is unavailable'
            : ''}
      </div>

      <div className="mb-5">
        <span className="text-[11px] font-medium uppercase tracking-widest text-label leading-none">
          Ask the docs
        </span>
      </div>

      <form onSubmit={onSubmit}>
        <label htmlFor="keystone-q" className="sr-only">
          Ask a question about the inbrowser packages
        </label>
        <div className="flex items-center gap-3 border-b-2 border-border-strong focus-within:border-primary py-3 transition-colors">
          <span className="text-dim-text select-none" aria-hidden="true">
            &gt;
          </span>
          <input
            id="keystone-q"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How do I resume a stream after a disconnect?"
            autoComplete="off"
            className="flex-1 bg-transparent text-primary placeholder:text-dim-text outline-none text-[16px]"
          />
          <button
            type="submit"
            disabled={busy || !question.trim()}
            className="text-[11px] font-medium uppercase tracking-widest text-secondary hover:text-primary disabled:opacity-40 disabled:hover:text-secondary py-2 -my-2"
          >
            {busy ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>

      <div className="mt-6">
        <AgentActivity steps={steps} busy={busy} hasText={!!answer} />
      </div>

      {error ? (
        <div className="mt-6 text-[13px] text-primary border border-border-strong bg-surface p-4">
          <span className="text-dim-text uppercase text-[10px] tracking-widest">Error</span>
          <p className="mt-2">{error}</p>
          <p className="mt-2 text-secondary text-[12px]">
            If this persists, confirm the agent backend is configured (API key / model).
          </p>
        </div>
      ) : null}

      <MarkdownAnswer answer={answer} className="mt-8" />
      {/* Sources appear at the end, after the answer renders — not mid-stream. */}
      {busy ? null : <SourceCards cards={cards} />}
    </section>
  );
}
