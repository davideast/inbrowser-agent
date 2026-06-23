import type {
  BrowserWorkspace,
  ReactPreviewRuntimeOptions,
  WorkspaceFileSystem,
} from '@inbrowser/workspace';
import { createSandbox } from './core.js';
import type { RuntimeCapabilities, Sandbox, SandboxFileSystem, SandboxRuntime } from './types.js';

export interface CreateWorkspaceSandboxOptions {
  workspace: BrowserWorkspace;
  id?: string;
  cwd?: string;
  capabilities?: Partial<RuntimeCapabilities>;
  preview?: Omit<ReactPreviewRuntimeOptions, 'fs'>;
}

export async function createWorkspaceSandbox(
  options: CreateWorkspaceSandboxOptions,
): Promise<Sandbox> {
  const { workspace } = options;
  const cwd = options.cwd ?? workspace.root;
  const shell = await workspace.createShell({ cwd });
  const git = await workspace.createGit({ dir: workspace.root });
  const preview = options.preview ? await workspace.createReactPreview(options.preview) : undefined;
  const runtime: SandboxRuntime = {
    async run(command, runOptions) {
      if (runOptions?.cwd) shell.setCwd(runOptions.cwd);
      return shell.exec(command, {
        ...(runOptions?.signal ? { signal: runOptions.signal } : {}),
      });
    },
  };

  return createSandbox({
    id: options.id ?? workspace.id,
    cwd,
    fs: workspace.fs as WorkspaceFileSystem as SandboxFileSystem,
    runtime,
    capabilities: {
      shell: true,
      git: true,
      preview: Boolean(preview),
      packages: true,
      persistentStorage: workspace.storageStatus === 'persistent',
      ...options.capabilities,
    },
    services: {
      git,
      packages: workspace.packages,
      ...(preview ? { preview } : {}),
    },
  });
}
