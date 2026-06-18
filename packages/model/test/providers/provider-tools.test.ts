import { describe, expect, it } from 'bun:test';
import type { ModelRequest, ToolSpec } from '../../src/contract';
import { toAnthropicTools } from '../../src/providers/anthropic';
import { buildGeminiRequest } from '../../src/providers/gemini';
import { toOaiTools as ollamaTools } from '../../src/providers/ollama';
import { toOaiTools as openrouterTools } from '../../src/providers/openrouter';

// The unified ModelClient contract carries tools in the nested OAI `ToolSpec`
// shape ({ type:'function', function:{ name, description, parameters } }). Each
// provider translates that to its own wire format. These assert the translation,
// which the ModelClient migration changed (relay's old tool shape was flat) and
// which nothing else exercises — every other provider test runs with `tools: []`.

const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description: 'Search the documentation',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'the query' } },
        required: ['query'],
      },
    },
  },
];

const OAI_EXPECTED = [
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description: 'Search the documentation',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'the query' } },
        required: ['query'],
      },
    },
  },
];

describe('provider tool-wire encoding (nested ToolSpec)', () => {
  it('openrouter: nested OAI tools', () => {
    expect(openrouterTools(TOOLS)).toEqual(OAI_EXPECTED);
  });

  it('ollama: nested OAI tools', () => {
    expect(ollamaTools(TOOLS)).toEqual(OAI_EXPECTED);
  });

  it('anthropic: name/description/input_schema (undefined when empty)', () => {
    expect(toAnthropicTools(TOOLS)).toEqual([
      {
        name: 'search_docs',
        description: 'Search the documentation',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'the query' } },
          required: ['query'],
        },
      },
    ]);
    expect(toAnthropicTools([])).toBeUndefined();
  });

  it('gemini: functionDeclarations from the nested ToolSpec', async () => {
    const req: ModelRequest = {
      messages: [{ role: 'user', text: 'hi' }],
      tools: TOOLS,
      toolUseEnabled: true,
    };
    const body = JSON.parse(
      await buildGeminiRequest({ apiKey: 'sk-test', model: 'gemini-3.5-flash' }, req).text(),
    ) as {
      tools?: {
        functionDeclarations: { name: string; description: string; parameters: unknown }[];
      }[];
    };
    const decls = body.tools?.[0]?.functionDeclarations;
    expect(decls?.[0]?.name).toBe('search_docs');
    expect(decls?.[0]?.description).toBe('Search the documentation');
    // parameters survive sanitizeGeminiSchema (basic JSON-schema is preserved).
    expect(decls?.[0]?.parameters).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
    });
  });
});
