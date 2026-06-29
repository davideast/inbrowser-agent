import type { DemoAction, DemoTimelineItem } from '@inbrowser/example-shared/session-types';
import {
  type WorkspaceFileRecord,
  type WorkspaceScenario,
  type WorkspaceSnapshotRecord,
  createWorkspaceScenario,
  createWorkspaceSnapshot,
  editWorkspaceGreeting,
  installWorkspacePackage,
  listWorkspaceFiles,
  recordPreviewCompile,
  recordWorkspaceError,
  restoreWorkspaceSnapshot,
  seedWorkspaceFiles,
} from '@inbrowser/example-shared/workspace-scenario';
import type {
  GitLogEntry,
  GitStatusRow,
  InstalledPackage,
  PreviewCompileResult,
  PreviewModuleScope,
  ShellResult,
  WorkspaceShell,
} from '@inbrowser/workspace';
import { createWorkspaceGitCommand } from '@inbrowser/workspace';
import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTermTerminal } from '@xterm/xterm';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as ReactRuntime from 'react';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import * as jsxRuntime from 'react/jsx-runtime';

type WorkbenchTabId = 'editor' | 'preview' | 'terminal';
type ActivityId = 'explorer' | 'packages' | 'git' | 'snapshots' | 'events';

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children: WorkspaceTreeNode[];
}

export interface FlattenedWorkspaceTreeNode {
  node: WorkspaceTreeNode;
  depth: number;
}

export interface IdeEventRow {
  id: string;
  kind: DemoTimelineItem['kind'];
  status: DemoTimelineItem['status'];
  time: string;
  title: string;
  body?: string;
  fields: Array<{ label: string; value: string }>;
}

interface PreviewState {
  status: 'idle' | 'compiled' | 'failed';
  message: string;
  component?: unknown;
}

interface ActivityDefinition {
  id: ActivityId;
  icon: string;
  label: string;
}

interface WorkspaceActionButtonProps {
  action?: DemoAction;
  children: ReactRuntime.ReactNode;
  className?: string;
  label: string;
}

const PREVIEW_SCOPE: PreviewModuleScope = {
  react: ReactRuntime as Record<string, unknown>,
  'react/jsx-runtime': jsxRuntime as Record<string, unknown>,
  'react/jsx-dev-runtime': jsxDevRuntime as Record<string, unknown>,
};

const ACTIVITIES: ActivityDefinition[] = [
  { id: 'explorer', icon: '▤', label: 'Explorer' },
  { id: 'packages', icon: '◫', label: 'Packages' },
  { id: 'git', icon: '◇', label: 'Git' },
  { id: 'snapshots', icon: '◎', label: 'Snapshots' },
  { id: 'events', icon: '☰', label: 'Events' },
];

