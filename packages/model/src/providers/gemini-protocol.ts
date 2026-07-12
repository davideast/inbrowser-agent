import type { ModelErrorEvent, ReasoningEffort, ToolSpec } from '../contract.js';

const GEMINI_25_THINKING_BUDGET: Record<Exclude<ReasoningEffort, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

export type GeminiThinkingSelection =
  | { kind: 'level'; effort: Exclude<ReasoningEffort, 'off'> }
  | { kind: 'budget'; budget: number }
  | { kind: 'generic' };

/** Select the family-specific Gemini thinking control without choosing a wire format. */
export function selectGeminiThinking(
  model: string,
  effort: ReasoningEffort | undefined,
): GeminiThinkingSelection | undefined {
  if (!effort || effort === 'off') return undefined;

  const normalized = model.toLowerCase();
  if (normalized.includes('gemini-3')) return { kind: 'level', effort };
  if (normalized.includes('gemini-2.5-')) {
    return { kind: 'budget', budget: GEMINI_25_THINKING_BUDGET[effort] };
  }
  return { kind: 'generic' };
}

export interface GeminiNoOutputState {
  finishReason: string | undefined;
  sawThinking: boolean;
  sawVisibleText: boolean;
  sawFunctionCall: boolean;
}

/** Classify Gemini's transport-independent clean-stream/no-visible-output cases. */
export function geminiNoOutputError(
  providerName: string,
  codePrefix: string,
  state: GeminiNoOutputState,
): ModelErrorEvent {
  const finishReason = state.finishReason ?? 'none';
  let code = `${codePrefix}.no_output`;
  let retryable = false;
  if (state.finishReason === undefined) {
    code = `${codePrefix}.truncated_no_output`;
    retryable = true;
  } else if (state.finishReason === 'MALFORMED_FUNCTION_CALL') {
    code = `${codePrefix}.malformed_function_call`;
    retryable = true;
  } else if (state.finishReason === 'STOP' && state.sawThinking) {
    code = `${codePrefix}.thinking_only_stop`;
    retryable = true;
  }

  return {
    kind: 'error',
    message: `${providerName} produced no output — finishReason=${finishReason} (${
      state.sawThinking
        ? 'response ended after thinking only'
        : 'response ended with no visible output'
    })`,
    code,
    retryable,
    details: {
      finishReason,
      sawThinking: state.sawThinking,
      sawVisibleText: state.sawVisibleText,
      sawFunctionCall: state.sawFunctionCall,
    },
  };
}

export interface SanitizeGeminiSchemaOptions {
  /** Reject semantic/structural keywords Firebase documents as unsupported. */
  rejectUnsupported?: boolean;
}

export class UnsupportedGeminiSchemaError extends TypeError {
  readonly keyword: string;
  readonly path: string;

  constructor(keyword: string, path: string) {
    super(`Unsupported Gemini function schema keyword "${keyword}" at ${path}`);
    this.name = 'UnsupportedGeminiSchemaError';
    this.keyword = keyword;
    this.path = path;
  }
}

const STRIP_SCHEMA_KEYS = new Set([
  'additionalProperties',
  '$schema',
  '$ref',
  '$defs',
  'definitions',
]);
const FIREBASE_STRIP_SCHEMA_KEYS = new Set(['default']);
const REJECT_SCHEMA_KEYS = new Set([
  '$ref',
  'optional',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'oneOf',
  'allOf',
  'not',
]);

/**
 * Deep-clone a tool schema while removing JSON-Schema-only metadata Gemini
 * rejects. Firebase callers can opt into clear failures for its documented
 * unsupported semantic keywords instead of receiving a remote 400.
 */
export function sanitizeGeminiSchema(
  node: unknown,
  options: SanitizeGeminiSchemaOptions = {},
): unknown {
  return sanitizeGeminiSchemaNode(node, options, '$');
}

function sanitizeGeminiSchemaNode(
  node: unknown,
  options: SanitizeGeminiSchemaOptions,
  path: string,
): unknown {
  if (Array.isArray(node)) {
    return node.map((value, index) =>
      sanitizeGeminiSchemaNode(value, options, `${path}[${index}]`),
    );
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && isRecord(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value).map(([propertyName, propertySchema]) => [
            propertyName,
            sanitizeGeminiSchemaNode(propertySchema, options, `${path}.properties.${propertyName}`),
          ]),
        );
        continue;
      }
      if (options.rejectUnsupported && REJECT_SCHEMA_KEYS.has(key)) {
        throw new UnsupportedGeminiSchemaError(key, `${path}.${key}`);
      }
      if (
        STRIP_SCHEMA_KEYS.has(key) ||
        (options.rejectUnsupported && FIREBASE_STRIP_SCHEMA_KEYS.has(key))
      ) {
        continue;
      }
      out[key] = sanitizeGeminiSchemaNode(value, options, `${path}.${key}`);
    }
    return out;
  }
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function toGeminiFunctionDeclarations(
  tools: ToolSpec[],
  options: SanitizeGeminiSchemaOptions = {},
): unknown[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: sanitizeGeminiSchema(tool.function.parameters, options),
  }));
}

export function parseJsonValue(value: string | undefined): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
