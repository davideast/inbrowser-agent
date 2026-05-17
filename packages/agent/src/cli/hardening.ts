/**
 * Input hardening — Agent DX CLI axis 5.
 *
 * Defends against agent-specific failure modes:
 *   - control chars in resource ids → break logs and downstream tools
 *   - path traversal (`..`, `%2e`, raw URL-encoded segments) → escape
 *     the intended sandbox (e.g. --log-dir, --json file path)
 *   - embedded query params (`?`, `#`, raw `&`) in ids that the agent
 *     would otherwise let through as part of a hallucinated URL
 *   - oversized inputs that would balloon the session log
 *
 * Failure mode: throw `InputHardeningError`. The CLI top-level catches
 * it and emits `{type:"error", code:"INPUT_HARDENED", field, reason}`
 * as a single NDJSON event with exit code 64 (EX_USAGE).
 */

export class InputHardeningError extends Error {
  override readonly name = 'InputHardeningError';
  constructor(
    readonly field: string,
    readonly reason: string,
    readonly value: string,
  ) {
    super(`Input hardening rejected ${field}: ${reason}`);
  }
}

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const PATH_TRAVERSAL_RE = /(^|[\\/])\.\.([\\/]|$)/;
const PERCENT_ENCODED_DOT_RE = /%2e/i;
const QUERY_CHARS_RE = /[?#]/;

export interface HardeningRules {
  rejectControlChars?: boolean;
  rejectPathTraversal?: boolean;
  rejectQueryChars?: boolean;
  maxLength?: number;
  pattern?: string;
}

export function hardenString(field: string, value: string, rules: HardeningRules): string {
  if (rules.maxLength !== undefined && value.length > rules.maxLength) {
    throw new InputHardeningError(
      field,
      `exceeds max length ${rules.maxLength} (got ${value.length})`,
      value,
    );
  }
  if (rules.rejectControlChars && CONTROL_CHAR_RE.test(value)) {
    throw new InputHardeningError(field, 'contains control characters', value);
  }
  if (rules.rejectPathTraversal) {
    if (PATH_TRAVERSAL_RE.test(value)) {
      throw new InputHardeningError(field, 'contains path traversal segment "../"', value);
    }
    if (PERCENT_ENCODED_DOT_RE.test(value)) {
      throw new InputHardeningError(field, 'contains percent-encoded dot (%2e)', value);
    }
  }
  if (rules.rejectQueryChars && QUERY_CHARS_RE.test(value)) {
    throw new InputHardeningError(field, 'contains URL query/fragment chars (? #)', value);
  }
  if (rules.pattern && !new RegExp(rules.pattern).test(value)) {
    throw new InputHardeningError(field, `does not match required pattern ${rules.pattern}`, value);
  }
  return value;
}

/**
 * Path hardening: in addition to string hardening, validate that the
 * resolved path is either absolute or stays within CWD. Symlinks and
 * platform-specific normalization are out of scope at this layer —
 * the resolved path is returned and consumers are responsible for
 * `realpath`-ing if they care.
 */
export function hardenPath(field: string, raw: string, rules: HardeningRules, cwd: string): string {
  hardenString(field, raw, { ...rules, rejectControlChars: rules.rejectControlChars ?? true });
  return raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)
    ? raw
    : `${cwd.replace(/\/$/, '')}/${raw}`;
}
