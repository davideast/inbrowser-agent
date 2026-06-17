import { useEffect, useState } from 'react';
import type { AgentStep } from '../../lib/agent-types';

export type { AgentStep };

/**
 * Agent activity log + answer skeleton (Terminal Modernism).
 *
 * A persistent, collapsible event log of the tool calls the agent makes
 * (search_docs, get_doc, …) — the active step pulses, prior steps check off,
 * and each row carries its raw tool name as metadata. The log does NOT vanish
 * when the turn finishes: it auto-collapses to a one-line summary you can
 * re-open (and, when persisted on the turn, survives scroll-back + reload).
 *
 * Progress is continuous: a "Working" pulse shows in the header the whole time
 * the agent is busy (between tool calls AND while the answer streams), and a
 * shimmer skeleton stands in for the answer until the first token arrives.
 */

const TOOL_VERBS: Record<string, string> = {
  search_docs: 'Searched docs',
  get_doc: 'Read page',
  related_docs: 'Found related',
  list_packages: 'Listed packages',
  list_docs: 'Listed docs',
  compose: 'Composed answer',
};

const verbFor = (name: string): string => TOOL_VERBS[name] ?? name.replace(/_/g, ' ');

export function AgentActivity({
  steps,
  busy,
  hasText,
}: {
  steps: AgentStep[];
  busy: boolean;
  hasText: boolean;
}) {
  // Open while the agent works; collapse to a summary once the turn settles.
  // Manual toggling sticks until `busy` next changes (i.e. for the lifetime of
  // a finished turn), so re-opening a past turn's log stays open.
  const [open, setOpen] = useState(busy);
  useEffect(() => setOpen(busy), [busy]);

  if (steps.length === 0 && !busy) return null;

  const count = steps.length;
  const showSkeleton = busy && !hasText;

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-dim-text hover:text-secondary transition-colors"
      >
        <span
          aria-hidden="true"
          className={`text-[9px] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
        {busy ? (
          <span className="flex items-center gap-2 text-secondary">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse"
              aria-hidden="true"
            />
            Working
          </span>
        ) : (
          <span>Activity</span>
        )}
        {count > 0 ? (
          <span className="text-dim-text normal-case tracking-normal">
            · {count} step{count === 1 ? '' : 's'}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="mt-3">
          {count > 0 ? (
            <ol className="border-l border-border-strong pl-4 space-y-2.5" aria-live="polite">
              {steps.map((s, i) => {
                const active = busy && i === count - 1 && !hasText;
                return (
                  <li key={`${s.name}-${i}-${s.detail}`} className="leading-snug">
                    <div className="flex items-baseline gap-2 text-[12px]">
                      <span
                        aria-hidden="true"
                        className={active ? 'text-primary animate-pulse' : 'text-dim-text'}
                      >
                        {active ? '▸' : '✓'}
                      </span>
                      <span className="min-w-0">
                        <span className="text-secondary">{verbFor(s.name)}</span>
                        {s.detail ? <span className="text-dim-text"> · {s.detail}</span> : null}
                      </span>
                    </div>
                    <div className="pl-[18px] mt-0.5 text-[10px] text-dim leading-none">
                      {s.name}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}

          {showSkeleton ? (
            <div className={`space-y-2.5 ${count > 0 ? 'mt-4' : ''}`} aria-hidden="true">
              <div className="h-3 w-[92%] skeleton-bar" />
              <div className="h-3 w-[78%] skeleton-bar" />
              <div className="h-3 w-[85%] skeleton-bar" />
              <div className="h-3 w-[58%] skeleton-bar" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
