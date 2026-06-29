import type { BrowserWorkspace } from '../index.js';

export type JsonSchema = Record<string, unknown>;

export interface WorkspaceAgentToolHandler<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  pure?: boolean;
  execute(
    args: A,
    ctx: { signal: AbortSignal },
  ): Promise<{
    ok: boolean;
    summary: string;
    data?: D;
  }>;
}

export interface WorkspaceToolOptions {
  workspace: BrowserWorkspace;
}

export async function createWorkspaceTools(
  options: WorkspaceToolOptions,
): Promise<WorkspaceAgentToolHandler[]> {
  const { workspace } = options;
  const shell = await workspace.createShell();
  const git = await workspace.createGit();
  return [
    {
      name: 'workspace_read_file',
      description: 'Read a UTF-8 file from the browser workspace.',
      parameters: objectSchema({ path: stringSchema() }, ['path']),
      pure: true,
      async execute(args: unknown) {
        const { path } = args as { path: string };
        const content = await workspace.fs.promises.readFile(path, 'utf8');
        return { ok: true, summary: `read ${path}`, data: { path, content } };
      },
    },
    {
      name: 'workspace_write_file',
      description:
        'Write a UTF-8 file in the browser workspace, creating parent directories as needed.',
      parameters: objectSchema({ path: stringSchema(), content: stringSchema() }, [
        'path',
        'content',
      ]),
      async execute(args: unknown) {
        const { path, content } = args as { path: string; content: string };
        await workspace.fs.promises.writeFile(path, content);
        return {
          ok: true,
          summary: `wrote ${path}`,
          data: { path, bytes: new TextEncoder().encode(content).byteLength },
        };
      },
    },
    {
      name: 'workspace_list_files',
      description: 'List files or directories in the browser workspace.',
      parameters: objectSchema({ path: stringSchema() }, ['path']),
      pure: true,
      async execute(args: unknown) {
        const { path } = args as { path: string };
        const entries = await workspace.fs.promises.readdir(path, { withFileTypes: true });
        return {
          ok: true,
          summary: `listed ${path}`,
          data: {
            path,
            entries: entries.map((entry) => ({
              name: entry.name,
              path: entry.path,
              type: entry.type,
            })),
          },
        };
      },
    },
    {
      name: 'workspace_bash',
      description: 'Run a browser shell command inside the workspace root.',
      parameters: objectSchema({ command: stringSchema() }, ['command']),
      async execute(args: unknown, ctx: { signal: AbortSignal }) {
        const { command } = args as { command: string };
        const result = await shell.exec(command, { signal: ctx.signal });
        return {
          ok: result.exitCode === 0,
          summary: result.exitCode === 0 ? `bash ok: ${command}` : `bash failed: ${command}`,
          data: result,
        };
      },
    },
    {
      name: 'workspace_git_status',
      description: 'Get browser workspace git status rows.',
      parameters: objectSchema({}),
      pure: true,
      async execute() {
        const rows = await git.status();
        return { ok: true, summary: `${rows.length} changed file(s)`, data: { rows } };
      },
    },
    {
      name: 'workspace_package_install',
      description: 'Add a browser-compatible package to the workspace import map.',
      parameters: objectSchema({ name: stringSchema(), version: stringSchema() }, ['name']),
      async execute(args: unknown) {
        const { name, version } = args as { name: string; version?: string };
        const installed = await workspace.packages.install({ name, version });
        return {
          ok: true,
          summary: `installed ${installed.name}@${installed.version}`,
          data: installed,
        };
      },
    },
  ];
}

function stringSchema(): JsonSchema {
  return { type: 'string' };
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}
