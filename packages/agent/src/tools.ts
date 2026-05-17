/**
 * `ToolRegistry` + `ToolDispatch` runtime implementations.
 *
 * The interfaces ship in slice 1 (`./types/tools.ts`). This module
 * provides:
 *
 *   - `createToolRegistry()` — the basic in-memory registry.
 *   - `createDispatch(registry)` — stateless executor that looks up
 *     by name and invokes the handler with the supplied `ToolContext`.
 *
 * Both are pure-TS — no React, no stores, no localStorage.
 */

import type { Capabilities } from './types/capabilities.js';
import type {
  ToolCall,
  ToolContext,
  ToolDispatch,
  ToolHandler,
  ToolRegistry,
  ToolResult,
} from './types/tools.js';

export function createToolRegistry(): ToolRegistry {
  const handlers = new Map<string, ToolHandler>();

  function clone(): Map<string, ToolHandler> {
    return new Map(handlers);
  }

  function makeFromMap(map: Map<string, ToolHandler>): ToolRegistry {
    return {
      register(handler) {
        const existing = map.get(handler.name);
        if (existing) {
          // Include both descriptions when available so the
          // composer can spot which two factories shipped the
          // same tool name without spelunking through stack
          // traces.
          const existingDesc = truncate(existing.description ?? '', 80);
          const newDesc = truncate(handler.description ?? '', 80);
          throw new Error(
            `ToolRegistry: tool '${handler.name}' is already registered.\n` +
              `  Previously registered: ${existingDesc || '(no description)'}\n` +
              `  New registration:      ${newDesc || '(no description)'}\n` +
              `  Use \`registry.replace(handler)\` if this overlay is intentional.`,
          );
        }
        map.set(handler.name, handler);
      },
      replace(handler) {
        map.set(handler.name, handler);
      },
      unregister(name) {
        return map.delete(name);
      },
      list(opts) {
        // No capability filter → return every registered handler.
        // With a capability filter → drop handlers whose `available`
        // hook returns false. Handlers without an `available` hook
        // always pass.
        const out: ToolHandler[] = [];
        if (opts?.capabilities === undefined) {
          for (const h of map.values()) out.push(h);
          return out;
        }
        const caps: Capabilities = opts.capabilities;
        for (const h of map.values()) {
          if (h.available && !h.available(caps)) continue;
          out.push(h);
        }
        return out;
      },
      has(name) {
        return map.has(name);
      },
      fork() {
        // Fresh map cloning the current snapshot; later registrations
        // on the forked registry don't affect the parent.
        return makeFromMap(new Map(map));
      },
    };
  }

  return makeFromMap(handlers);
}

/**
 * Create a stateless dispatcher over a registry. The dispatcher
 * holds a reference to the registry — list/register/unregister calls
 * on the registry are seen by the dispatcher on the next `execute`.
 *
 * Error shape: handlers that throw turn into `{ ok: false, summary:
 * <message> }` results so the caller's `for await` loop doesn't have
 * to wrap every tool invocation in a try/catch. The thrown value is
 * stringified into the summary.
 */
export function createDispatch(registry: ToolRegistry): ToolDispatch {
  return {
    async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
      // We look up via the underlying `list` to avoid exposing a
      // public `get(name)` on the registry — `list()` already enforces
      // capability filtering, but for `execute` we should run any
      // registered handler the caller has on file regardless of
      // capability (the caller's job to gate before calling).
      const candidate = findByName(registry, call.name);
      if (!candidate) {
        return {
          ok: false,
          summary: `Unknown tool: ${call.name}`,
        };
      }
      try {
        const args = call.args as never;
        return await candidate.execute(args, ctx);
      } catch (e) {
        return {
          ok: false,
          summary: `Tool ${call.name} threw: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

/**
 * Find a handler by name without exposing a `get` method on the
 * registry interface. Public consumers always go through `list()`;
 * the dispatcher (a friend of the registry) uses this internal
 * lookup.
 */
function findByName(registry: ToolRegistry, name: string): ToolHandler | undefined {
  if (!registry.has(name)) return undefined;
  // The registry doesn't expose a `get`; list() with no capability
  // filter returns every handler — find by name from there.
  const all = registry.list();
  return all.find((h) => h.name === name);
}

/** Trim a string to `max` chars with an ellipsis marker. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
