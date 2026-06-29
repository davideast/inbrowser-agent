import type {
  BrowserWorkspace,
  BrowserWorkspaceOptions,
  GitLogEntry,
  GitStatusRow,
  InstalledPackage,
  PackageInstallSpec,
  PreviewCompileResult,
  ReaddirDirent,
  ShellResult,
  WorkspaceFileEvent,
  WorkspaceSnapshot,
} from '@inbrowser/workspace';
import { createBrowserWorkspace } from '@inbrowser/workspace';
import type { DemoTimelineItem, DemoTimelineStatus } from './session-types.js';

export interface WorkspaceScenarioOptions {
  id: string;
  storage?: BrowserWorkspaceOptions['storage'];
  root?: string;
  onTimelineItem?(item: DemoTimelineItem, event: WorkspaceDemoEvent): void;
}

export interface WorkspaceScenario {
  workspace: BrowserWorkspace;
  recorder: WorkspaceEventRecorder;
  snapshots: WorkspaceSnapshotRecord[];
  record(event: WorkspaceDemoEvent): DemoTimelineItem;
  dispose(): void;
}

export interface WorkspaceFileRecord {
  path: string;
  type: 'file' | 'directory';
  content?: string;
}

export interface WorkspaceSnapshotRecord {
  id: string;
  label: string;
  createdAt: number;
  entryCount: number;
  snapshot: WorkspaceSnapshot;
}

export interface BasicWorkspaceFlowResult {
  initialContent: string;
  editedContent: string;
  restoredContent: string;
  listedPaths: string[];
  shell: ShellResult;
  snapshot: WorkspaceSnapshotRecord;
  gitStatus: GitStatusRow[];
  gitLog: GitLogEntry[];
}

export type WorkspaceDemoEvent =
  | { type: 'storage:ready'; status: BrowserWorkspace['storageStatus']; timestamp: number }
  | { type: 'file'; event: WorkspaceFileEvent; timestamp: number }
  | { type: 'shell'; command: string; result: ShellResult; timestamp: number }
  | { type: 'snapshot:create'; snapshot: WorkspaceSnapshotRecord; timestamp: number }
  | { type: 'snapshot:restore'; snapshot: WorkspaceSnapshotRecord; timestamp: number }
  | { type: 'package:install'; installed: InstalledPackage; timestamp: number }
  | { type: 'git:init'; branch: string | null; timestamp: number }
  | { type: 'git:commit'; oid: string; message: string; timestamp: number }
  | { type: 'preview:compile'; ok: boolean; message: string; timestamp: number }
  | { type: 'error'; message: string; timestamp: number };

export interface WorkspaceEventRecorder {
  readonly events: WorkspaceDemoEvent[];
  readonly timeline: DemoTimelineItem[];
  record(event: WorkspaceDemoEvent): DemoTimelineItem;
}

let itemSequence = 0;

export async function createWorkspaceScenario(
  options: WorkspaceScenarioOptions,
): Promise<WorkspaceScenario> {
  const workspace = await createBrowserWorkspace({
    id: options.id,
    root: options.root ?? '/work',
    storage: options.storage ?? 'memory',
  });
  const recorder = createWorkspaceEventRecorder();
  const snapshots: WorkspaceSnapshotRecord[] = [];
  const record = (event: WorkspaceDemoEvent) => {
    const item = recorder.record(event);
    options.onTimelineItem?.(item, event);
    return item;
  };
  const unsubscribe = workspace.fs.watch((event) =>
    record({ type: 'file', event, timestamp: event.timestamp }),
  );
  record({ type: 'storage:ready', status: workspace.storageStatus, timestamp: Date.now() });

  return {
    workspace,
    recorder,
    snapshots,
    record,
    dispose() {
      unsubscribe();
      workspace.dispose();
    },
  };
}

export function createWorkspaceEventRecorder(): WorkspaceEventRecorder {
  const events: WorkspaceDemoEvent[] = [];
  const timeline: DemoTimelineItem[] = [];
  return {
    events,
    timeline,
    record(event) {
      events.push(event);
      const item = workspaceEventToTimelineItem(event);
      timeline.push(item);
      return item;
    },
  };
}

