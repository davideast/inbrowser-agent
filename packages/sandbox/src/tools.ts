import { assertInsideSandbox, dirname, resolveSandboxPath } from './path.js';
import type { JsonSchema, Sandbox, SandboxTool, SandboxToolResult, SandboxTools } from './types.js';

export function standardSandboxTools(): readonly SandboxTool[] {
  return [
    readTool(),
    writeTool(),
    editTool(),
    lsTool(),
    grepTool(),
    findTool(),
    bashTool(),
    gitStatusTool(),
    packageInstallTool(),
    previewCompileTool(),
  ];
}

export function createSandboxTools(
  sandbox: Sandbox,
  tools: readonly SandboxTool[] = [],
): SandboxTools {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    list: tools,
    get(name) {
      return byName.get(name);
    },
    async run(name, args, options) {
      const tool = byName.get(name);
      if (!tool) return { ok: false, summary: `Unknown sandbox tool: ${name}` };
      const controller = new AbortController();
      const signal = options?.signal ?? controller.signal;
      sandbox.emit({ type: 'tool:start', name, args });
      try {
        const result = await tool.execute(args as never, { sandbox, signal });
        sandbox.emit({ type: 'tool:finish', name, result });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = { ok: false, summary: `${name} failed: ${message}` };
        sandbox.emit({ type: 'tool:finish', name, result });
        sandbox.emit({ type: 'error', message, cause: err });
        return result;
      }
    },
  };
}

function readTool(): SandboxTool {
  return {
    name: 'read',
    description: 'Read a UTF-8 file from the sandbox.',
    parameters: objectSchema({ path: stringSchema() }, ['path']),
    pure: true,
    async execute(args, { sandbox }) {
      const path = scopedPath(sandbox, (args as { path: string }).path);
      const content = await sandbox.fs.promises.readFile(path, 'utf8');
      return { ok: true, summary: `read ${path}`, data: { path, content } };
    },
  };
}

function writeTool(): SandboxTool {
  return {
    name: 'write',
    description: 'Write a UTF-8 file in the sandbox, creating parent directories as needed.',
    parameters: objectSchema({ path: stringSchema(), content: stringSchema() }, [
      'path',
      'content',
    ]),
    async execute(args, { sandbox }) {
      const { path: inputPath, content } = args as { path: string; content: string };
      const path = scopedPath(sandbox, inputPath);
      await sandbox.fs.promises.mkdir(dirname(path), { recursive: true });
      await sandbox.fs.promises.writeFile(path, content);
      return {
        ok: true,
        summary: `wrote ${path}`,
        data: { path, bytes: new TextEncoder().encode(content).byteLength },
      };
    },
  };
}

function editTool(): SandboxTool {
  return {
    name: 'edit',
    description: 'Replace text within a UTF-8 file in the sandbox.',
    parameters: objectSchema(
      { path: stringSchema(), oldText: stringSchema(), newText: stringSchema() },
      ['path', 'oldText', 'newText'],
    ),
    async execute(args, { sandbox }) {
      const {
        path: inputPath,
        oldText,
        newText,
      } = args as {
        path: string;
        oldText: string;
        newText: string;
      };
      const path = scopedPath(sandbox, inputPath);
      const content = await sandbox.fs.promises.readFile(path, 'utf8');
      const index = content.indexOf(oldText);
      if (index < 0) {
        return { ok: false, summary: `edit failed: text not found in ${path}`, data: { path } };
      }
      const next = `${content.slice(0, index)}${newText}${content.slice(index + oldText.length)}`;
      await sandbox.fs.promises.writeFile(path, next);
      return {
        ok: true,
        summary: `edited ${path}`,
        data: { path, removedBytes: oldText.length, addedBytes: newText.length },
      };
    },
  };
}

