import type { ContextWindowSnapshot } from '@inbrowser/agent/usage';
import {
  ContextWindowMeter as HeadlessContextWindowMeter,
  ContextWindowPanel as HeadlessContextWindowPanel,
  Modal,
  RequestUsageTimeline,
  TokenUsageInline,
} from '@pyric/ui/agents';
import { type ReactNode, useState } from 'react';
import type { AgentTurnMetrics } from '../../lib/agent-types';
import { usageFromTurnMetrics } from '../../lib/agent-usage';

interface AgentUsageMeterButtonProps {
  snapshot: ContextWindowSnapshot;
  onOpen: () => void;
}

interface AgentUsageDialogProps {
  open: boolean;
  snapshot: ContextWindowSnapshot;
  onClose: () => void;
}

export function AgentUsageMeterButton({ snapshot, onOpen }: AgentUsageMeterButtonProps) {
  return (
    <HeadlessContextWindowMeter
      snapshot={snapshot}
      onOpen={onOpen}
      className="relative group shrink-0"
      buttonClassName="h-7 w-7 inline-grid place-items-center border border-border text-dim-text hover:text-primary hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-white transition-colors"
      ringClassName="inline-grid place-items-center rounded-full"
      ringInnerClassName="rounded-full bg-bg"
      tooltipClassName="pointer-events-none absolute bottom-full right-0 mb-2 hidden min-w-[176px] border border-border-strong bg-surface px-3 py-2 text-right text-[10px] text-dim-text shadow-xl group-hover:grid group-focus-within:grid gap-0.5 z-30"
    />
  );
}

export function AgentUsageDialog({ open, snapshot, onClose }: AgentUsageDialogProps) {
  const [tab, setTab] = useState<'context' | 'requests'>('context');
  const requestRows = snapshot.sessionUsage?.requestRows ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Context and token usage"
      className="fixed inset-0 z-50"
      backdropClassName="absolute inset-0 bg-bg/80"
      panelClassName="absolute bottom-0 left-0 right-0 h-[72dvh] max-h-[82dvh] overflow-hidden border-t border-border-strong bg-bg md:bottom-auto md:left-1/2 md:right-auto md:top-[8vh] md:h-[min(720px,84dvh)] md:w-[720px] md:-translate-x-1/2 md:border md:shadow-2xl"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-dim-text">
              Agent usage
            </div>
            <h2 className="mt-1 text-[15px] font-medium text-primary">Context and tokens</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-medium uppercase tracking-widest text-secondary hover:text-primary"
          >
            Close
          </button>
        </div>

        <div className="flex shrink-0 border-b border-border px-4">
          <UsageTab active={tab === 'context'} onClick={() => setTab('context')}>
            Context
          </UsageTab>
          <UsageTab active={tab === 'requests'} onClick={() => setTab('requests')}>
            Requests
          </UsageTab>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'context' ? (
            <HeadlessContextWindowPanel
              snapshot={snapshot}
              className="space-y-4 text-[12px] text-secondary"
              slots={usageSlots}
            />
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-[13px] font-medium text-primary">Provider requests</h3>
                  <p className="mt-1 max-w-[54ch] text-[11px] leading-relaxed text-secondary">
                    Past requests are session spend. The main context meter stays focused on the
                    estimated next send.
                  </p>
                </div>
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-dim-text">
                  {requestRows.length} rows
                </span>
              </div>
              <RequestUsageTimeline
                requests={requestRows}
                className="space-y-3"
                slots={usageSlots}
                empty={
                  <div>
                    Request rows appear after the agent records provider-visible traces for this
                    session.
                  </div>
                }
              />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function AgentTurnUsageInline({ metrics }: { metrics?: AgentTurnMetrics }) {
  const usage = usageFromTurnMetrics(metrics);
  return (
    <TokenUsageInline
      usage={usage}
      className="inline-flex items-center gap-2 text-[10px] text-dim-text"
      labelClassName="sr-only"
      valueClassName="tabular-nums"
    />
  );
}

function UsageTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'border-b-2 px-3 py-2 text-[11px] font-medium uppercase tracking-widest transition-colors',
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-secondary hover:text-primary',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

const usageSlots = {
  root: 'space-y-4 text-[12px] text-secondary',
  header: 'flex items-center gap-4',
  body: 'grid grid-cols-2 gap-3 text-[11px]',
  row: 'border border-border bg-surface p-3',
  label: 'text-[10px] uppercase tracking-widest text-dim-text',
  value: 'mt-1 text-primary tabular-nums',
  bar: 'flex h-1.5 w-full overflow-hidden bg-surface',
  segment: 'h-full',
  empty: 'border border-border bg-surface p-4 text-[12px] text-secondary',
} as const;
