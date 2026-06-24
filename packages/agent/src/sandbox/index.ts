import type { Sandbox, SandboxTool, SandboxToolResult } from '@inbrowser/sandbox';
import type { ToolContext, ToolDispatch, ToolHandler, ToolResult } from '../types/tools.js';

export interface SandboxAgentToolsOptions {
  names?: readonly string[];
}

export interface SandboxAgentTools {
  readonly toolList: readonly ToolHandler[];
  readonly dispatch: ToolDispatch;
}

export function createSandboxAgentTools(
  sandbox: Sandbox,
  options: SandboxAgentToolsOptions = {},
): SandboxAgentTools {
  const toolList = createToolHandlers(sandbox, options.names);
  const handlers = new Map(toolList.map((handler) => [handler.name, handler]));
  const dispatch: ToolDispatch = {
    async execute(call, ctx) {
      const handler = handlers.get(call.name);
      if (!handler) return { ok: false, summary: `Unknown tool: ${call.name}` };
      return handler.execute(call.args, ctx);
    },
  };
  return { toolList, dispatch };
}

function createToolHandlers(sandbox: Sandbox, names?: readonly string[]): ToolHandler[] {
  const allowed = names ? new Set(names) : null;
  return sandbox.tools.list
    .filter((tool) => !allowed || allowed.has(tool.name))
    .map((tool) => createSandboxToolHandler(tool, sandbox));
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
