import type {
  ContextWindowSnapshot,
  SessionRequestUsage,
  SessionTokenUsage,
} from '@inbrowser/agent/usage';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
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
    <ContextWindowMeter
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
      panelClassName="absolute bottom-0 left-0 right-0 h-[72dvh] max-h-[82dvh] overflow-hidden border-t border-border-strong bg-bg md:bottom-auto md:left-1/2 md:right-auto md:top-[8vh] md:h-[min(720px,84dvh)] md:w-[720px] md:max-w-[calc(100dvw-2rem)] md:-translate-x-1/2 md:border md:shadow-2xl"
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
            <ContextWindowPanel
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

type ClassSlots = {
  root?: string;
  header?: string;
  body?: string;
  row?: string;
  label?: string;
  value?: string;
  bar?: string;
  segment?: string;
  empty?: string;
};

const STATUS_COLORS: Record<ContextWindowSnapshot['status'], string> = {
  unknown: '#8b8b95',
  low: '#a4d4a8',
  medium: '#f0c36a',
  high: '#f08a8a',
  critical: '#ff5c7a',
};

function Modal({
  open,
  onClose,
  children,
  ariaLabel,
  className,
  backdropClassName,
  panelClassName,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
  backdropClassName?: string;
  panelClassName?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <dialog
      open
      aria-label={ariaLabel}
      data-pyric-ui="modal"
      className={[
        'm-0 h-[100dvh] w-[100dvw] max-h-none max-w-none overflow-hidden border-0 bg-transparent p-0',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        data-pyric-modal-backdrop
        className={['appearance-none border-0 p-0', backdropClassName].filter(Boolean).join(' ')}
        onClick={onClose}
        aria-label="Close context and token usage"
      />
      <div data-pyric-modal-panel className={panelClassName}>
        {children}
      </div>
    </dialog>
  );
}

function ContextWindowRing({
  snapshot,
  size = 20,
  className,
  innerClassName,
  style,
}: {
  snapshot: ContextWindowSnapshot;
  size?: number;
  className?: string;
  innerClassName?: string;
  style?: CSSProperties;
}) {
  const pct =
    snapshot.percentFull === undefined ? 0.28 : Math.max(0, Math.min(1, snapshot.percentFull));
  const degrees = Math.max(10, Math.round(pct * 360));
  const color = `var(--pyric-context-window-status-color, ${STATUS_COLORS[snapshot.status]})`;
  const track = 'var(--pyric-context-window-track-color, #3a3a45)';
  const innerSize = Math.max(8, size - Math.max(6, Math.round(size * 0.34)));

  return (
    <span
      data-pyric-ui="context-window-ring"
      data-status={snapshot.status}
      data-basis={snapshot.basis}
      className={className}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        borderRadius: '999px',
        width: size,
        height: size,
        background: `conic-gradient(${color} ${degrees}deg, ${track} ${degrees}deg)`,
        ...style,
      }}
      aria-hidden="true"
    >
      <span
        data-pyric-ui="context-window-ring-inner"
        className={innerClassName}
        style={{
          display: 'block',
          borderRadius: '999px',
          width: innerSize,
          height: innerSize,
          background: 'var(--pyric-context-window-inner-color, currentColor)',
        }}
      />
    </span>
  );
}

function ContextWindowMeter({
  snapshot,
  onOpen,
  className,
  buttonClassName,
  tooltipClassName,
  ringClassName,
  ringInnerClassName,
  formatTokens = formatCompactTokens,
}: {
  snapshot: ContextWindowSnapshot;
  onOpen?: () => void;
  className?: string;
  buttonClassName?: string;
  tooltipClassName?: string;
  ringClassName?: string;
  ringInnerClassName?: string;
  formatTokens?: (tokens: number) => string;
}) {
  const title = `Context window: ${formatPercent(snapshot)} · ${formatRatio(snapshot, formatTokens)}`;
  return (
    <span
      data-pyric-ui="context-window-meter"
      data-status={snapshot.status}
      data-basis={snapshot.basis}
      className={className}
    >
      <button
        type="button"
        onClick={onOpen}
        className={buttonClassName}
        aria-label="Open context window details"
        title={title}
      >
        <ContextWindowRing
          snapshot={snapshot}
          size={20}
          className={ringClassName}
          innerClassName={ringInnerClassName}
        />
      </button>
      <span data-pyric-ui="context-window-meter-tooltip" className={tooltipClassName}>
        <span data-pyric-ui="context-window-meter-percent">{formatPercent(snapshot)}</span>
        <span data-pyric-ui="context-window-meter-ratio">
          {formatRatio(snapshot, formatTokens)}
        </span>
      </span>
    </span>
  );
}

