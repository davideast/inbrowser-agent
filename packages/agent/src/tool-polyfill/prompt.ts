import type { ToolDeclaration } from '../types/llm.js';

/**
 * Tight system-prompt addendum tuned for Gemma 4.
 *
 * Empirical probe data (plans/tool-use-polyfill.md) showed:
 *   - Gemma 3 1B (small): better with loose prompt — tight caused refusals
 *   - Phi-3 mini / Qwen 3 4B (medium-large): better with tight prompt + JSON examples
 *
 * Gemma 4 is in the medium-large class, so we default to the tight style:
 * list the tools, show the exact envelope format, give one concrete example.
 */
export function buildGemma4SystemPrompt(tools: ReadonlyArray<ToolDeclaration>): string {
  const toolsJson = JSON.stringify(
    tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    null,
    2,
  );

  const exampleTool = tools[0];
  const exampleArgs = buildExampleArgs(exampleTool);
  const exampleName = exampleTool?.name ?? 'tool_name';

  return [
    'You have access to the following tools:',
    '',
    '```json',
    toolsJson,
    '```',
    '',
    'When you need to call a tool, emit EXACTLY this format on its own line and nothing else:',
    `<tool_call name="${exampleName}">${exampleArgs}</tool_call>`,
    '',
    'Rules:',
    '- The content inside the tag MUST be a valid JSON object.',
    '- Do NOT use key=value syntax, parentheses, or prose arguments.',
    '- Call at most one tool per response.',
    '- If no tool is needed, answer normally without emitting any tool_call tag.',
  ].join('\n');
}

function buildExampleArgs(tool: ToolDeclaration | undefined): string {
  if (!tool) return '{"arg": "value"}';
  const params = tool.parameters as {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  } | null | undefined;
  if (!params?.properties) return '{}';
  const example: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(params.properties)) {
    const type = (schema as { type?: string }).type;
    example[key] =
      type === 'number' || type === 'integer'
        ? 0
        : type === 'boolean'
          ? true
          : `<${key}>`;
  }
  return JSON.stringify(example);
}