function lsTool(): SandboxTool {
  return {
    name: 'ls',
    description: 'List files or directories in the sandbox.',
    parameters: objectSchema({ path: stringSchema() }),
    pure: true,
    async execute(args, { sandbox }) {
      const path = scopedPath(sandbox, (args as { path?: string }).path ?? '.');
      const entries = await sandbox.fs.promises.readdir(path, { withFileTypes: true });
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
  };
}

function grepTool(): SandboxTool {
  return {
    name: 'grep',
    description: 'Search UTF-8 files under a sandbox directory for a literal string.',
    parameters: objectSchema({ path: stringSchema(), query: stringSchema() }, ['query']),
    pure: true,
    async execute(args, { sandbox }) {
      const { query } = args as { query: string };
      const path = scopedPath(sandbox, (args as { path?: string }).path ?? '.');
      const files = await listFiles(sandbox, path);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of files) {
        const content = await safeReadUtf8(sandbox, file);
        if (content === null) continue;
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (line.includes(query)) matches.push({ path: file, line: index + 1, text: line });
        });
      }
      return { ok: true, summary: `${matches.length} match(es) for ${query}`, data: { matches } };
    },
  };
}

function findTool(): SandboxTool {
  return {
    name: 'find',
    description: 'Find sandbox files by literal path/name substring.',
    parameters: objectSchema({ path: stringSchema(), query: stringSchema() }, ['query']),
    pure: true,
    async execute(args, { sandbox }) {
      const { query } = args as { query: string };
      const path = scopedPath(sandbox, (args as { path?: string }).path ?? '.');
      const files = await listFiles(sandbox, path);
      const matches = files.filter((file) => file.includes(query));
      return { ok: true, summary: `${matches.length} file(s) found`, data: { matches } };
    },
  };
}

function bashTool(): SandboxTool {
  return {
    name: 'bash',
    description: 'Run a shell command through the sandbox runtime.',
    parameters: objectSchema({ command: stringSchema(), cwd: stringSchema() }, ['command']),
    async execute(args, { sandbox, signal }) {
      const { command, cwd } = args as { command: string; cwd?: string };
      const result = await sandbox.runtime.run(command, {
        cwd: cwd ? scopedPath(sandbox, cwd) : sandbox.cwd,
        signal,
      });
      return {
        ok: result.exitCode === 0,
        summary: result.exitCode === 0 ? `bash ok: ${command}` : `bash failed: ${command}`,
        data: result,
      };
    },
  };
}

function gitStatusTool(): SandboxTool {
  return {
    name: 'git_status',
    description: 'Return sandbox git status rows when a git service is available.',
    parameters: objectSchema({}),
    pure: true,
    async execute(_args, { sandbox }) {
      if (!sandbox.services.git) return unavailable('git');
      const rows = await sandbox.services.git.status();
      return { ok: true, summary: `${rows.length} changed file(s)`, data: { rows } };
    },
  };
}

function packageInstallTool(): SandboxTool {
  return {
    name: 'package_install',
    description: 'Install or register a browser-compatible package for the sandbox.',
    parameters: objectSchema({ name: stringSchema(), version: stringSchema() }, ['name']),
    async execute(args, { sandbox }) {
      if (!sandbox.services.packages) return unavailable('packages');
      const { name, version } = args as { name: string; version?: string };
      const installed = await sandbox.services.packages.install({ name, version });
      return {
        ok: true,
        summary: `installed ${name}${version ? `@${version}` : ''}`,
        data: installed,
      };
    },
  };
}

function previewCompileTool(): SandboxTool {
  return {
    name: 'preview_compile',
    description: 'Compile the sandbox preview entry when a preview service is available.',
    parameters: objectSchema({ source: stringSchema() }),
    pure: true,
    async execute(args, { sandbox }) {
      if (!sandbox.services.preview) return unavailable('preview');
      const source = (args as { source?: string }).source;
      const result = await sandbox.services.preview.compile(source);
      return { ok: true, summary: 'preview compiled', data: result };
    },
  };
}

function scopedPath(sandbox: Sandbox, path: string): string {
  return assertInsideSandbox(resolveSandboxPath(sandbox.cwd, path), sandbox.cwd);
}

async function listFiles(sandbox: Sandbox, path: string): Promise<string[]> {
  const stat = await sandbox.fs.promises.stat(path);
  if (stat.isFile()) return [path];
  const entries = await sandbox.fs.promises.readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? listFiles(sandbox, entry.path) : [entry.path])),
  );
  return nested.flat();
}

async function safeReadUtf8(sandbox: Sandbox, path: string): Promise<string | null> {
  try {
    return await sandbox.fs.promises.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function unavailable(service: string): SandboxToolResult {
  return { ok: false, summary: `${service} service is not available in this sandbox` };
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