function TokenUsageInline({
  usage,
  className,
  labelClassName,
  valueClassName,
  formatTokens = formatCompactTokens,
}: {
  usage?: SessionTokenUsage;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  formatTokens?: (tokens: number) => string;
}) {
  if (!usage) return null;
  return (
    <dl data-pyric-ui="token-usage-inline" className={className}>
      <MetricTerm
        label="input"
        value={formatTokens(usage.inputTokens)}
        labelClassName={labelClassName}
        valueClassName={valueClassName}
      />
      <MetricTerm
        label="output"
        value={formatTokens(usage.outputTokens)}
        labelClassName={labelClassName}
        valueClassName={valueClassName}
      />
      {usage.cachedInputTokens > 0 ? (
        <MetricTerm
          label="cached"
          value={formatTokens(usage.cachedInputTokens)}
          labelClassName={labelClassName}
          valueClassName={valueClassName}
        />
      ) : null}
      {usage.reasoningTokens > 0 ? (
        <MetricTerm
          label="reasoning"
          value={formatTokens(usage.reasoningTokens)}
          labelClassName={labelClassName}
          valueClassName={valueClassName}
        />
      ) : null}
    </dl>
  );
}

function SessionSpendSummary({
  usage,
  currentContextTokens,
  className,
  slots,
  formatTokens = formatCompactTokens,
}: {
  usage?: SessionTokenUsage;
  currentContextTokens?: number;
  className?: string;
  slots?: ClassSlots;
  formatTokens?: (tokens: number) => string;
}) {
  if (!usage || usage.tokensTotal <= 0) return null;
  const contextCopies =
    usage.workMultiplier ??
    (currentContextTokens && currentContextTokens > 0
      ? usage.tokensTotal / currentContextTokens
      : undefined);

  return (
    <section data-pyric-ui="session-spend-summary" className={className ?? slots?.root}>
      <div data-pyric-ui="session-spend-summary-header" className={slots?.header}>
        <span data-pyric-ui="session-spend-summary-title">Overall session spend</span>
        <span data-pyric-ui="session-spend-summary-total">{formatTokens(usage.tokensTotal)}</span>
      </div>
      <dl data-pyric-ui="session-spend-summary-body" className={slots?.body}>
        <MetricTerm
          label="turns"
          value={usage.turns.toLocaleString()}
          labelClassName={slots?.label}
          valueClassName={slots?.value}
        />
        <MetricTerm
          label="requests"
          value={usage.requests === null ? 'unknown' : usage.requests.toLocaleString()}
          labelClassName={slots?.label}
          valueClassName={slots?.value}
        />
        <MetricTerm
          label="average request"
          value={usage.averageRequestTokens ? formatTokens(usage.averageRequestTokens) : 'n/a'}
          labelClassName={slots?.label}
          valueClassName={slots?.value}
        />
        <MetricTerm
          label="context multiplier"
          value={contextCopies ? `${formatMultiplier(contextCopies)}x` : 'n/a'}
          labelClassName={slots?.label}
          valueClassName={slots?.value}
        />
      </dl>
      <TokenUsageInline
        usage={usage}
        className={slots?.row}
        labelClassName={slots?.label}
        valueClassName={slots?.value}
        formatTokens={formatTokens}
      />
    </section>
  );
}

function RequestUsageTimeline({
  requests,
  className,
  slots,
  formatTokens = formatCompactTokens,
  empty,
}: {
  requests: readonly SessionRequestUsage[];
  className?: string;
  slots?: ClassSlots;
  formatTokens?: (tokens: number) => string;
  empty?: ReactNode;
}) {
  if (requests.length === 0) {
    return (
      <div data-pyric-ui="request-usage-timeline-empty" className={slots?.empty ?? className}>
        {empty ?? 'No request usage rows available.'}
      </div>
    );
  }

  return (
    <ol data-pyric-ui="request-usage-timeline" className={className ?? slots?.root}>
      {requests.map((request) => (
        <li
          key={request.id}
          data-pyric-ui="request-usage-row"
          data-usage-source={request.usageSource}
          data-provider={request.providerId}
          className={slots?.row}
        >
          <div data-pyric-ui="request-usage-row-header" className={slots?.header}>
            <span data-pyric-ui="request-usage-row-title">Request {request.iteration + 1}</span>
            <span data-pyric-ui="request-usage-row-total">{formatTokens(request.tokensTotal)}</span>
          </div>
          <SegmentBar
            rows={[
              ['fresh-input', request.freshInputTokens, '#8bb7ff'],
              ['cached-input', request.cachedInputTokens, '#a4d4a8'],
              ['visible-output', request.visibleOutputTokens, '#f0c36a'],
              ['reasoning-output', request.reasoningTokens, '#c9a7ff'],
            ]}
            total={Math.max(1, request.tokensTotal)}
            barClassName={slots?.bar}
            segmentClassName={slots?.segment}
          />
          <dl data-pyric-ui="request-usage-row-metrics" className={slots?.body}>
            <MetricTerm
              label="input"
              value={formatTokens(request.inputTokens)}
              labelClassName={slots?.label}
              valueClassName={slots?.value}
            />
            <MetricTerm
              label="output"
              value={formatTokens(request.outputTokens)}
              labelClassName={slots?.label}
              valueClassName={slots?.value}
            />
            <MetricTerm
              label="messages"
              value={request.messageCount.toLocaleString()}
              labelClassName={slots?.label}
              valueClassName={slots?.value}
            />
          </dl>
        </li>
      ))}
    </ol>
  );
}

