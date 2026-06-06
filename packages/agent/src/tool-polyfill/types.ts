import type { ToolDeclaration } from '../types/llm.js';

export interface ToolUsePolyfillOpts {
  /** Envelope format the system prompt asks for. Default 'xml-tags'. */
  envelopeFormat?: 'xml-tags' | 'json-fence';
  /** What to do when the model replies with no tool call. Default 'allow'. */
  noToolStrategy?: 'allow' | 'retry';
  /**
   * What to do when the model emits an envelope with unparseable args.
   * Default 'best-effort': emit an inline error event and continue.
   * 'reject': emit the error event and stop the stream.
   */
  malformedArgsStrategy?: 'best-effort' | 'reject';
  /** Retry cap for noToolStrategy='retry'. Default 1. */
  maxRetries?: number;
  /**
   * Override the system-prompt addendum builder. The default is tuned
   * for Gemma 4 (tight prompt with concrete JSON examples). Consumers
   * with different models can plug in their own.
   */
  buildSystemPrompt?: (tools: ReadonlyArray<ToolDeclaration>) => string;
}
