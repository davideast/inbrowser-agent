import type { NormalizedMessage } from '../types/chat.js';

/**
 * Convert a message list that may contain native tool-call vocabulary
 * (assistant.toolCalls, role:'tool') into a list the no-tools model
 * can read. Each native surface is projected into text envelopes that
 * match the format the system prompt instructs the model to emit.
 *
 * Tool results become `role:'user'` messages — the only non-assistant
 * role Ollama OAI compat accepts — so the model "sees" them in context
 * without role confusion.
 */
export function encodeHistory(messages: ReadonlyArray<NormalizedMessage>): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const envelopes = m.toolCalls
        .map((c) => `<tool_call name="${c.name}">${JSON.stringify(c.args)}</tool_call>`)
        .join('\n');
      out.push({ role: 'assistant', text: m.text ? `${m.text}\n${envelopes}` : envelopes });
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        text: `<tool_result name="${m.name ?? ''}">${m.resultJson ?? ''}</tool_result>`,
      });
      continue;
    }
    out.push(m);
  }
  return out;
}
