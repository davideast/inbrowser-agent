import type { Sandbox, SandboxTool, SandboxToolResult } from '@inbrowser/sandbox';
import type { ToolContext, ToolHandler, ToolRegistry, ToolResult } from '../types/tools.js';

export interface SandboxToolHandlerOptions {
  sandbox: Sandbox;
  names?: readonly string[];
}

export interface RegisterSandboxToolsOptions extends SandboxToolHandlerOptions {
  registry: ToolRegistry;
  replace?: boolean;
}

export function createSandboxToolHandlers(options: SandboxToolHandlerOptions): ToolHandler[] {
  const names = options.names ? new Set(options.names) : null;
  return options.sandbox.tools.list
    .filter((tool) => !names || names.has(tool.name))
    .map((tool) => createSandboxToolHandler(tool, options.sandbox));
}

export function registerSandboxTools(options: RegisterSandboxToolsOptions): ToolRegistry {
  const handlers = createSandboxToolHandlers(options);
  for (const handler of handlers) {
    if (options.replace) options.registry.replace(handler);
    else options.registry.register(handler);
  }
  return options.registry;
}

function createSandboxToolHandler(tool: SandboxTool, sandbox: Sandbox): ToolHandler {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    pure: tool.pure,
    parallelSafe: tool.pure === true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const signal = ctx.signal;
      const result = await sandbox.tools.run(tool.name, args, { signal });
      return toToolResult(result);
    },
  };
}

function toToolResult(result: SandboxToolResult): ToolResult {
  return {
    ok: result.ok,
    summary: result.summary,
    data: result.data,
  };
}
