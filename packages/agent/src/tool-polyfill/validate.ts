import type { ToolDeclaration } from '../types/llm.js';

export type CoerceResult = { ok: true; args: unknown } | { ok: false; error: string };

/**
 * Coerce raw string args from a tool-call envelope into a structured object.
 *
 * Coercion ladder (ordered by frequency observed in Gemma/Phi-3 probes):
 *   1. Valid JSON object → use as-is
 *   2. key=value or key: value lines → parse to flat object
 *   3. Single bare value for a single-param tool → {[paramName]: value}
 *   4. Anything else → { ok: false }
 */
export function coerceArgs(raw: string, tool: ToolDeclaration): CoerceResult {
  const trimmed = raw.trim();

  // 1. Valid JSON object
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, args: parsed };
      }
    } catch {
      // fall through to coercion
    }
  }

  // 2. key=value or key: value lines
  const lines = trimmed.split('\n').filter(Boolean);
  if (lines.length > 0 && lines.every((l) => /^\s*[^=:\s][^=:]*\s*[=:]\s*.+$/.test(l))) {
    const obj: Record<string, unknown> = {};
    for (const line of lines) {
      const m = line.match(/^\s*([^=:]+?)\s*[=:]\s*(.+)$/);
      if (!m) return { ok: false, error: `unparseable key-value line: ${line}` };
      const key = m[1]!.trim();
      const val = m[2]!.trim();
      try {
        obj[key] = JSON.parse(val);
      } catch {
        obj[key] = val;
      }
    }
    if (Object.keys(obj).length > 0) return { ok: true, args: obj };
  }

  // 3. Single bare value for a single-parameter tool
  const params = tool.parameters as {
    properties?: Record<string, unknown>;
  } | null | undefined;
  if (params?.properties) {
    const keys = Object.keys(params.properties);
    if (keys.length === 1 && trimmed && !trimmed.includes('\n')) {
      return { ok: true, args: { [keys[0]!]: trimmed } };
    }
  }

  return {
    ok: false,
    error: `cannot parse args for tool "${tool.name}": ${trimmed.slice(0, 100)}`,
  };
}
