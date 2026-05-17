/**
 * Scripted LLM fixtures + fake sandbox used by the headless CLI. Real
 * provider wiring lives in the host (the playground UI). These live
 * here so `agent run` and `agent fleet` can run end-to-end without
 * any API credentials.
 */

import type { ChatEvent, LlmClient, SandboxHandle, ToolHandler } from '../index.js';

export type ScenarioId = 'echo' | 'write-rules';

export function scriptedLlm(scenario: ScenarioId, marker = ''): LlmClient {
  let callCount = 0;
  return {
    id: `fixture-${scenario}`,
    supportsTools: true,
    chat(req): AsyncIterable<ChatEvent> {
      const turn = callCount++;
      return (async function* () {
        if (scenario === 'write-rules') {
          if (turn === 0) {
            yield { kind: 'thinking', chunk: 'Planning a minimal owner-only rule.\n' };
            yield {
              kind: 'tool_call',
              id: `c1${marker ? `-${marker}` : ''}`,
              name: 'writeRules',
              args: {
                source:
                  `// ${marker || 'default'} rules\nrules_version='2';\nservice cloud.firestore {\n  match /{path=**} {\n    allow read, write: if request.auth != null;\n  }\n}\n`,
              },
            };
            yield {
              kind: 'turn_complete',
              usage: { promptTokens: 200, completionTokens: 50 },
              details: { requestedModel: 'fixture-1' },
            };
            return;
          }
          yield { kind: 'text', chunk: 'Rules deployed. Read/write is gated on request.auth.' };
          yield {
            kind: 'turn_complete',
            usage: { promptTokens: 250, completionTokens: 12 },
            details: { requestedModel: 'fixture-1' },
          };
          return;
        }
        // echo — scan backward for the latest user message.
        let userMsg = req.messages[req.messages.length - 1];
        for (let i = req.messages.length - 1; i >= 0; i--) {
          const m = req.messages[i];
          if (m?.role === 'user') {
            userMsg = m;
            break;
          }
        }
        const text = `[echo] ${userMsg?.text ?? '(no input)'}`;
        for (const word of text.split(' ')) {
          yield { kind: 'text', chunk: word + ' ' };
        }
        yield {
          kind: 'turn_complete',
          usage: { promptTokens: 12, completionTokens: text.split(' ').length },
          details: { requestedModel: 'fixture-1' },
        };
      })();
    },
  };
}

export function fakeSandbox(): SandboxHandle {
  return {
    async run() {
      return { ok: true, durationMs: 0, docsTouched: 0, errors: 0, entries: [] };
    },
    async deployRules() {
      return { ok: true, messages: [] };
    },
    async readState() {
      return {};
    },
    reseed() {},
    dispose() {},
  };
}

export const writeRulesTool: ToolHandler<{ source: string }> = {
  name: 'writeRules',
  description: 'Write the Firestore rules source.',
  parameters: {
    type: 'object',
    properties: { source: { type: 'string', description: 'Rules text' } },
    required: ['source'],
  },
  async execute({ source }) {
    return {
      ok: true,
      summary: `wrote ${source.length} chars of rules`,
      data: { source },
      workspacePatch: { rules: source },
    };
  },
};

export const writeCodeTool: ToolHandler<{ code: string }> = {
  name: 'writeCode',
  description: 'Write the JS code source.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
  },
  async execute({ code }) {
    return { ok: true, summary: `wrote ${code.length} chars of code`, workspacePatch: { code } };
  },
};
