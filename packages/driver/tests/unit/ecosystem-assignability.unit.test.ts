import { describe, expect, it } from 'vitest';
import type { DriverTool, ObservationSnapshot } from '../../src/types.js';

/**
 * Exact structural mirror of `@inbrowser/agent` `JsonSchema`, `ToolContext`,
 * `ToolResult`, and `ToolHandler` under `exactOptionalPropertyTypes: true`.
 */
type AgentJsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, AgentJsonSchema>;
  required?: string[];
  items?: AgentJsonSchema | AgentJsonSchema[];
  enum?: unknown[];
  [key: string]: unknown;
};

interface AgentToolContext {
  signal: AbortSignal;
  workspace?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

interface AgentToolResult<D = unknown> {
  ok: boolean;
  summary: string;
  data?: D;
  workspacePatch?: Record<string, unknown>;
  runtimePatch?: Record<string, unknown>;
}

interface AgentToolHandler<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: AgentJsonSchema;
  available?(capabilities: Record<string, boolean>): boolean;
  parallelSafe?: boolean;
  pure?: boolean;
  execute(args: A, ctx: AgentToolContext): Promise<AgentToolResult<D>>;
}

/**
 * Exact structural mirror of `@inbrowser/sandbox` `SandboxToolResult` and
 * `SandboxTool` under `exactOptionalPropertyTypes: true`.
 */
type SandboxJsonSchema = Record<string, unknown>;

interface SandboxHandleLike {
  readonly id: string;
  readonly cwd: string;
}

interface SandboxToolResult<D = unknown> {
  ok: boolean;
  summary: string;
  data?: D;
}

interface SandboxTool<A = unknown, D = unknown> {
  name: string;
  description: string;
  parameters: SandboxJsonSchema;
  pure?: boolean;
  execute(
    args: A,
    ctx: { sandbox: SandboxHandleLike; signal: AbortSignal },
  ): Promise<SandboxToolResult<D>>;
}

describe('DriverTool structural ecosystem assignability', () => {
  it('assigns both default and concrete DriverTool definitions to AgentToolHandler and SandboxTool', async () => {
    const observeTool: DriverTool<{ readonly scope?: string }, ObservationSnapshot> = {
      name: 'ui_observe',
      description: 'Observe current UI state.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Optional landmark or CSS scope.' },
        },
      },
      parallelSafe: false,
      pure: false,
      async execute(args, ctx) {
        if (ctx?.signal?.aborted) {
          return { ok: false, summary: 'aborted' };
        }
        return {
          ok: true,
          summary: `observed ${args.scope ?? 'document'}`,
          data: {
            rev: 1,
            url: 'http://localhost:4701/frame',
            title: 'Timeline Workspace',
            viewport: { width: 800, height: 600 },
            diagnostics: {
              compileOverlay: null,
              consoleErrors: [],
              pageErrors: [],
              networkFailures: [],
            },
            elements: [],
          },
        };
      },
    };

    const genericTool: DriverTool = {
      name: 'ui_act',
      description: 'Execute transactional UI steps.',
      parameters: {
        type: 'object',
        required: ['rev', 'steps'],
      },
      async execute() {
        return { ok: true, summary: 'completed 0 steps' };
      },
    };

    // Compile-time structural assignability checks against both target ecosystems.
    const agentSpecific: AgentToolHandler<{ readonly scope?: string }, ObservationSnapshot> =
      observeTool;
    const agentErased: AgentToolHandler = observeTool;
    const agentFromGeneric: AgentToolHandler = genericTool;

    const sandboxSpecific: SandboxTool<{ readonly scope?: string }, ObservationSnapshot> =
      observeTool;
    const sandboxErased: SandboxTool = observeTool;
    const sandboxFromGeneric: SandboxTool = genericTool;

    const controller = new AbortController();
    const agentRes = await agentSpecific.execute({ scope: 'main' }, { signal: controller.signal });
    const sandboxRes = await sandboxSpecific.execute(
      { scope: 'main' },
      { sandbox: { id: 'sb-1', cwd: '/workspace' }, signal: controller.signal },
    );

    expect(agentErased.name).toBe('ui_observe');
    expect(agentFromGeneric.name).toBe('ui_act');
    expect(sandboxErased.name).toBe('ui_observe');
    expect(sandboxFromGeneric.name).toBe('ui_act');
    expect(agentRes.ok).toBe(true);
    expect(agentRes.summary).toBe('observed main');
    expect(sandboxRes.ok).toBe(true);
    expect(sandboxRes.data?.rev).toBe(1);
  });
});
