import type { Sandbox, SandboxDirent, SandboxEvent } from '@inbrowser/sandbox';
import { createWorkspaceSandbox } from '@inbrowser/sandbox';
import type {
  BrowserWorkspace,
  BrowserWorkspaceOptions,
  ReactPreviewRuntimeOptions,
} from '@inbrowser/workspace';
import { createBrowserWorkspace } from '@inbrowser/workspace';
import type { DemoTimelineItem, DemoTimelineStatus } from './session-types.js';

export interface SandboxScenarioOptions {
  id: string;
  storage?: BrowserWorkspaceOptions['storage'];
  root?: string;
  preview?: Omit<ReactPreviewRuntimeOptions, 'fs'>;
  onTimelineItem?(item: DemoTimelineItem, event: SandboxEvent): void;
}

export interface SandboxScenario {
  workspace: BrowserWorkspace;
  sandbox: Sandbox;
  recorder: SandboxEventRecorder;
  dispose(): void;
}

export interface SandboxFlowResult {
  checkpointId: string;
  initialContent: string;
  editedContent: string;
  restoredContent: string;
  listedPaths: string[];
}

export interface SandboxEventRecorder {
  readonly events: SandboxEvent[];
  readonly timeline: DemoTimelineItem[];
  record(event: SandboxEvent): DemoTimelineItem;
}

export interface SandboxFileRecord {
  path: string;
  type: 'file' | 'directory';
  content?: string;
}

let itemSequence = 0;

export async function createSandboxScenario(
  options: SandboxScenarioOptions,
): Promise<SandboxScenario> {
  const workspace = await createBrowserWorkspace({
    id: options.id,
    root: options.root ?? '/work',
    storage: options.storage ?? 'memory',
  });
  const sandbox = await createWorkspaceSandbox({
    workspace,
    preview: options.preview,
  });
  const recorder = createSandboxEventRecorder();
  const unsubscribe = sandbox.on((event) => {
    const item = recorder.record(event);
    options.onTimelineItem?.(item, event);
  });

  return {
    workspace,
    sandbox,
    recorder,
    dispose() {
      unsubscribe();
      sandbox.destroy();
      workspace.dispose();
    },
  };
}

export function createSandboxEventRecorder(): SandboxEventRecorder {
  const events: SandboxEvent[] = [];
  const timeline: DemoTimelineItem[] = [];
  return {
    events,
    timeline,
    record(event) {
      events.push(event);
      const item = sandboxEventToTimelineItem(event);
      timeline.push(item);
      return item;
    },
  };
}

export async function runBasicSandboxFlow(sandbox: Sandbox): Promise<SandboxFlowResult> {
  await sandbox.tools.run('write', {
    path: 'src/App.tsx',
    content: demoReactSource('Hello sandbox'),
  });

  const initial = await sandbox.tools.run('read', { path: 'src/App.tsx' });
  const listed = await sandbox.tools.run('ls', { path: 'src' });
  const checkpoint = await sandbox.checkpoints.create({
    label: 'before greeting edit',
    reason: 'manual',
    summary: 'The app still says Hello sandbox.',
  });

  await sandbox.tools.run('edit', {
    path: 'src/App.tsx',
    oldText: 'Hello sandbox',
    newText: 'Hello checkpoints',
  });
  const edited = await sandbox.tools.run('read', { path: 'src/App.tsx' });

  await sandbox.checkpoints.restore(checkpoint.id);
  const restored = await sandbox.tools.run('read', { path: 'src/App.tsx' });

  return {
    checkpointId: checkpoint.id,
    initialContent: readContent(initial.data),
    editedContent: readContent(edited.data),
    restoredContent: readContent(restored.data),
    listedPaths: listPaths(listed.data),
  };
}

export async function listSandboxFiles(sandbox: Sandbox): Promise<SandboxFileRecord[]> {
  const records: SandboxFileRecord[] = [];

  async function visit(path: string): Promise<void> {
    const entries = await sandbox.fs.promises.readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      records.push({ path: entry.path, type: entry.type });
      if (entry.isDirectory()) {
        await visit(entry.path);
      } else if (entry.isFile()) {
        records[records.length - 1] = {
          path: entry.path,
          type: entry.type,
          content: await sandbox.fs.promises.readFile(entry.path, 'utf8'),
        };
      }
    }
  }

  try {
    await visit(sandbox.cwd);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('ENOENT')) throw err;
  }
  return records;
}

