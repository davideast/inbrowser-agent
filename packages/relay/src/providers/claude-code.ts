import type { InferenceEvent, InferenceProvider, NormalizedRequest } from '../types.js';
import { renderPrompt } from './claude-cli.js';

/**
 * Claude Code SDK provider — calls `query()` from
 * `@anthropic-ai/claude-agent-sdk` configured as a bare model call,
 * authenticated against the user's Claude Code login (subscription)
 * rather than an API key.
 *
 * Why this exists, distinct from `anthropicProvider` and
 * `claude-cli`:
 *
 *   - `anthropicProvider` is the BYOK `/v1/messages` path — per-token
 *     billing against an API key.
 *   - `claude-cli` shells out to the `claude` CLI subprocess.
 *   - this provider talks to the same Agent SDK programmatically and
 *     uses the user's subscription credentials. No subprocess, no
 *     NDJSON parsing.
 *
 * As of mid-2026 Anthropic confirmed the Agent SDK and `claude -p`
 * still draw from the Claude Pro/Max subscription rate limits when
 * no `ANTHROPIC_API_KEY` is in the environment; the planned move to
 * a separate credit pool was deferred. If `ANTHROPIC_API_KEY` is
 * present, the SDK bills per-token — this provider deletes it from
 * the subprocess env so subscription is the only billing path.
 *
 * ## Bare-model configuration
 *
 * The SDK is Claude Code under the hood; left to its defaults it
 * would run a full coding agent (bash, file edits, MCP servers).
 * This provider pins every option that disables that behavior so it
 * answers like a plain Messages call:
 *
 *   - `tools: []`             — all built-in tools off.
 *   - `systemPrompt: <s>`     — string form replaces the default
 *                               Claude Code prompt. Empty string
 *                               when the request carries no system
 *                               message.
 *   - `settingSources: []`    — no filesystem settings, no CLAUDE.md.
 *   - `mcpServers: {}` plus
 *     `strictMcpConfig: true` — no MCP discovery from project /
 *                               plugin / agent-frontmatter sources.
 *   - `permissionMode: 'bypassPermissions'` — no interactive prompts;
 *                               with no tools this is moot but
 *                               required to suppress the prompt loop.
 *   - `includePartialMessages: true` — stream text / thinking deltas
 *                               as they arrive instead of buffering
 *                               the whole assistant turn.
 *
 * ## Auth — subscription only
 *
 * The SDK's env precedence is `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN`
 * → `~/.claude/.credentials.json` (the Claude Code login). This
 * provider removes `ANTHROPIC_API_KEY` from the subprocess env so the
 * subscription path always wins. To pin a specific OAuth token (CI,
 * multi-tenant), pass `oauthToken` to `createClaudeCodeProvider` —
 * it is forwarded to the SDK via `CLAUDE_CODE_OAUTH_TOKEN`. Otherwise
 * the host's logged-in subscription is used.
 *
 * `NormalizedRequest.apiKey` is **ignored** by this provider.
 *
 * ## Tools, temperature, knobs
 *
 *   - Caller-defined tools (`req.tools`) have no parallel in this
 *     bare-model setup. Passing any yields a typed `error` event
 *     rather than silently dropping them.
 *   - `temperature` / `topP` / `topK` are not exposed by the SDK in
 *     the bare-model configuration and are ignored.
 *   - `reasoningEffort` maps to the SDK's `effort` option: `low` /
 *     `medium` / `high` pass through; `off` (the relay's sentinel
 *     for "do not request reasoning") omits the field so the model's
 *     default applies. The SDK also accepts `xhigh` / `max` for
 *     newer Opus + Fable models — not exposed yet because the relay
 *     layer's `ReasoningEffort` union doesn't include them.
 *   - Multi-turn histories are flattened into a single transcript
 *     prompt by `renderPrompt` (shared with `claude-cli`). For a
 *     one-shot user message the text passes through verbatim.
 */

/** Subset of `@anthropic-ai/claude-agent-sdk`'s Options we set. Kept
 *  structural so we don't import the SDK at type-check time for HTTP-
 *  only consumers. */
