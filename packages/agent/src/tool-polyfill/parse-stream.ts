import type { ChatEvent, ToolDeclaration } from '../types/llm.js';
import { coerceArgs } from './validate.js';

/**
 * Buffer-and-finalize tool-call parser.
 *
 * Accumulates all `text` events from the inner stream, then scans the
 * combined buffer for tool-call envelopes after the stream closes.
 * Two envelope formats are accepted regardless of which one the system
 * prompt requested (models invent alternatives):
 *
 *   1. XML tags:   <tool_call name="X">{…json…}</tool_call>
 *   2. Fenced JSON: ```json\n{"tool":"X","args":{…}}\n```
 *
 * Events are re-emitted in original text order:
 *   text-before-call → tool_call (or error) → text-after-call → turn_complete
 *
 * `thinking` and `error` events from the inner stream pass through immediately.
 */
export async function* parseToolCallStream(
  source: AsyncIterable<ChatEvent>,
  tools: ReadonlyArray<ToolDeclaration>,
  opts: { malformedArgsStrategy?: 'best-effort' | 'reject' } = {},
): AsyncIterable<ChatEvent> {
  const strategy = opts.malformedArgsStrategy ?? 'best-effort';
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  let textBuffer = '';
  let turnComplete: Extract<ChatEvent, { kind: 'turn_complete' }> | undefined;

  for await (const ev of source) {
    if (ev.kind === 'text') {
      textBuffer += ev.chunk;
      continue;
    }
    if (ev.kind === 'turn_complete') {
      turnComplete = ev;
      continue;
    }
    // thinking / error pass through immediately
    yield ev;
  }

  // Collect envelope matches with their byte positions in the buffer.
  type EnvMatch = { start: number; end: number; name: string; rawArgs: string };
  const matches: EnvMatch[] = [];

  // XML: <tool_call name="NAME">ARGS</tool_call>
  const xmlRe = /<tool_call\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = xmlRe.exec(textBuffer)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      name: m[1]!,
      rawArgs: m[2]!.trim(),
    });
  }

  // Fenced JSON: ```json\n{...}\n```
  // Accepted shapes: {"tool":"X","args":{}} or {"name":"X","args":{}}
  const fenceRe = /```json\s*\n([\s\S]*?)\n```/g;
  while ((m = fenceRe.exec(textBuffer)) !== null) {
    const inner = m[1]!.trim();
    try {
      const parsed = JSON.parse(inner) as Record<string, unknown>;
      const name =
        typeof parsed['tool'] === 'string'
          ? parsed['tool']
          : typeof parsed['name'] === 'string'
            ? parsed['name']
            : null;
      if (!name) continue;
      const argsVal = parsed['args'] ?? parsed['arguments'] ?? parsed['parameters'] ?? {};
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        name,
        rawArgs: typeof argsVal === 'string' ? argsVal : JSON.stringify(argsVal),
      });
    } catch {
      // not valid JSON — skip
    }
  }

  // Emit in source order.
  matches.sort((a, b) => a.start - b.start);

  let pos = 0;
  for (const match of matches) {
    if (match.start > pos) {
      yield { kind: 'text', chunk: textBuffer.slice(pos, match.start) };
    }
    pos = match.end;

    const tool = toolMap.get(match.name);
    if (!tool) {
      yield { kind: 'error', message: `tool_call for unknown tool "${match.name}"` };
      if (strategy === 'reject') return;
      continue;
    }

    const result = coerceArgs(match.rawArgs, tool);
    if (!result.ok) {
      yield { kind: 'error', message: result.error };
      if (strategy === 'reject') return;
      continue;
    }

    yield {
      kind: 'tool_call',
      id: `poly_${Math.random().toString(36).slice(2, 10)}`,
      name: match.name,
      args: result.args,
    };
  }

  if (pos < textBuffer.length) {
    yield { kind: 'text', chunk: textBuffer.slice(pos) };
  }

  if (turnComplete) yield turnComplete;
}