export async function runBasicWorkspaceFlow(
  scenario: WorkspaceScenario,
): Promise<BasicWorkspaceFlowResult> {
  const { workspace } = scenario;
  await seedWorkspaceFiles(workspace, 'Hello workspace');
  const initialContent = await workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8');
  const listedPaths = (await listWorkspaceFiles(workspace)).map((file) => file.path);
  const shell = await runWorkspaceShell(scenario, 'pwd && ls src');
  const snapshot = await createWorkspaceSnapshot(scenario, 'before greeting edit');

  await editWorkspaceGreeting(workspace, 'Hello restored workspace');
  const editedContent = await workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8');
  await restoreWorkspaceSnapshot(scenario, snapshot.id);
  const restoredContent = await workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8');

  const git = await workspace.createGit();
  await git.init();
  recordWorkspaceEvent(scenario, {
    type: 'git:init',
    branch: await git.currentBranch(),
    timestamp: Date.now(),
  });
  await git.stageAll();
  const oid = await git.commit({
    message: 'Create workspace demo app',
    authorName: 'Inbrowser Examples',
    authorEmail: 'examples@inbrowser.local',
  });
  recordWorkspaceEvent(scenario, {
    type: 'git:commit',
    oid,
    message: 'Create workspace demo app',
    timestamp: Date.now(),
  });

  return {
    initialContent,
    editedContent,
    restoredContent,
    listedPaths,
    shell,
    snapshot,
    gitStatus: await git.status(),
    gitLog: await git.log({ depth: 3 }),
  };
}

export async function seedWorkspaceFiles(
  workspace: BrowserWorkspace,
  title = 'Hello workspace',
): Promise<void> {
  await workspace.fs.promises.writeFile(
    '/work/package.json',
    `${JSON.stringify(
      {
        scripts: { preview: 'compile preview' },
        dependencies: { '@inbrowser/workspace': 'workspace:*' },
      },
      null,
      2,
    )}\n`,
  );
  await workspace.fs.promises.writeFile('/work/src/theme.ts', demoThemeSource());
  await workspace.fs.promises.writeFile('/work/src/App.tsx', demoWorkspaceReactSource(title));
}

export async function editWorkspaceGreeting(
  workspace: BrowserWorkspace,
  title: string,
): Promise<void> {
  const path = '/work/src/App.tsx';
  const content = await workspace.fs.promises.readFile(path, 'utf8');
  const next = content.replace(/<h1>.*<\/h1>/, `<h1>${title}</h1>`);
  await workspace.fs.promises.writeFile(path, next);
}

export async function createWorkspaceSnapshot(
  scenario: WorkspaceScenario,
  label: string,
): Promise<WorkspaceSnapshotRecord> {
  const snapshot = await scenario.workspace.fs.snapshot(scenario.workspace.root);
  const record: WorkspaceSnapshotRecord = {
    id: `snapshot-${snapshot.createdAt}-${scenario.snapshots.length + 1}`,
    label,
    createdAt: snapshot.createdAt,
    entryCount: snapshot.entries.length,
    snapshot,
  };
  scenario.snapshots.push(record);
  recordWorkspaceEvent(scenario, {
    type: 'snapshot:create',
    snapshot: record,
    timestamp: Date.now(),
  });
  return record;
}

export async function restoreWorkspaceSnapshot(
  scenario: WorkspaceScenario,
  id: string,
): Promise<void> {
  const record = scenario.snapshots.find((snapshot) => snapshot.id === id);
  if (!record) throw new Error(`Missing workspace snapshot: ${id}`);
  await scenario.workspace.fs.restore(record.snapshot, { clearRoot: true });
  recordWorkspaceEvent(scenario, {
    type: 'snapshot:restore',
    snapshot: record,
    timestamp: Date.now(),
  });
}

export async function runWorkspaceShell(
  scenario: WorkspaceScenario,
  command: string,
): Promise<ShellResult> {
  const shell = await scenario.workspace.createShell();
  const result = await shell.exec(command);
  recordWorkspaceEvent(scenario, {
    type: 'shell',
    command,
    result,
    timestamp: Date.now(),
  });
  return result;
}

export async function installWorkspacePackage(
  scenario: WorkspaceScenario,
  spec: PackageInstallSpec,
): Promise<InstalledPackage> {
  const installed = await scenario.workspace.packages.install(spec);
  recordWorkspaceEvent(scenario, {
    type: 'package:install',
    installed,
    timestamp: Date.now(),
  });
  return installed;
}

export function recordPreviewCompile(
  scenario: WorkspaceScenario,
  result: PreviewCompileResult,
): void {
  recordWorkspaceEvent(scenario, {
    type: 'preview:compile',
    ok: result.ok,
    message: result.ok
      ? `compiled ${result.code.length} bytes`
      : result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'),
    timestamp: Date.now(),
  });
}

export function recordWorkspaceError(scenario: WorkspaceScenario, message: string): void {
  recordWorkspaceEvent(scenario, { type: 'error', message, timestamp: Date.now() });
}

export function recordWorkspaceEvent(
  scenario: WorkspaceScenario,
  event: WorkspaceDemoEvent,
): DemoTimelineItem {
  return scenario.record(event);
}

