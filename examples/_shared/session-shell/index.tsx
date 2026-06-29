import type { ReactNode } from 'react';
import type {
  DemoAction,
  DemoController,
  DemoMetric,
  DemoPanel,
  DemoTimelineItem,
  DemoView,
} from '../session-types.js';
import './styles.css';

export function SessionShell({ controller }: { controller: DemoController }) {
  const views =
    controller.views ??
    ([
      { id: 'overview', label: 'Overview' },
      { id: 'actions', label: 'Actions' },
      ...controller.panels.map((panel) => ({ id: panel.id, label: panel.label })),
      { id: 'timeline', label: 'Timeline' },
    ] satisfies DemoView[]);
  const activeViewId = controller.activeViewId ?? views[0]?.id ?? 'overview';
  const activePanel = controller.panels.find((panel) => panel.id === activeViewId);
  return (
    <div className="demo-shell">
      <header className="demo-topbar">
        <div>
          <div className="demo-brand">inbrowser examples</div>
          <div className="demo-eyebrow">{controller.eyebrow}</div>
        </div>
        <div className="demo-topbar-actions">
          <span className="demo-status-pill">{controller.status}</span>
          {controller.onCopySession ? (
            <button type="button" className="demo-link-button" onClick={controller.onCopySession}>
              Copy
            </button>
          ) : null}
        </div>
      </header>

      <nav className="demo-tabs" aria-label="Example views">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            className="demo-tab-button"
            data-active={view.id === activeViewId || undefined}
            onClick={() => controller.onSelectView(view.id)}
          >
            {view.label}
          </button>
        ))}
      </nav>

      <main className="demo-layout" data-view={activeViewId}>
        <section className="demo-chat" aria-label="Example manager timeline">
          {activeViewId === 'overview' ? (
            <Overview controller={controller} />
          ) : activeViewId === 'actions' ? (
            <>
              <ViewHeading eyebrow="Runbook" title="Choose an operation" />
              <ActionRunbook actions={controller.actions} />
            </>
          ) : activeViewId === 'timeline' ? (
            <>
              <ViewHeading eyebrow="Chronological state" title="Timeline" />
              <Timeline items={controller.timeline} />
            </>
          ) : activePanel ? (
            <PanelView panel={activePanel} />
          ) : (
            <Overview controller={controller} />
          )}
        </section>
      </main>
    </div>
  );
}

function Overview({ controller }: { controller: DemoController }) {
  const recentItems = controller.timeline.slice(-5);
  const primaryActions = controller.actions.filter((action) => action.primary);
  const supportingActions = controller.actions.filter((action) => !action.primary).slice(0, 4);
  const primaryAction = primaryActions[0];
  return (
    <>
      <div className="demo-title-block">
        <p>{controller.eyebrow}</p>
        <h1>{controller.title}</h1>
        <span>{controller.status}</span>
      </div>
      <ManagerSummary metrics={controller.summary ?? []} />
      <section className="demo-now-grid" aria-label="Current example controls">
        <div className="demo-now-card">
          <span>Start here</span>
          <h2>{primaryAction?.label ?? 'Run an operation'}</h2>
          <p>
            {primaryAction
              ? `${primaryAction.description} ${primaryAction.consequence}`
              : 'Run an operation to update the state above and stream activity below.'}
          </p>
          {primaryActions.map((action) => (
            <ActionButton key={action.id} action={action} compact />
          ))}
        </div>
        <div className="demo-now-card">
          <span>Direct controls</span>
          <div className="demo-quick-actions">
            {supportingActions.map((action) => (
              <ActionButton key={action.id} action={action} compact />
            ))}
          </div>
        </div>
      </section>
      <section className="demo-recent" aria-label="Recent activity">
        <div className="demo-section-heading">
          <span>Recent activity</span>
          <p>Use the Timeline tab for the full event stream.</p>
        </div>
        <Timeline items={recentItems} />
      </section>
    </>
  );
}

function ViewHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="demo-view-heading">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
    </div>
  );
}

function ManagerSummary({ metrics }: { metrics: readonly DemoMetric[] }) {
  if (metrics.length === 0) return null;
  return (
    <dl className="demo-summary" aria-label="Sandbox state">
      {metrics.map((metric) => (
        <div key={metric.label} data-tone={metric.tone ?? 'neutral'}>
          <dt>{metric.label}</dt>
          <dd>{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActionRunbook({ actions }: { actions: readonly DemoAction[] }) {
  return (
    <section className="demo-runbook" aria-label="Sandbox actions">
      <div className="demo-action-grid">
        {actions.map((action) => (
          <ActionButton key={action.id} action={action} />
        ))}
      </div>
    </section>
  );
}

function ActionButton({ action, compact = false }: { action: DemoAction; compact?: boolean }) {
  return (
    <button
      type="button"
      className="demo-action-card"
      data-primary={action.primary || undefined}
      data-compact={compact || undefined}
      disabled={action.disabled}
      onClick={() => action.run()}
    >
      <span className="demo-action-icon" aria-hidden="true">
        {action.icon}
      </span>
      <span className="demo-action-copy">
        <strong>{action.label}</strong>
        <span>{action.description}</span>
        {!compact ? <em>{action.consequence}</em> : null}
      </span>
    </button>
  );
}

function Timeline({ items }: { items: readonly DemoTimelineItem[] }) {
  if (items.length === 0) {
    return (
      <div className="demo-empty">
        <p>Start the manager run.</p>
        <span>Actions and state changes stream here.</span>
      </div>
    );
  }
  return (
    <ol className="demo-timeline">
      {items.map((item) => (
        <TimelineRow key={item.id} item={item} />
      ))}
    </ol>
  );
}

function TimelineRow({ item }: { item: DemoTimelineItem }) {
  return (
    <li className="demo-row" data-kind={item.kind} data-status={item.status}>
      <div className="demo-row-label">
        <span>{item.kind}</span>
        <time dateTime={new Date(item.timestamp).toISOString()}>{formatTime(item.timestamp)}</time>
      </div>
      <article className="demo-row-body">
        <div className="demo-row-heading">
          <strong>{item.title}</strong>
          {item.status ? <span>{item.status}</span> : null}
          <CopyButton text={item.detail ?? item.body ?? item.title} />
        </div>
        {item.body ? <p>{item.body}</p> : null}
        {item.detail ? (
          <details>
            <summary>Payload</summary>
            <pre>{item.detail}</pre>
          </details>
        ) : null}
      </article>
    </li>
  );
}

function PanelView({ panel }: { panel: DemoPanel }) {
  return (
    <section className="demo-panel-view" aria-label={panel.title}>
      <div className="demo-panel-view-header">
        <span>Workspace view</span>
        <h1>{panel.title}</h1>
      </div>
      <div className="demo-inspector-body">{panel.render() as ReactNode}</div>
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <button type="button" className="demo-copy" onClick={() => copyText(text)}>
      Copy
    </button>
  );
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}
