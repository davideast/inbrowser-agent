/**
 * Scripted LLM fixtures + fake sandbox used by the headless CLI. Real
 * provider wiring lives in the host (the playground UI). These live
 * here so `agent run` and `agent fleet` can run end-to-end without
 * any API credentials.
 */

import type { ModelClient, ModelEvent, SandboxHandle, ToolHandler } from '../index.js';

export type ScenarioId = 'echo' | 'write-rules';

export function scriptedLlm(scenario: ScenarioId, marker = ''): ModelClient {
  let callCount = 0;
  return {
    id: `fixture-${scenario}`,
    supportsTools: true,
    chat(req): AsyncIterable<ModelEvent> {
      const turn = callCount++;
      return (async function* () {
        if (scenario === 'write-rules') {
          if (turn === 0) {
            yield { kind: 'thinking', text: 'Planning a minimal owner-only rule.\n' };
            yield {
              kind: 'tool_call',
              id: `c1${marker ? `-${marker}` : ''}`,
              name: 'writeRules',
              args: {
                source: `// ${marker || 'default'} rules\nrules_version='2';\nservice cloud.firestore {\n  match /{path=**} {\n    allow read, write: if request.auth != null;\n  }\n}\n`,
              },
            };
            yield { kind: 'usage', usage: { promptTokens: 200, outputTokens: 50 } };
            return;
          }
          yield { kind: 'text', text: 'Rules deployed. Read/write is gated on request.auth.' };
          yield { kind: 'usage', usage: { promptTokens: 250, outputTokens: 12 } };
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
          yield { kind: 'text', text: word + ' ' };
        }
        yield {
          kind: 'usage',
          usage: { promptTokens: 12, outputTokens: text.split(' ').length },
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