function ContextWindowPanel({
  snapshot,
  className,
  slots,
  formatTokens = formatCompactTokens,
}: {
  snapshot: ContextWindowSnapshot;
  className?: string;
  slots?: ClassSlots;
  formatTokens?: (tokens: number) => string;
}) {
  return (
    <section
      data-pyric-ui="context-window-panel"
      data-status={snapshot.status}
      data-basis={snapshot.basis}
      className={className ?? slots?.root}
    >
      <header data-pyric-ui="context-window-panel-header" className={slots?.header}>
        <ContextWindowRing snapshot={snapshot} size={56} />
        <div>
          <div data-pyric-ui="context-window-panel-percent">{formatPercent(snapshot)}</div>
          <div data-pyric-ui="context-window-panel-ratio">
            {formatRatio(snapshot, formatTokens)}
          </div>
        </div>
      </header>
      <SegmentBar
        rows={snapshot.breakdown.map((row) => [row.id, row.tokens, row.color])}
        total={Math.max(1, snapshot.usedTokens)}
        barClassName={slots?.bar}
        segmentClassName={slots?.segment}
      />
      <dl data-pyric-ui="context-window-breakdown" className={slots?.body}>
        {snapshot.breakdown.map((row) => (
          <MetricTerm
            key={row.id}
            label={row.label}
            value={formatTokens(row.tokens)}
            labelClassName={slots?.label}
            valueClassName={slots?.value}
          />
        ))}
      </dl>
      <SessionSpendSummary
        usage={snapshot.sessionUsage}
        currentContextTokens={snapshot.usedTokens}
        slots={slots}
        formatTokens={formatTokens}
      />
    </section>
  );
}

function MetricTerm({
  label,
  value,
  labelClassName,
  valueClassName,
}: {
  label: string;
  value: string;
  labelClassName?: string;
  valueClassName?: string;
}) {
  return (
    <div data-pyric-ui="metric-term">
      <dt data-pyric-ui="metric-label" className={labelClassName}>
        {label}
      </dt>
      <dd data-pyric-ui="metric-value" className={valueClassName}>
        {value}
      </dd>
    </div>
  );
}

function SegmentBar({
  rows,
  total,
  barClassName,
  segmentClassName,
}: {
  rows: readonly (readonly [id: string, tokens: number, color: string])[];
  total: number;
  barClassName?: string;
  segmentClassName?: string;
}) {
  const visibleRows = rows.filter(([, tokens]) => tokens > 0);
  if (visibleRows.length === 0) return null;
  return (
    <div data-pyric-ui="token-segment-bar" className={barClassName}>
      {visibleRows.map(([id, tokens, color]) => (
        <span
          key={id}
          data-pyric-ui="token-segment"
          data-segment={id}
          className={segmentClassName}
          style={{
            display: 'inline-block',
            width: `${Math.max(1, (tokens / total) * 100)}%`,
            background: `var(--pyric-token-segment-${id}, ${color})`,
          }}
        />
      ))}
    </div>
  );
}

function formatRatio(
  snapshot: ContextWindowSnapshot,
  formatTokens: (tokens: number) => string,
): string {
  const used = formatTokens(snapshot.usedTokens);
  if (!snapshot.limitTokens) return `${used} tokens used`;
  return `${used} / ${formatTokens(snapshot.limitTokens)} tokens used`;
}

function formatPercent(snapshot: ContextWindowSnapshot): string {
  if (snapshot.percentFull === undefined) return 'limit unknown';
  return `${Math.round(snapshot.percentFull * 100)}% full`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  if (tokens < 100_000) {
    const k = tokens / 1000;
    const value = k.toFixed(1);
    return `${value.endsWith('.0') ? value.slice(0, -2) : value}k`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

function formatMultiplier(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value < 10) return value.toFixed(1);
  if (value < 100) return Math.round(value).toString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