export function demoReactSource(title = 'Hello sandbox'): string {
  return `export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 32 }}>
      <h1>${title}</h1>
      <p>This React preview was compiled from files inside /work.</p>
    </main>
  );
}
`;
}

export function formatSandboxEvent(event: SandboxEvent): string {
  switch (event.type) {
    case 'file':
      return `${event.event.type} ${event.event.path}`;
    case 'run:start':
      return `run started: ${event.command}`;
    case 'run:finish':
      return `run finished (${event.result.exitCode}): ${event.command}`;
    case 'tool:start':
      return `tool started: ${event.name}`;
    case 'tool:finish':
      return `${event.name}: ${event.result.summary}`;
    case 'checkpoint:create':
      return `checkpoint created: ${event.checkpoint.label ?? event.checkpoint.id}`;
    case 'checkpoint:restore':
      return `checkpoint restored: ${event.checkpoint.label ?? event.checkpoint.id}`;
    case 'checkpoint:prune':
      return `checkpoint pruned: ${event.checkpoints.length}`;
    case 'error':
      return `error: ${event.message}`;
    case 'destroyed':
      return 'sandbox destroyed';
  }
}

export function sandboxEventToTimelineItem(event: SandboxEvent): DemoTimelineItem {
  const status = statusForEvent(event);
  return {
    id: `sandbox-event-${event.timestamp}-${itemSequence++}`,
    kind: kindForEvent(event),
    title: titleForEvent(event),
    body: bodyForEvent(event),
    detail: JSON.stringify(event, replacer, 2),
    timestamp: event.timestamp,
    status,
  };
}

function titleForEvent(event: SandboxEvent): string {
  switch (event.type) {
    case 'file':
      return `file ${event.event.type}`;
    case 'run:start':
      return 'run started';
    case 'run:finish':
      return 'run finished';
    case 'tool:start':
      return `tool ${event.name}`;
    case 'tool:finish':
      return `tool ${event.name}`;
    case 'checkpoint:create':
      return 'checkpoint created';
    case 'checkpoint:restore':
      return 'checkpoint restored';
    case 'checkpoint:prune':
      return 'checkpoint pruned';
    case 'error':
      return 'sandbox error';
    case 'destroyed':
      return 'sandbox destroyed';
  }
}

function bodyForEvent(event: SandboxEvent): string | undefined {
  switch (event.type) {
    case 'file':
      return event.event.targetPath
        ? `${event.event.path} -> ${event.event.targetPath}`
        : event.event.path;
    case 'run:start':
      return `${event.cwd} $ ${event.command}`;
    case 'run:finish':
      return event.result.stdout || event.result.stderr || `exit ${event.result.exitCode}`;
    case 'tool:start':
      return JSON.stringify(event.args);
    case 'tool:finish':
      return event.result.summary;
    case 'checkpoint:create':
    case 'checkpoint:restore':
      return event.checkpoint.summary ?? event.checkpoint.label ?? event.checkpoint.id;
    case 'checkpoint:prune':
      return `${event.checkpoints.length} checkpoint(s)`;
    case 'error':
      return event.message;
    case 'destroyed':
      return undefined;
  }
}

function kindForEvent(event: SandboxEvent): DemoTimelineItem['kind'] {
  switch (event.type) {
    case 'file':
      return 'file';
    case 'run:start':
    case 'run:finish':
      return 'run';
    case 'tool:start':
    case 'tool:finish':
      return event.name === 'preview_compile' ? 'preview' : 'tool';
    case 'checkpoint:create':
    case 'checkpoint:restore':
    case 'checkpoint:prune':
      return 'checkpoint';
    case 'error':
      return 'error';
    case 'destroyed':
      return 'note';
  }
}

function statusForEvent(event: SandboxEvent): DemoTimelineStatus {
  if (event.type === 'tool:start' || event.type === 'run:start') return 'pending';
  if (event.type === 'error') return 'failed';
  if (event.type === 'tool:finish') return event.result.ok ? 'ok' : 'failed';
  if (event.type === 'run:finish') return event.result.exitCode === 0 ? 'ok' : 'failed';
  return 'info';
}

function readContent(data: unknown): string {
  return typeof data === 'object' && data !== null && 'content' in data
    ? String((data as { content: unknown }).content)
    : '';
}

function listPaths(data: unknown): string[] {
  if (typeof data !== 'object' || data === null || !('entries' in data)) return [];
  const entries = (data as { entries: SandboxDirent[] }).entries;
  return entries.map((entry) => entry.path);
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'function') return '[Function]';
  return value;
}
