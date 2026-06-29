export type DemoTimelineKind =
  | 'operator'
  | 'note'
  | 'file'
  | 'tool'
  | 'checkpoint'
  | 'run'
  | 'error'
  | 'preview'
  | 'snapshot'
  | 'package'
  | 'git'
  | 'storage';

export type DemoTimelineStatus = 'pending' | 'ok' | 'failed' | 'info';

export interface DemoTimelineItem {
  id: string;
  kind: DemoTimelineKind;
  title: string;
  body?: string;
  detail?: string;
  timestamp: number;
  status?: DemoTimelineStatus;
}

export interface DemoAction {
  id: string;
  label: string;
  icon: string;
  description: string;
  consequence: string;
  primary?: boolean;
  disabled?: boolean;
  run(): void | Promise<void>;
}

export interface DemoMetric {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}

export interface DemoPanel {
  id: string;
  label: string;
  title: string;
  render(): unknown;
}

export interface DemoView {
  id: string;
  label: string;
}

export interface DemoController {
  title: string;
  eyebrow?: string;
  status: string;
  summary?: readonly DemoMetric[];
  timeline: readonly DemoTimelineItem[];
  panels: readonly DemoPanel[];
  views?: readonly DemoView[];
  activeViewId?: string;
  actions: readonly DemoAction[];
  onSelectView(viewId: string): void;
  onCopySession?(): void;
}
