/**
 * Parallel-safe stub tools with a configurable delay. Registering N of
 * these and giving the strategy a tool-using stub LLM that calls all
 * of them in one turn lets the parallel-dispatch test observe the
 * predicted wall-clock effect: sequential mode pays ~N×delay, parallel
 * mode pays ~delay.
 */

import type { ToolHandler, ToolRegistry } from '../../../src/index.js';

export interface DelayedToolOptions {
  name: string;
  delayMs: number;
  parallelSafe?: boolean;
}

export function createDelayedTool(options: DelayedToolOptions): ToolHandler {
  return {
    name: options.name,
    description: `Delayed stub tool (${options.delayMs}ms)`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    parallelSafe: options.parallelSafe ?? true,
    async execute(args, _ctx) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return {
        ok: true,
        summary: `${options.name} completed`,
        data: { input: args },
      };
    },
  };
}

export function registerDelayedTools(
  registry: ToolRegistry,
  count: number,
  delayMs = 30,
): ToolHandler[] {
  const handlers: ToolHandler[] = [];
  for (let i = 0; i < count; i++) {
    const handler = createDelayedTool({ name: `stub-delayed-${i}`, delayMs });
    registry.register(handler);
    handlers.push(handler);
  }
  return handlers;
}
