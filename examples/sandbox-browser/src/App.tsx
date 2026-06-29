import {
  type SandboxFileRecord,
  type SandboxScenario,
  createSandboxScenario,
  demoReactSource,
  formatSandboxEvent,
  listSandboxFiles,
} from '@inbrowser/example-shared/sandbox-scenario';
import { SessionShell } from '@inbrowser/example-shared/session-shell';
import type {
  DemoAction,
  DemoController,
  DemoMetric,
  DemoPanel,
  DemoTimelineItem,
} from '@inbrowser/example-shared/session-types';
import type { SandboxCheckpoint, SandboxEvent } from '@inbrowser/sandbox';
import type { PreviewCompileResult, PreviewModuleScope } from '@inbrowser/workspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as ReactRuntime from 'react';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import * as jsxRuntime from 'react/jsx-runtime';

interface PreviewState {
  status: 'idle' | 'compiled' | 'failed';
  message: string;
  component?: unknown;
}

interface ShellState {
  command: string;
  output: string;
}

const PREVIEW_SCOPE: PreviewModuleScope = {
  react: ReactRuntime as Record<string, unknown>,
  'react/jsx-runtime': jsxRuntime as Record<string, unknown>,
  'react/jsx-dev-runtime': jsxDevRuntime as Record<string, unknown>,
};