export async function listWorkspaceFiles(
  workspace: BrowserWorkspace,
  options: { includeHidden?: boolean } = {},
): Promise<WorkspaceFileRecord[]> {
  const records: WorkspaceFileRecord[] = [];

  async function visit(path: string): Promise<void> {
    let entries: ReaddirDirent[];
    try {
      entries = await workspace.fs.promises.readdir(path, { withFileTypes: true });
    } catch (err) {
      if (isMissingWorkspacePath(err)) return;
      throw err;
    }
    for (const entry of entries) {
      if (!options.includeHidden && entry.name.startsWith('.')) continue;
      records.push({ path: entry.path, type: entry.type });
      if (entry.isDirectory()) {
        await visit(entry.path);
      } else if (entry.isFile()) {
        try {
          records[records.length - 1] = {
            path: entry.path,
            type: entry.type,
            content: await workspace.fs.promises.readFile(entry.path, 'utf8'),
          };
        } catch (err) {
          if (!isMissingWorkspacePath(err)) throw err;
          records.pop();
        }
      }
    }
  }

  await visit(workspace.root);
  return records;
}

function isMissingWorkspacePath(err: unknown): boolean {
  const code =
    typeof err === 'object' && err && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
  if (code === 'ENOENT') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ENOENT|No such (?:file|directory|file or directory)/i.test(message);
}

export function demoWorkspaceReactSource(title = 'Hello workspace'): string {
  return `import { surfaceStyle } from './theme';

export default function App() {
  return (
    <main style={surfaceStyle}>
      <p style={{ letterSpacing: '0.2em', textTransform: 'uppercase' }}>@inbrowser/workspace</p>
      <h1>${title}</h1>
      <p>Files, shell commands, snapshots, packages, git, and preview compilation share one browser workspace.</p>
    </main>
  );
}
`;
}

export function demoThemeSource(): string {
  return `export const surfaceStyle = {
  minHeight: '100vh',
  margin: 0,
  padding: 32,
  fontFamily: 'system-ui, sans-serif',
  background: '#f4f4f4',
  color: '#111',
};
`;
}

export function workspaceEventToTimelineItem(event: WorkspaceDemoEvent): DemoTimelineItem {
  return {
    id: `workspace-event-${event.timestamp}-${itemSequence++}`,
    kind: kindForEvent(event),
    title: titleForEvent(event),
    body: bodyForEvent(event),
    detail: JSON.stringify(event, replacer, 2),
    timestamp: event.timestamp,
    status: statusForEvent(event),
  };
}

export function formatWorkspaceEvent(event: WorkspaceDemoEvent): string {
  const body = bodyForEvent(event);
  return body ? `${titleForEvent(event)}: ${body}` : titleForEvent(event);
}

function titleForEvent(event: WorkspaceDemoEvent): string {
  switch (event.type) {
    case 'storage:ready':
      return 'workspace ready';
    case 'file':
      return `file ${event.event.type}`;
    case 'shell':
      return 'shell command';
    case 'snapshot:create':
      return 'snapshot created';
    case 'snapshot:restore':
      return 'snapshot restored';
    case 'package:install':
      return 'package installed';
    case 'git:init':
      return 'git initialized';
    case 'git:commit':
      return 'git commit';
    case 'preview:compile':
      return 'preview compile';
    case 'error':
      return 'workspace error';
  }
}

function bodyForEvent(event: WorkspaceDemoEvent): string | undefined {
  switch (event.type) {
    case 'storage:ready':
      return event.status;
    case 'file':
      return event.event.targetPath
        ? `${event.event.path} -> ${event.event.targetPath}`
        : event.event.path;
    case 'shell':
      return event.result.stdout || event.result.stderr || `exit ${event.result.exitCode}`;
    case 'snapshot:create':
    case 'snapshot:restore':
      return `${event.snapshot.label} (${event.snapshot.entryCount} entries)`;
    case 'package:install':
      return `${event.installed.name}@${event.installed.version}`;
    case 'git:init':
      return event.branch ?? 'main';
    case 'git:commit':
      return `${event.message} (${event.oid.slice(0, 8)})`;
    case 'preview:compile':
      return event.message;
    case 'error':
      return event.message;
  }
}

function kindForEvent(event: WorkspaceDemoEvent): DemoTimelineItem['kind'] {
  switch (event.type) {
    case 'storage:ready':
      return 'storage';
    case 'file':
      return 'file';
    case 'shell':
      return 'run';
    case 'snapshot:create':
    case 'snapshot:restore':
      return 'snapshot';
    case 'package:install':
      return 'package';
    case 'git:init':
    case 'git:commit':
      return 'git';
    case 'preview:compile':
      return 'preview';
    case 'error':
      return 'error';
  }
}

function statusForEvent(event: WorkspaceDemoEvent): DemoTimelineStatus {
  if (event.type === 'error') return 'failed';
  if (event.type === 'preview:compile') return event.ok ? 'ok' : 'failed';
  if (event.type === 'shell') return event.result.exitCode === 0 ? 'ok' : 'failed';
  return event.type === 'storage:ready' ? 'info' : 'ok';
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'function') return '[Function]';
  if (value instanceof Uint8Array) return `[Uint8Array ${value.byteLength}]`;
  return value;
}