interface SdkOptions {
  model?: string;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code' };
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  settingSources?: string[];
  mcpServers?: Record<string, unknown>;
  strictMcpConfig?: boolean;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  includePartialMessages?: boolean;
  /** SDK Options.effort. Wider than the relay's ReasoningEffort —
   *  the relay's 'off' is mapped to "omit the field" so the model's
   *  default applies; 'xhigh' / 'max' are not exposed by the relay
   *  layer yet. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
}

/** Map the relay's `reasoningEffort` onto the SDK's `effort` option.
 *  `off` is the relay's "do not request reasoning" sentinel; the SDK
 *  has no off level, so we omit the field entirely and let the
 *  model's default kick in. */
function toEffort(effort: string | undefined): SdkOptions['effort'] | undefined {
  return effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined;
}

/** Subset of the SDK's `SDKMessage` union we consume. */
interface SdkMessage {
  type: string;
  subtype?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  result?: string;
  is_error?: boolean;
}

/** Minimal shape of the SDK's exported `query` function. */
type SdkQuery = (params: {
  prompt: string;
  options?: SdkOptions;
}) => AsyncIterable<SdkMessage>;

export interface ClaudeCodeOptions {
  /**
   * Explicit OAuth token to use instead of the host's ambient
   * `~/.claude/.credentials.json`. Forwarded to the SDK via
   * `CLAUDE_CODE_OAUTH_TOKEN`. Useful for CI and multi-tenant hosts.
   */
  oauthToken?: string;
  /**
   * Override SDK module loader. Used in tests to inject a fake
   * `query` without installing the heavy peer dep. Production code
   * leaves this unset — the provider lazy-imports
   * `@anthropic-ai/claude-agent-sdk`.
   */
  loadSdk?: () => Promise<{ query: SdkQuery }>;
  /**
   * Extra environment for the SDK subprocess. Merged on top of the
   * provider's computed env. `ANTHROPIC_API_KEY` is always stripped
   * regardless of what you set here — passing it via this slot will
   * not enable per-token billing.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Build a Claude Code SDK provider. `createClaudeCodeProvider()`
 * with no options uses the host's ambient subscription credentials:
 *
 * ```ts
 * const relay = createRelay({
 *   store,
 *   providers: { 'claude-code': createClaudeCodeProvider() },
 * });
 * // client request: { provider: 'claude-code', model: 'claude-opus-4-8',
 * //                   messages, tools: [], apiKey: '' }
 * ```
 */
export function createClaudeCodeProvider(options: ClaudeCodeOptions = {}): InferenceProvider {
  const loadSdk =
    options.loadSdk ??
    (async (): Promise<{ query: SdkQuery }> => {
      const mod = (await import('@anthropic-ai/claude-agent-sdk')) as { query: SdkQuery };
      return { query: mod.query };
    });

  return async function* claudeCode(req: NormalizedRequest): AsyncIterable<InferenceEvent> {
    if (req.signal?.aborted) return;

    if (req.tools.length > 0) {
      yield {
        kind: 'error',
        message:
          'claude-code provider does not support caller-defined tools — the bare-model SDK configuration has no tool-registration surface. Send `tools: []` (or use an API provider for tool calling).',
      };
      return;
    }

    const { system, prompt } = renderPrompt(req.messages);
    if (!prompt) {
      yield { kind: 'error', message: 'claude-code provider: no user message to send.' };
      return;
    }

    let sdk: { query: SdkQuery };
    try {
      sdk = await loadSdk();
    } catch (e) {
      yield {
        kind: 'error',
        message: `claude-code: failed to load @anthropic-ai/claude-agent-sdk (install it as a peer dep): ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
      return;
    }

    // Compose the subprocess env. The SDK's auth precedence is
    // ANTHROPIC_API_KEY → CLAUDE_CODE_OAUTH_TOKEN → ~/.claude/.credentials.json.
    // We strip ANTHROPIC_API_KEY so subscription always wins; we
    // optionally inject CLAUDE_CODE_OAUTH_TOKEN for explicit-token
    // hosts.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    if (options.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
    if (options.env) Object.assign(env, options.env);
    // Belt-and-suspenders: if the caller's options.env tried to set
    // ANTHROPIC_API_KEY back, strip it again.
    delete env.ANTHROPIC_API_KEY;

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const effort = toEffort(req.reasoningEffort);
    const sdkOptions: SdkOptions = {
      ...(req.model ? { model: req.model } : {}),
      systemPrompt: system,
      tools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      permissionMode: 'bypassPermissions',
      includePartialMessages: true,
      ...(effort ? { effort } : {}),
      abortController,
      env,
    };

    let promptTokens = 0;
    let outputTokens = 0;
    let cachedTokens: number | undefined;
    let sawText = false;
    let sawResult = false;
    let fallbackText = '';

    try {
      for await (const msg of sdk.query({ prompt, options: sdkOptions })) {
        if (req.signal?.aborted) return;

        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
          const delta = msg.event.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            sawText = true;
            yield { kind: 'text', chunk: delta.text };
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            yield { kind: 'thinking', chunk: delta.thinking };
          }
          continue;
        }

        // Buffer the assistant message's full text in case partial
        // streaming wasn't honored — we fall back to it on terminal
        // result if no text deltas streamed.
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              fallbackText += block.text;
            }
          }
          continue;
        }

        if (msg.type === 'result') {
          sawResult = true;
          if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
            yield {
              kind: 'error',
              message: `claude-code SDK reported ${msg.subtype ?? 'error'}: ${
                typeof msg.result === 'string' && msg.result
                  ? msg.result.slice(0, 400)
                  : '(no detail)'
              }`,
            };
            return;
          }
          // Defensive fallback: terminal result text when no deltas
          // streamed (some SDK paths skip partial events).
          if (!sawText) {
            const text = typeof msg.result === 'string' && msg.result ? msg.result : fallbackText;
            if (text) yield { kind: 'text', chunk: text };
          }
          promptTokens = msg.usage?.input_tokens ?? promptTokens;
          outputTokens = msg.usage?.output_tokens ?? outputTokens;
          if (typeof msg.usage?.cache_read_input_tokens === 'number') {
            cachedTokens = msg.usage.cache_read_input_tokens;
          }
          yield {
            kind: 'usage',
            promptTokens,
            outputTokens,
            ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
            // costUsd intentionally omitted — subscription is N/A.
          };
          return;
        }
        // system / compact_boundary / rate_limit_event / unknown — skip.
      }
    } catch (e) {
      if (req.signal?.aborted) return;
      yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
      return;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }

    if (!sawResult) {
      yield {
        kind: 'error',
        message: 'claude-code SDK stream ended without a result message.',
      };
    }
  };
}

/** Ready-made instance with subscription-only defaults. */
export const claudeCodeProvider: InferenceProvider = createClaudeCodeProvider();