export function SandboxBrowserApp() {
  const localItemSequence = useRef(0);
  const [scenario, setScenario] = useState<SandboxScenario | null>(null);
  const [timeline, setTimeline] = useState<DemoTimelineItem[]>([]);
  const [events, setEvents] = useState<SandboxEvent[]>([]);
  const [files, setFiles] = useState<SandboxFileRecord[]>([]);
  const [checkpoints, setCheckpoints] = useState<SandboxCheckpoint[]>([]);
  const [activeViewId, setActiveViewId] = useState('overview');
  const [busyActionId, setBusyActionId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [shell, setShell] = useState<ShellState>({ command: 'ls src', output: '' });
  const [preview, setPreview] = useState<PreviewState>({
    status: 'idle',
    message: 'No preview compiled yet.',
  });

  const appendTimelineItem = useCallback(
    (item: Omit<DemoTimelineItem, 'id' | 'timestamp'> & { timestamp?: number }) => {
      setTimeline((items) => [
        ...items,
        {
          ...item,
          id: `local-${Date.now()}-${localItemSequence.current++}`,
          timestamp: item.timestamp ?? Date.now(),
        },
      ]);
    },
    [],
  );

  const refreshFiles = useCallback(async (current: SandboxScenario) => {
    setFiles(await listSandboxFiles(current.sandbox));
    setCheckpoints(current.sandbox.checkpoints.history());
  }, []);

  useEffect(() => {
    let disposed = false;
    let current: SandboxScenario | null = null;

    async function start() {
      try {
        current = await createSandboxScenario({
          id: 'sandbox-browser',
          storage: 'opfs-with-memory-fallback',
          preview: {
            entry: '/work/src/App.tsx',
            react: ReactRuntime as Record<string, unknown>,
            jsxRuntime: jsxRuntime as Record<string, unknown>,
            jsxDevRuntime: jsxDevRuntime as Record<string, unknown>,
            esbuildOptions: { wasmURL: '/esbuild.wasm' },
          },
          onTimelineItem(item, event) {
            setTimeline((items) => [...items, item]);
            setEvents((items) => [...items, event]);
            if (event.type === 'file' || event.type.startsWith('checkpoint:')) {
              const activeScenario = current;
              if (activeScenario && !disposed) {
                void refreshFiles(activeScenario);
              }
            }
          },
        });
        if (disposed) {
          current.dispose();
          return;
        }
        setScenario(current);
        appendTimelineItem({
          kind: 'note',
          title: 'manager session ready',
          body: 'A browser workspace, sandbox tool runner, checkpoint manager, shell, and preview compiler are connected.',
          status: 'ok',
        });
        await refreshFiles(current);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void start();
    return () => {
      disposed = true;
      current?.dispose();
    };
  }, [appendTimelineItem, refreshFiles]);

  const runAction = useCallback(
    async (
      id: string,
      title: string,
      body: string,
      action: (current: SandboxScenario) => Promise<void>,
    ) => {
      if (!scenario || busyActionId) return;
      appendTimelineItem({ kind: 'operator', title, body, status: 'pending' });
      setBusyActionId(id);
      setError(undefined);
      try {
        await action(scenario);
        await refreshFiles(scenario);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        appendTimelineItem({
          kind: 'error',
          title: `${title} failed`,
          body: message,
          status: 'failed',
        });
      } finally {
        setBusyActionId(undefined);
      }
    },
    [appendTimelineItem, busyActionId, refreshFiles, scenario],
  );

  const writeApp = useCallback(async (current: SandboxScenario) => {
    await current.sandbox.tools.run('write', {
      path: 'src/App.tsx',
      content: demoReactSource('Hello sandbox'),
    });
  }, []);

  const ensureAppFile = useCallback(
    async (current: SandboxScenario) => {
      try {
        await current.sandbox.fs.promises.readFile('/work/src/App.tsx', 'utf8');
      } catch {
        await writeApp(current);
      }
    },
    [writeApp],
  );

  const compilePreview = useCallback(
    async (current: SandboxScenario) => {
      await ensureAppFile(current);
      const result = await current.sandbox.tools.run('preview_compile', {});
      if (!result.ok) {
        setPreview({ status: 'failed', message: result.summary });
        appendTimelineItem({
          kind: 'preview',
          title: 'preview failed',
          body: result.summary,
          status: 'failed',
        });
        return;
      }
      const compileResult = result.data as PreviewCompileResult;
      if (!compileResult.ok) {
        const message = compileResult.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join('\n');
        setPreview({ status: 'failed', message });
        appendTimelineItem({
          kind: 'preview',
          title: 'preview failed',
          body: message,
          status: 'failed',
        });
        return;
      }
      setPreview({
        status: 'compiled',
        message: `Compiled ${compileResult.code.length} bytes from /work/src/App.tsx.`,
        component: compileResult.evaluate(PREVIEW_SCOPE),
      });
      appendTimelineItem({
        kind: 'preview',
        title: 'preview mounted',
        body: 'The compiled React component is now visible in the Preview panel.',
        status: 'ok',
      });
    },
    [appendTimelineItem, ensureAppFile],
  );

  const actions = useMemo<DemoAction[]>(() => {
    const disabled = !scenario || Boolean(busyActionId);
    return [
      {
        id: 'turn',
        icon: '▶',
        label: busyActionId === 'turn' ? 'Running turn' : 'Run managed turn',
        description: 'Seed the app, capture a checkpoint, edit it, and compile preview.',
        consequence: 'Creates files, a restore point, an edit, and a preview result.',
        primary: true,
        disabled,
        run: () =>
          runAction(
            'turn',
            'operator ran a managed turn',
            'Write app → checkpoint → edit copy → compile preview.',
            async (current) => {
              await writeApp(current);
              await current.sandbox.checkpoints.create({
                label: 'before copy edit',
                reason: 'manual',
                summary: 'Captured the first generated React app before changing the heading.',
              });
              await current.sandbox.tools.run('edit', {
                path: 'src/App.tsx',
                oldText: 'Hello sandbox',
                newText: 'Hello checkpoints',
              });
              await compilePreview(current);
            },
          ),
      },
      {
        id: 'write',
        icon: '✚',
        label: busyActionId === 'write' ? 'Writing app' : 'Write app',
        description: 'Create the React entry file in /work.',
        consequence: 'Adds /work/src/App.tsx and file events.',
        disabled,
        run: () =>
          runAction(
            'write',
            'operator wrote the app file',
            'Create /work/src/App.tsx through sandbox.tools.run("write").',
            writeApp,
          ),
      },
      {
        id: 'checkpoint',
        icon: '◎',
        label: busyActionId === 'checkpoint' ? 'Capturing' : 'Capture checkpoint',
        description: 'Snapshot the current /work filesystem.',
        consequence: 'Adds a visible restore point to history.',
        disabled,
        run: () =>
          runAction(
            'checkpoint',
            'operator captured a checkpoint',
            'Ensure the app exists, then snapshot /work.',
            async (current) => {
              await ensureAppFile(current);
              const fileCount = (await listSandboxFiles(current.sandbox)).filter(
                (file) => file.type === 'file',
              ).length;
              const checkpoint = await current.sandbox.checkpoints.create({
                label: `manual checkpoint ${current.sandbox.checkpoints.history().length + 1}`,
                reason: 'manual',
                summary: `Captured ${fileCount} file${fileCount === 1 ? '' : 's'} in /work.`,
              });
              appendTimelineItem({
                kind: 'checkpoint',
                title: 'checkpoint available',
                body: `${checkpoint.label ?? checkpoint.id} can now be restored from the Checkpoints panel.`,
                status: 'ok',
              });
            },
          ),
      },
      {
        id: 'edit',
        icon: '✎',
        label: busyActionId === 'edit' ? 'Editing' : 'Edit app',
        description: 'Toggle the app heading through the edit tool.',
        consequence: 'Shows read, edit, and file write events.',
        disabled,
        run: () =>
          runAction(
            'edit',
            'operator edited the app',
            'Read the current file and patch the heading text.',
            async (current) => {
              await ensureAppFile(current);
              const read = await current.sandbox.tools.run('read', { path: 'src/App.tsx' });
              const content = readContent(read.data);
              const oldText = content.includes('Hello sandbox')
                ? 'Hello sandbox'
                : 'Hello checkpoints';
              const newText = oldText === 'Hello sandbox' ? 'Hello checkpoints' : 'Hello sandbox';
              await current.sandbox.tools.run('edit', { path: 'src/App.tsx', oldText, newText });
            },
          ),
      },
      {
        id: 'restore',
        icon: '↩',
        label: busyActionId === 'restore' ? 'Restoring' : 'Restore latest',
        description: 'Return /work to the latest checkpoint.',
        consequence: 'Mutates files back to checkpoint content.',
        disabled: disabled || checkpoints.length === 0,
        run: () =>
          runAction(
            'restore',
            'operator restored the latest checkpoint',
            'Replace the workspace with the latest checkpoint snapshot.',
            async (current) => {
              const latest = current.sandbox.checkpoints.latest();
              if (!latest) throw new Error('No checkpoint to restore.');
              await current.sandbox.checkpoints.restore(latest.id);
            },
          ),
      },
      {
        id: 'shell',
        icon: '>',
        label: busyActionId === 'shell' ? 'Running shell' : 'Run shell',
        description: `Execute “${shell.command}” inside /work.`,
        consequence: 'Writes command output into the Shell panel.',
        disabled,
        run: () =>
          runAction(
            'shell',
            'operator ran a shell command',
            `/work $ ${shell.command}`,
            async (current) => {
              const result = await current.sandbox.tools.run('bash', {
                command: shell.command,
                cwd: '/work',
              });
              const data = result.data as { stdout?: string; stderr?: string } | undefined;
              setShell((state) => ({
                ...state,
                output: [data?.stdout, data?.stderr].filter(Boolean).join('\n') || result.summary,
              }));
            },
          ),
      },
      {
        id: 'preview',
        icon: '◫',
        label: busyActionId === 'preview' ? 'Compiling' : 'Compile preview',
        description: 'Bundle the React file with workspace preview services.',
        consequence: 'Renders the compiled app in the Preview panel.',
        disabled,
        run: () =>
          runAction(
            'preview',
            'operator compiled the preview',
            'Compile /work/src/App.tsx through the sandbox preview tool.',
            compilePreview,
          ),
      },
    ];
  }, [
    busyActionId,
    checkpoints.length,
    compilePreview,
    ensureAppFile,
    runAction,
    scenario,
    shell.command,
    writeApp,
    appendTimelineItem,
  ]);

  const restoreCheckpoint = useCallback(
    (id: string) => {
      void runAction(
        'restore-panel',
        'operator restored a selected checkpoint',
        `Restore checkpoint ${id}.`,
        async (current) => {
          await current.sandbox.checkpoints.restore(id);
        },
      );
    },
    [runAction],
  );

  const panels = useMemo<DemoPanel[]>(
    () => [
      {
        id: 'files',
        label: 'Files',
        title: 'Workspace files',
        render: () => <FilesPanel files={files} />,
      },
      {
        id: 'checkpoints',
        label: 'Checkpoints',
        title: 'Checkpoint history',
        render: () => (
          <CheckpointsPanel checkpoints={checkpoints} onRestore={(id) => restoreCheckpoint(id)} />
        ),
      },
      {
        id: 'events',
        label: 'Events',
        title: 'Raw sandbox events',
        render: () => <EventsPanel events={events} />,
      },
      {
        id: 'shell',
        label: 'Shell',
        title: 'Workspace shell',
        render: () => (
          <ShellPanel
            shell={shell}
            onCommandChange={(command) => setShell((state) => ({ ...state, command }))}
          />
        ),
      },
      {
        id: 'preview',
        label: 'Preview',
        title: 'React preview',
        render: () => <PreviewPanel preview={preview} />,
      },
    ],
    [checkpoints, events, files, preview, restoreCheckpoint, shell],
  );

  const summary = useMemo<DemoMetric[]>(() => {
    const fileCount = files.filter((file) => file.type === 'file').length;
    return [
      { label: 'Files', value: String(fileCount), tone: fileCount > 0 ? 'good' : 'neutral' },
      {
        label: 'Checkpoints',
        value: String(checkpoints.length),
        tone: checkpoints.length > 0 ? 'good' : 'neutral',
      },
      {
        label: 'Events',
        value: String(events.length),
        tone: events.length > 0 ? 'good' : 'neutral',
      },
      {
        label: 'Preview',
        value: preview.status,
        tone:
          preview.status === 'failed' ? 'bad' : preview.status === 'compiled' ? 'good' : 'neutral',
      },
    ];
  }, [checkpoints.length, events.length, files, preview.status]);

  const controller = useMemo<DemoController>(
    () => ({
      title: 'Sandbox manager',
      eyebrow: '@inbrowser/sandbox',
      status: error ?? (scenario ? `ready · ${scenario.workspace.storageStatus}` : 'starting'),
      summary,
      timeline,
      panels,
      views: [
        { id: 'overview', label: 'Overview' },
        { id: 'actions', label: 'Actions' },
        { id: 'files', label: 'Files' },
        { id: 'checkpoints', label: 'Checkpoints' },
        { id: 'preview', label: 'Preview' },
        { id: 'shell', label: 'Shell' },
        { id: 'timeline', label: 'Timeline' },
        { id: 'events', label: 'Events' },
      ],
      activeViewId,
      actions,
      onSelectView(viewId) {
        setActiveViewId(viewId);
      },
      onCopySession() {
        void copyText(buildSessionText(timeline));
      },
    }),
    [actions, activeViewId, error, panels, scenario, summary, timeline],
  );

  return <SessionShell controller={controller} />;
}

function FilesPanel({ files }: { files: readonly SandboxFileRecord[] }) {
  if (files.length === 0) return <p>No files yet. Run “Write app” or “Run managed turn”.</p>;
  return (
    <div>
      {files.map((file) => (
        <section key={file.path} className="demo-panel-section">
          <h3>{file.path}</h3>
          <p>{file.type}</p>
          {file.content ? <pre className="demo-code-preview">{file.content}</pre> : null}
        </section>
      ))}
    </div>
  );
}

function CheckpointsPanel({
  checkpoints,
  onRestore,
}: { checkpoints: readonly SandboxCheckpoint[]; onRestore(id: string): void }) {
  if (checkpoints.length === 0) return <p>No checkpoints yet. Capture one from the runbook.</p>;
  return (
    <ul className="demo-panel-list">
      {checkpoints.map((checkpoint) => (
        <li key={checkpoint.id}>
          <strong>{checkpoint.label ?? checkpoint.id}</strong>
          <p>{checkpoint.summary ?? checkpoint.reason ?? 'checkpoint'}</p>
          <button
            type="button"
            className="demo-link-button"
            onClick={() => onRestore(checkpoint.id)}
          >
            ↩ Restore
          </button>
        </li>
      ))}
    </ul>
  );
}

function EventsPanel({ events }: { events: readonly SandboxEvent[] }) {
  if (events.length === 0) return <p>No events yet.</p>;
  return (
    <ul className="demo-panel-list">
      {events.map((event, index) => (
        <li key={`${event.type}-${event.timestamp}-${index}`}>{formatSandboxEvent(event)}</li>
      ))}
    </ul>
  );
}

function ShellPanel({
  shell,
  onCommandChange,
}: { shell: ShellState; onCommandChange(command: string): void }) {
  return (
    <div>
      <label className="demo-panel-section">
        <h3>Command</h3>
        <input value={shell.command} onChange={(event) => onCommandChange(event.target.value)} />
      </label>
      <section className="demo-panel-section">
        <h3>Output</h3>
        <pre className="demo-panel-pre">
          {shell.output || 'Run the shell action to see output.'}
        </pre>
      </section>
    </div>
  );
}

function PreviewPanel({ preview }: { preview: PreviewState }) {
  return (
    <div>
      <section className="demo-panel-section">
        <h3>{preview.status}</h3>
        <p>{preview.message}</p>
      </section>
      <section className="demo-panel-section">
        <h3>Rendered app</h3>
        <div className="demo-preview-frame">
          {typeof preview.component === 'function'
            ? ReactRuntime.createElement(preview.component as ReactRuntime.ComponentType)
            : null}
        </div>
      </section>
    </div>
  );
}

function readContent(data: unknown): string {
  return typeof data === 'object' && data !== null && 'content' in data
    ? String((data as { content: unknown }).content)
    : '';
}

function buildSessionText(items: readonly DemoTimelineItem[]): string {
  return items
    .map((item) =>
      [`## ${item.kind}: ${item.title}`, item.body, item.detail].filter(Boolean).join('\n\n'),
    )
    .join('\n\n---\n\n');
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