export function WorkspaceBrowserApp() {
  const localItemSequence = useRef(0);
  const [scenario, setScenario] = useState<WorkspaceScenario | null>(null);
  const [workspaceShell, setWorkspaceShell] = useState<WorkspaceShell | null>(null);
  const [timeline, setTimeline] = useState<DemoTimelineItem[]>([]);
  const [files, setFiles] = useState<WorkspaceFileRecord[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshotRecord[]>([]);
  const [packages, setPackages] = useState<InstalledPackage[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatusRow[]>([]);
  const [gitLog, setGitLog] = useState<GitLogEntry[]>([]);
  const [activeActivity, setActiveActivity] = useState<ActivityId>('explorer');
  const [activeTab, setActiveTab] = useState<WorkbenchTabId>('editor');
  const [busyActionId, setBusyActionId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<PreviewState>({
    status: 'idle',
    message: 'No preview compiled yet.',
  });
  const [sideWidth, setSideWidth] = useState(280);
  const [editorValue, setEditorValue] = useState('');
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const [packageSpec, setPackageSpec] = useState('lucide-react');
  const [commitMessage, setCommitMessage] = useState('Update workspace demo state');

  const fileRecords = useMemo(() => files.filter((file) => file.type === 'file'), [files]);
  const selectedFile = useMemo(
    () =>
      fileRecords.find((file) => file.path === selectedPath) ??
      fileRecords.find((file) => file.path.endsWith('/src/App.tsx')) ??
      fileRecords[0],
    [fileRecords, selectedPath],
  );
  const selectedIsDirty = Boolean(selectedFile && dirtyPaths.has(selectedFile.path));

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

  const refreshWorkspaceState = useCallback(async (current: WorkspaceScenario) => {
    const nextFiles = await listWorkspaceFiles(current.workspace);
    setFiles(nextFiles);
    setSelectedPath((path) => {
      const appPath = nextFiles.find(
        (file) => file.type === 'file' && file.path.endsWith('/src/App.tsx'),
      )?.path;
      if (path && nextFiles.some((file) => file.type === 'file' && file.path === path)) {
        return path.endsWith('/package.json') && appPath ? appPath : path;
      }
      return appPath ?? nextFiles.find((file) => file.type === 'file')?.path;
    });
    setSnapshots([...current.snapshots]);
    setPackages(Object.values(await current.workspace.packages.list()));
    const git = await current.workspace.createGit();
    try {
      setGitStatus(await git.status());
      setGitLog(await git.log({ depth: 8 }));
    } catch {
      setGitStatus([]);
      setGitLog([]);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let current: WorkspaceScenario | null = null;

    async function start() {
      try {
        current = await createWorkspaceScenario({
          id: 'workspace-browser',
          storage: 'opfs-with-memory-fallback',
          onTimelineItem(item) {
            setTimeline((items) => [...items, item]);
            const activeScenario = current;
            if (activeScenario && !disposed) void refreshWorkspaceState(activeScenario);
          },
        });
        if (disposed) {
          current.dispose();
          return;
        }
        setScenario(current);
        const git = await current.workspace.createGit();
        setWorkspaceShell(
          await current.workspace.createShell({
            builtins: [createWorkspaceGitCommand({ git, root: current.workspace.root })],
          }),
        );
        appendTimelineItem({
          kind: 'note',
          title: 'workspace manager ready',
          body: 'Files, shell, packages, git, snapshots, and preview compilation are connected in one browser workspace.',
          status: 'ok',
        });
        await refreshWorkspaceState(current);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void start();
    return () => {
      disposed = true;
      current?.dispose();
    };
  }, [appendTimelineItem, refreshWorkspaceState]);

  useEffect(() => {
    setEditorValue(selectedFile?.content ?? '');
  }, [selectedFile?.content, selectedFile?.path]);

  const runAction = useCallback(
    async (
      id: string,
      title: string,
      body: string,
      action: (current: WorkspaceScenario) => Promise<void>,
    ) => {
      if (!scenario || busyActionId) return;
      appendTimelineItem({ kind: 'operator', title, body, status: 'pending' });
      setBusyActionId(id);
      setError(undefined);
      try {
        await action(scenario);
        await refreshWorkspaceState(scenario);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        recordWorkspaceError(scenario, message);
      } finally {
        setBusyActionId(undefined);
      }
    },
    [appendTimelineItem, busyActionId, refreshWorkspaceState, scenario],
  );

  const ensureSeeded = useCallback(async (current: WorkspaceScenario) => {
    try {
      await current.workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8');
    } catch {
      await seedWorkspaceFiles(current.workspace, 'Hello workspace');
    }
  }, []);

  const compilePreview = useCallback(
    async (current: WorkspaceScenario) => {
      await ensureSeeded(current);
      const importMap = await current.workspace.packages.getImportMap();
      const runtime = await current.workspace.createReactPreview({
        entry: '/work/src/App.tsx',
        react: ReactRuntime as Record<string, unknown>,
        jsxRuntime: jsxRuntime as Record<string, unknown>,
        jsxDevRuntime: jsxDevRuntime as Record<string, unknown>,
        importMap,
        esbuildOptions: { wasmURL: '/esbuild.wasm' },
      });
      const result = await runtime.compile();
      recordPreviewCompile(current, result);
      if (!result.ok) {
        setPreview({
          status: 'failed',
          message: result.diagnostics.map((diagnostic) => diagnostic.message).join('\n'),
        });
        return;
      }
      setPreview({
        status: 'compiled',
        message: `Compiled ${(result as PreviewCompileResult & { ok: true }).code.length} bytes from /work/src/App.tsx.`,
        component: result.evaluate(runtime.scope(PREVIEW_SCOPE)),
      });
    },
    [ensureSeeded],
  );

  const executeTerminalCommand = useCallback(
    async (command: string): Promise<ShellResult> => {
      if (!scenario || !workspaceShell) {
        throw new Error('Workspace shell is not ready.');
      }
      const result = await workspaceShell.exec(command);
      scenario.record({ type: 'shell', command, result, timestamp: Date.now() });
      await refreshWorkspaceState(scenario);
      return result;
    },
    [refreshWorkspaceState, scenario, workspaceShell],
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      setEditorValue(value);
      if (!selectedFile) return;
      setDirtyPaths((paths) => {
        const next = new Set(paths);
        if (value === (selectedFile.content ?? '')) next.delete(selectedFile.path);
        else next.add(selectedFile.path);
        return next;
      });
    },
    [selectedFile],
  );

  const saveSelectedFile = useCallback(async () => {
    if (!scenario || !selectedFile || !selectedIsDirty) return;
    await runAction(
      'save',
      'operator saved file',
      selectedFile.path,
      async (current) => {
        await current.workspace.fs.promises.writeFile(selectedFile.path, editorValue);
        setDirtyPaths((paths) => {
          const next = new Set(paths);
          next.delete(selectedFile.path);
          return next;
        });
      },
    );
  }, [editorValue, runAction, scenario, selectedFile, selectedIsDirty]);

  const restoreSnapshot = useCallback(
    async (id: string) => {
      const snapshot = snapshots.find((item) => item.id === id);
      await runAction(
        `restore:${id}`,
        'operator restored snapshot',
        snapshot ? snapshot.label : id,
        async (current) => {
          await restoreWorkspaceSnapshot(current, id);
        },
      );
    },
    [runAction, snapshots],
  );

  const actions = useMemo<DemoAction[]>(() => {
    const disabled = !scenario || Boolean(busyActionId);
    const cleanPackageSpec = packageSpec.trim();
    const cleanCommitMessage = commitMessage.trim() || 'Update workspace demo state';
    return [
      {
        id: 'seed',
        icon: '▶',
        label: busyActionId === 'seed' ? 'Seeding' : 'Seed workspace',
        description: 'Write package metadata, a React entry, and a theme module.',
        consequence: 'The Explorer tree and Editor tab update from workspace fs events.',
        primary: true,
        disabled,
        run: () =>
          runAction(
            'seed',
            'operator seeded the workspace',
            'Write the starter React app directly through workspace.fs.',
            async (current) => {
              await seedWorkspaceFiles(current.workspace, 'Hello workspace');
            },
          ),
      },
      {
        id: 'edit',
        icon: '✎',
        label: busyActionId === 'edit' ? 'Editing' : 'Edit sample',
        description: 'Change the visible heading in /work/src/App.tsx.',
        consequence: 'The selected editor buffer refreshes from the workspace file event.',
        disabled,
        run: () =>
          runAction(
            'edit',
            'operator edited the app',
            'Patch the React entry file through workspace.fs.',
            async (current) => {
              await ensureSeeded(current);
              const content = await current.workspace.fs.promises.readFile(
                '/work/src/App.tsx',
                'utf8',
              );
              const title = content.includes('Hello workspace')
                ? 'Hello edited workspace'
                : 'Hello workspace';
              await editWorkspaceGreeting(current.workspace, title);
            },
          ),
      },
      {
        id: 'preview',
        icon: '▶',
        label: busyActionId === 'preview' ? 'Compiling' : 'Compile preview',
        description: 'Compile the React entry with esbuild-wasm and host React modules.',
        consequence: 'Preview renders the component or shows compiler diagnostics.',
        disabled,
        run: () =>
          runAction(
            'preview',
            'operator compiled preview',
            'Compile /work/src/App.tsx without a dev server.',
            compilePreview,
          ),
      },
      {
        id: 'snapshot',
        icon: '◎',
        label: busyActionId === 'snapshot' ? 'Creating' : 'Create snapshot',
        description: 'Capture the current /work filesystem snapshot.',
        consequence: 'A restore point appears in the Snapshots sidebar.',
        disabled,
        run: () =>
          runAction(
            'snapshot',
            'operator created snapshot',
            'Snapshot the current workspace root.',
            async (current) => {
              await ensureSeeded(current);
              await createWorkspaceSnapshot(
                current,
                `workspace snapshot ${current.snapshots.length + 1}`,
              );
            },
          ),
      },
      {
        id: 'package',
        icon: '+',
        label: busyActionId === 'package' ? 'Installing' : 'Install',
        description: `Resolve ${cleanPackageSpec || 'a package'} through the workspace package registry.`,
        consequence: 'The package appears in the compact package list.',
        disabled: !scenario || cleanPackageSpec.length === 0,
        run: () =>
          runAction(
            'package',
            'operator installed package',
            `Install ${cleanPackageSpec} into the browser package registry.`,
            async (current) => {
              await installWorkspacePackage(current, { name: cleanPackageSpec, version: 'latest' });
            },
          ),
      },
      {
        id: 'git',
        icon: '◇',
        label: busyActionId === 'git' ? 'Committing' : 'Commit',
        description: 'Initialize git, stage workspace files, and create a commit.',
        consequence: 'Git shows the changed files and recent commit history.',
        disabled: !scenario,
        run: () =>
          runAction(
            'git',
            'operator committed workspace',
            cleanCommitMessage,
            async (current) => {
              await ensureSeeded(current);
              await current.workspace.fs.promises.writeFile(
                '/work/README.md',
                `# Workspace browser demo\n\nUpdated ${new Date().toISOString()}.\n`,
              );
              const git = await current.workspace.createGit();
              await git.init();
              current.record({
                type: 'git:init',
                branch: await git.currentBranch(),
                timestamp: Date.now(),
              });
              await git.stageAll();
              const oid = await git.commit({
                message: cleanCommitMessage,
                authorName: 'Inbrowser Examples',
                authorEmail: 'examples@inbrowser.local',
              });
              current.record({
                type: 'git:commit',
                oid,
                message: cleanCommitMessage,
                timestamp: Date.now(),
              });
            },
          ),
      },
    ];
  }, [
    busyActionId,
    commitMessage,
    compilePreview,
    ensureSeeded,
    packageSpec,
    runAction,
    scenario,
  ]);

  const seedAction = actions.find((action) => action.id === 'seed');
  const editAction = actions.find((action) => action.id === 'edit');
  const previewAction = actions.find((action) => action.id === 'preview');
  const snapshotAction = actions.find((action) => action.id === 'snapshot');
  const packageAction = actions.find((action) => action.id === 'package');
  const gitAction = actions.find((action) => action.id === 'git');
  const status = error ?? (scenario ? 'ready' : 'starting');
  const sidePanelTitle = ACTIVITIES.find((activity) => activity.id === activeActivity)?.label ?? '';

  return (
    <div className="workspace-ide" style={{ '--side-width': `${sideWidth}px` } as ReactRuntime.CSSProperties}>
      <TopBar
        status={status}
        seedAction={seedAction}
        previewAction={previewAction}
        onSave={() => void saveSelectedFile()}
        canSave={selectedIsDirty}
        onCopySession={() => void copyText(buildSessionText(timeline))}
      />

      <main className="workspace-ide-main">
        <ActivityBar activeActivity={activeActivity} onSelect={setActiveActivity} />

        <aside className="ide-side-pane" aria-label={sidePanelTitle}>
          <header className="ide-pane-header">
            <span>{sidePanelTitle}</span>
            {activeActivity === 'explorer' ? <strong>/work</strong> : null}
          </header>
          <div className="ide-side-body">
            {activeActivity === 'explorer' ? (
              <ExplorerPanel
                files={files}
                selectedPath={selectedFile?.path}
                onSelectPath={(path) => {
                  setSelectedPath(path);
                  setActiveTab('editor');
                }}
                seedAction={seedAction}
              />
            ) : null}
            {activeActivity === 'packages' ? (
              <PackagesPanel
                packages={packages}
                packageSpec={packageSpec}
                onPackageSpecChange={setPackageSpec}
                installAction={packageAction}
              />
            ) : null}
            {activeActivity === 'git' ? (
              <GitPanel
                status={gitStatus}
                log={gitLog}
                commitMessage={commitMessage}
                onCommitMessageChange={setCommitMessage}
                commitAction={gitAction}
              />
            ) : null}
            {activeActivity === 'snapshots' ? (
              <SnapshotsPanel
                snapshots={snapshots}
                createAction={snapshotAction}
                onRestore={(id) => void restoreSnapshot(id)}
                busy={Boolean(busyActionId)}
              />
            ) : null}
            {activeActivity === 'events' ? <EventsPanel items={timeline} /> : null}
          </div>
        </aside>

        <ResizeHandle value={sideWidth} onChange={setSideWidth} />

        <section className="ide-workbench" aria-label="Workbench">
          <WorkbenchTabs
            activeTab={activeTab}
            selectedPath={selectedFile?.path}
            onSelectTab={setActiveTab}
          />
          <div className="ide-workbench-body">
            {activeTab === 'editor' ? (
              <EditorPane
                value={editorValue}
                file={selectedFile}
                fileCount={fileRecords.length}
                dirty={selectedIsDirty}
                onChange={handleEditorChange}
                onSave={() => void saveSelectedFile()}
                editAction={editAction}
              />
            ) : null}
            {activeTab === 'preview' ? <PreviewPane preview={preview} /> : null}
            {activeTab === 'terminal' ? (
              <TerminalPane shell={workspaceShell} executeCommand={executeTerminalCommand} />
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}

function TopBar({
  status,
  seedAction,
  previewAction,
  canSave,
  onSave,
  onCopySession,
}: {
  status: string;
  seedAction?: DemoAction;
  previewAction?: DemoAction;
  canSave: boolean;
  onSave(): void;
  onCopySession(): void;
}) {
  return (
    <header className="ide-topbar">
      <div className="ide-brand">
        <strong>inbrowser examples</strong>
        <span>@inbrowser/workspace</span>
      </div>
      <output className="ide-status">{status}</output>
      <div className="ide-global-actions">
        <WorkspaceActionButton action={previewAction} label="Compile preview">
          ▶
        </WorkspaceActionButton>
        <WorkspaceActionButton action={seedAction} label="Seed workspace">
          Seed
        </WorkspaceActionButton>
        <button type="button" className="ide-button" disabled={!canSave} onClick={onSave}>
          Save
        </button>
        <button type="button" className="ide-button" onClick={onCopySession}>
          Copy
        </button>
      </div>
    </header>
  );
}

function ActivityBar({
  activeActivity,
  onSelect,
}: {
  activeActivity: ActivityId;
  onSelect(activity: ActivityId): void;
}) {
  return (
    <nav className="ide-activity-bar" aria-label="Workspace sections">
      {ACTIVITIES.map((activity) => (
        <button
          key={activity.id}
          type="button"
          className="ide-activity-button"
          data-active={activity.id === activeActivity}
          title={activity.label}
          aria-label={activity.label}
          onClick={() => onSelect(activity.id)}
        >
          <span aria-hidden="true">{activity.icon}</span>
        </button>
      ))}
    </nav>
  );
}

function ResizeHandle({
  value,
  onChange,
}: {
  value: number;
  onChange(value: number): void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);

  const clamp = (width: number) => Math.max(220, Math.min(420, width));
  const update = (clientX: number) => {
    if (!start.current) return;
    onChange(clamp(start.current.width + clientX - start.current.x));
  };
  const beginDocumentDrag = (clientX: number) => {
    start.current = { x: clientX, width: value };
    const onMouseMove = (event: MouseEvent) => update(event.clientX);
    const onMouseUp = () => {
      start.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp, { once: true });
  };
  const onPointerDown = (event: ReactRuntime.PointerEvent<HTMLDivElement>) => {
    start.current = { x: event.clientX, width: value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactRuntime.PointerEvent<HTMLDivElement>) => {
    update(event.clientX);
  };
  const onPointerUp = (event: ReactRuntime.PointerEvent<HTMLDivElement>) => {
    start.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className="ide-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={220}
      aria-valuemax={420}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseDown={(event) => {
        event.preventDefault();
        beginDocumentDrag(event.clientX);
      }}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        if (touch) beginDocumentDrag(touch.clientX);
      }}
    />
  );
}

function WorkbenchTabs({
  activeTab,
  selectedPath,
  onSelectTab,
}: {
  activeTab: WorkbenchTabId;
  selectedPath?: string;
  onSelectTab(tab: WorkbenchTabId): void;
}) {
  const tabs: Array<{ id: WorkbenchTabId; label: string }> = [
    { id: 'editor', label: selectedPath ? selectedPath.replace('/work/', '') : 'Editor' },
    { id: 'preview', label: 'Preview' },
    { id: 'terminal', label: 'Terminal' },
  ];

  return (
    <div className="ide-workbench-tabs">
      <div role="tablist" aria-label="Workspace tabs" className="ide-tab-list">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="ide-tab"
            data-active={tab.id === activeTab}
            aria-selected={tab.id === activeTab}
            onClick={() => onSelectTab(tab.id)}
          >
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ExplorerPanel({
  files,
  selectedPath,
  onSelectPath,
  seedAction,
}: {
  files: readonly WorkspaceFileRecord[];
  selectedPath?: string;
  onSelectPath(path: string): void;
  seedAction?: DemoAction;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(['/work', '/work/src']),
  );
  const tree = useMemo(() => buildWorkspaceTree(files), [files]);
  const rows = useMemo(
    () => flattenWorkspaceTree(tree, expandedPaths),
    [expandedPaths, tree],
  );

  if (rows.length === 0) {
    return (
      <div className="ide-empty-line">
        <span>No files.</span>
        <WorkspaceActionButton action={seedAction} label="Seed workspace">
          Seed Workspace
        </WorkspaceActionButton>
      </div>
    );
  }

  return (
    <div className="ide-tree" role="tree" aria-label="Workspace files">
      {rows.map(({ node, depth }) => {
        const expanded = expandedPaths.has(node.path);
        const isDirectory = node.type === 'directory';
        return (
          <button
            key={node.path}
            type="button"
            role="treeitem"
            aria-expanded={isDirectory ? expanded : undefined}
            className="ide-tree-row"
            data-active={node.path === selectedPath}
            data-type={node.type}
            style={{ '--depth': depth } as ReactRuntime.CSSProperties}
            onClick={() => {
              if (isDirectory) {
                setExpandedPaths((paths) => {
                  const next = new Set(paths);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                });
                return;
              }
              onSelectPath(node.path);
            }}
          >
            <span className="ide-tree-caret" aria-hidden="true">
              {isDirectory ? (expanded ? '▾' : '▸') : ''}
            </span>
            <span className="ide-tree-name">{node.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function EditorPane({
  value,
  file,
  fileCount,
  dirty,
  onChange,
  onSave,
  editAction,
}: {
  value: string;
  file?: WorkspaceFileRecord;
  fileCount: number;
  dirty: boolean;
  onChange(value: string): void;
  onSave(): void;
  editAction?: DemoAction;
}) {
  return (
    <div className="ide-editor-pane">
      <header className="ide-editor-header">
        <div>
          <span>Editor · {fileCount} files</span>
          <strong>{file?.path ?? 'No file selected'}</strong>
        </div>
        <div className="ide-editor-actions">
          <button type="button" className="ide-button" disabled={!dirty} onClick={onSave}>
            Save
          </button>
          <WorkspaceActionButton action={editAction} label="Edit sample app">
            Edit sample
          </WorkspaceActionButton>
        </div>
      </header>
      {file ? (
        <CodeMirrorEditor path={file.path} value={value} onChange={onChange} />
      ) : (
        <div className="ide-workbench-empty">
          <strong>No file selected</strong>
          <span>Seed the workspace or choose a file from Explorer.</span>
        </div>
      )}
    </div>
  );
}

function CodeMirrorEditor({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange(value: string): void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          javascript({ jsx: path.endsWith('.tsx') || path.endsWith('.jsx'), typescript: true }),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return <div className="ide-codemirror" data-testid="codemirror-editor" ref={hostRef} />;
}

function PreviewPane({ preview }: { preview: PreviewState }) {
  return (
    <div className="ide-preview-pane">
      {preview.status === 'failed' ? (
        <div className="ide-problems-strip" role="status">
          <strong>Problem</strong>
          <span>{preview.message}</span>
        </div>
      ) : null}
      {preview.status === 'idle' ? (
        <div className="ide-workbench-empty">
          <strong>No preview compiled yet</strong>
          <span>Use the play button in the tab bar to compile /work/src/App.tsx.</span>
        </div>
      ) : null}
      {preview.status === 'compiled' ? (
        <div className="ide-preview-frame">
          {renderPreviewComponent(preview.component)}
        </div>
      ) : null}
    </div>
  );
}

function TerminalPane({
  shell,
  executeCommand,
}: {
  shell: WorkspaceShell | null;
  executeCommand(command: string): Promise<ShellResult>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const commandRef = useRef('');
  const promptRef = useRef('/work $ ');
  const executeRef = useRef(executeCommand);
  executeRef.current = executeCommand;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new XTermTerminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      theme: {
        background: '#050505',
        foreground: '#d8d8d8',
        cursor: '#ffffff',
        selectionBackground: '#2e2e2e',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.write('browser shell ready\r\n');
    terminal.write(promptRef.current);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            fit.fit();
          })
        : null;
    resizeObserver?.observe(host);

    const subscription = terminal.onData((data) => {
      void handleTerminalInput(data, terminal, commandRef, promptRef, executeRef);
    });
    terminalRef.current = terminal;

    return () => {
      subscription.dispose();
      resizeObserver?.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!shell || !terminalRef.current) return;
    promptRef.current = `${shell.cwd()} $ `;
  }, [shell]);

  return <div className="ide-terminal-host" data-testid="xterm-terminal" ref={hostRef} />;
}

async function handleTerminalInput(
  data: string,
  terminal: XTermTerminal,
  commandRef: ReactRuntime.MutableRefObject<string>,
  promptRef: ReactRuntime.MutableRefObject<string>,
  executeRef: ReactRuntime.MutableRefObject<(command: string) => Promise<ShellResult>>,
): Promise<void> {
  for (const character of data) {
    await handleTerminalCharacter(character, terminal, commandRef, promptRef, executeRef);
  }
}

async function handleTerminalCharacter(
  character: string,
  terminal: XTermTerminal,
  commandRef: ReactRuntime.MutableRefObject<string>,
  promptRef: ReactRuntime.MutableRefObject<string>,
  executeRef: ReactRuntime.MutableRefObject<(command: string) => Promise<ShellResult>>,
): Promise<void> {
  if (character === '\r' || character === '\n') {
    const command = commandRef.current.trim();
    commandRef.current = '';
    terminal.write('\r\n');
    if (!command) {
      terminal.write(promptRef.current);
      return;
    }
    try {
      const result = await executeRef.current(command);
      if (result.stdout) terminal.write(result.stdout.replaceAll('\n', '\r\n'));
      if (result.stderr) terminal.write(result.stderr.replaceAll('\n', '\r\n'));
      if (!result.stdout && !result.stderr) terminal.write(`exit ${result.exitCode}\r\n`);
      promptRef.current = `${result.cwd} $ `;
    } catch (err) {
      terminal.write(`${err instanceof Error ? err.message : String(err)}\r\n`);
    }
    terminal.write(promptRef.current);
    return;
  }
  if (character === '\u007F') {
    if (commandRef.current.length === 0) return;
    commandRef.current = commandRef.current.slice(0, -1);
    terminal.write('\b \b');
    return;
  }
  if (character >= ' ') {
    commandRef.current += character;
    terminal.write(character);
  }
}

function PackagesPanel({
  packages,
  packageSpec,
  onPackageSpecChange,
  installAction,
}: {
  packages: readonly InstalledPackage[];
  packageSpec: string;
  onPackageSpecChange(value: string): void;
  installAction?: DemoAction;
}) {
  return (
    <div className="ide-side-section">
      <label className="ide-input-row">
        <span>Install</span>
        <input
          value={packageSpec}
          placeholder="lucide-react"
          onChange={(event) => onPackageSpecChange(event.target.value)}
        />
        <WorkspaceActionButton action={installAction} label="Install package">
          Install
        </WorkspaceActionButton>
      </label>
      <div className="ide-list" aria-label="Installed packages">
        {packages.length === 0 ? <p className="ide-muted">No packages installed.</p> : null}
        {packages.map((pkg) => (
          <details key={pkg.name} className="ide-list-row">
            <summary>
              <strong>{pkg.name}</strong>
              <span>{pkg.version}</span>
            </summary>
            <p>{pkg.url}</p>
          </details>
        ))}
      </div>
    </div>
  );
}

function GitPanel({
  status,
  log,
  commitMessage,
  onCommitMessageChange,
  commitAction,
}: {
  status: readonly GitStatusRow[];
  log: readonly GitLogEntry[];
  commitMessage: string;
  onCommitMessageChange(value: string): void;
  commitAction?: DemoAction;
}) {
  return (
    <div className="ide-side-section">
      <label className="ide-input-row">
        <span>Message</span>
        <input
          value={commitMessage}
          placeholder="Commit message"
          onChange={(event) => onCommitMessageChange(event.target.value)}
        />
        <WorkspaceActionButton action={commitAction} label="Create commit">
          Commit
        </WorkspaceActionButton>
      </label>
      <section className="ide-sidebar-group">
        <h2>Changes</h2>
        {status.length === 0 ? <p className="ide-muted">No changed files.</p> : null}
        <ul className="ide-compact-list">
          {status.map((row) => (
            <li key={row.filepath}>
              <span>{row.filepath}</span>
              <em>{row.status}</em>
            </li>
          ))}
        </ul>
      </section>
      <section className="ide-sidebar-group">
        <h2>History</h2>
        {log.length === 0 ? <p className="ide-muted">No commits yet.</p> : null}
        <ul className="ide-compact-list">
          {log.map((entry) => (
            <li key={entry.oid}>
              <span>{entry.message.trim()}</span>
              <em>{entry.oid.slice(0, 8)}</em>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SnapshotsPanel({
  snapshots,
  createAction,
  onRestore,
  busy,
}: {
  snapshots: readonly WorkspaceSnapshotRecord[];
  createAction?: DemoAction;
  onRestore(id: string): void;
  busy: boolean;
}) {
  return (
    <div className="ide-side-section">
      <div className="ide-sidebar-toolbar">
        <WorkspaceActionButton action={createAction} label="Create snapshot">
          Create
        </WorkspaceActionButton>
      </div>
      <div className="ide-list" aria-label="Snapshots">
        {snapshots.length === 0 ? <p className="ide-muted">No snapshots yet.</p> : null}
        {snapshots.map((snapshot) => (
          <div key={snapshot.id} className="ide-list-row">
            <div>
              <strong>{snapshot.label}</strong>
              <span>
                {snapshot.entryCount} entries · {new Date(snapshot.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <button
              type="button"
              className="ide-button ide-button-small"
              disabled={busy}
              onClick={() => onRestore(snapshot.id)}
            >
              Restore
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventsPanel({ items }: { items: readonly DemoTimelineItem[] }) {
  const rows = useMemo(() => buildIdeEventRows(items), [items]);
  if (rows.length === 0) return <p className="ide-muted">No workspace events yet.</p>;
  return (
    <ol className="ide-event-list">
      {rows.map((row) => (
        <li key={row.id} className="ide-event-row" data-status={row.status ?? 'info'}>
          <div className="ide-event-head">
            <span>{row.kind}</span>
            <time>{row.time}</time>
          </div>
          <strong>{row.title}</strong>
          {row.body ? <p>{row.body}</p> : null}
          {row.fields.length > 0 ? (
            <details>
              <summary>Details</summary>
              <dl>
                {row.fields.map((field) => (
                  <ReactRuntime.Fragment key={field.label}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </ReactRuntime.Fragment>
                ))}
              </dl>
            </details>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function WorkspaceActionButton({ action, children, className = 'ide-button', label }: WorkspaceActionButtonProps) {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={action?.label ?? label}
      disabled={!action || action.disabled}
      onClick={() => action?.run()}
    >
      {children}
    </button>
  );
}

export function buildWorkspaceTree(files: readonly WorkspaceFileRecord[]): WorkspaceTreeNode[] {
  const root: WorkspaceTreeNode = { name: 'work', path: '/work', type: 'directory', children: [] };

  for (const record of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const relative = record.path.replace(/^\/work\/?/, '');
    if (!relative) continue;
    const parts = relative.split('/').filter(Boolean);
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part) continue;
      const path = `/work/${parts.slice(0, index + 1).join('/')}`;
      const isLast = index === parts.length - 1;
      const type = isLast ? record.type : 'directory';
      const child =
        current.children.find((node) => node.path === path) ??
        (() => {
          const next: WorkspaceTreeNode = { name: part, path, type, children: [] };
          current.children.push(next);
          return next;
        })();
      if (child.type !== type && isLast) child.type = type;
      current = child;
    }
  }

  sortTree(root.children);
  return root.children;
}

export function flattenWorkspaceTree(
  nodes: readonly WorkspaceTreeNode[],
  expandedPaths: ReadonlySet<string>,
  depth = 0,
): FlattenedWorkspaceTreeNode[] {
  const rows: FlattenedWorkspaceTreeNode[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.type === 'directory' && expandedPaths.has(node.path)) {
      rows.push(...flattenWorkspaceTree(node.children, expandedPaths, depth + 1));
    }
  }
  return rows;
}

export function buildIdeEventRows(items: readonly DemoTimelineItem[]): IdeEventRow[] {
  return items.map((item) => ({
    id: item.id,
    kind: item.kind,
    status: item.status,
    time: new Date(item.timestamp).toLocaleTimeString(),
    title: item.title,
    body: item.body,
    fields: detailFields(item.detail),
  }));
}

function sortTree(nodes: WorkspaceTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) sortTree(node.children);
}

function detailFields(detail?: string): Array<{ label: string; value: string }> {
  if (!detail) return [];
  try {
    const value = JSON.parse(detail) as Record<string, unknown>;
    return Object.entries(value)
      .filter(([key]) => key !== 'timestamp')
      .slice(0, 8)
      .map(([key, fieldValue]) => ({ label: key, value: summarizeField(fieldValue) }));
  } catch {
    return [{ label: 'detail', value: detail }];
  }
}

function summarizeField(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.path === 'string') return record.path;
    if (typeof record.label === 'string') return record.label;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.name === 'string') return record.name;
    if (typeof record.stdout === 'string') return record.stdout || String(record.exitCode ?? 'ok');
    return Object.keys(record).slice(0, 4).join(', ');
  }
  return String(value);
}

function renderPreviewComponent(component: unknown): ReactRuntime.ReactNode {
  if (typeof component === 'function') {
    return ReactRuntime.createElement(component as ReactRuntime.ComponentType);
  }
  if (ReactRuntime.isValidElement(component)) return component;
  return null;
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
