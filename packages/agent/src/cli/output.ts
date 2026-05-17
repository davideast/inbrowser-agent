/**
 * Output layer — Agent DX axes 1 (machine-readable) + 4 (context window
 * discipline). Three modes:
 *
 *   - `ndjson` — one JSON object per line, flushed as it's emitted.
 *     Default when stdout is not a TTY. Streams paginated/long
 *     results.
 *   - `json` — single buffered JSON object at the end (for describe /
 *     schema / one-shot help).
 *   - `text` — human-readable, ANSI-styled. Default in a TTY.
 *
 * Field filtering via `--fields` applies to ndjson and json. Field
 * names are matched literally against the top-level keys of the
 * emitted object. Unmatched fields are dropped silently.
 */

import type { WriteStream } from 'node:tty';

export type OutputMode = 'ndjson' | 'json' | 'text';

export interface OutputOptions {
  mode: OutputMode;
  /** Allowlist of top-level fields to include in ndjson/json output. */
  fields?: readonly string[];
  /** Disable ANSI styling. Auto-true when not a TTY. */
  noColor?: boolean;
}

export interface Emitter {
  readonly mode: OutputMode;
  /** Emit one event (NDJSON line) or buffer it (JSON). Pass `text` for plain text mode. */
  event(obj: Record<string, unknown>, plain?: () => string): void;
  /** Flush buffered output. For ndjson + text this is a no-op. */
  finish(): void;
}

function projectFields(obj: Record<string, unknown>, fields?: readonly string[]): Record<string, unknown> {
  if (!fields || fields.length === 0) return obj;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
  }
  return out;
}

export function pickMode(
  preferred: OutputMode | undefined,
  stream: NodeJS.WriteStream | WriteStream,
): OutputMode {
  if (preferred) return preferred;
  return stream.isTTY ? 'text' : 'ndjson';
}

export function createEmitter(opts: OutputOptions, stream: NodeJS.WriteStream = process.stdout): Emitter {
  const fields = opts.fields;
  if (opts.mode === 'ndjson') {
    return {
      mode: 'ndjson',
      event(obj) {
        stream.write(JSON.stringify(projectFields(obj, fields)) + '\n');
      },
      finish() {},
    };
  }
  if (opts.mode === 'json') {
    const buf: Record<string, unknown>[] = [];
    return {
      mode: 'json',
      event(obj) {
        buf.push(projectFields(obj, fields));
      },
      finish() {
        // Emit a single object when there's exactly one event (describe / schema /
        // help shapes). Otherwise emit an array — preserves stream-like callers
        // that only buffered for terminal output.
        const payload = buf.length === 1 ? buf[0] : buf;
        stream.write(JSON.stringify(payload, null, 2) + '\n');
      },
    };
  }
  // text — ignore fields, prefer the `plain()` thunk if provided.
  return {
    mode: 'text',
    event(obj, plain) {
      if (plain) {
        stream.write(plain() + '\n');
      } else {
        stream.write(JSON.stringify(obj) + '\n');
      }
    },
    finish() {},
  };
}

/** Convenience: bundle an Error into a structured event. */
export function errorEvent(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      type: 'error',
      ts: new Date().toISOString(),
      name: err.name,
      message: err.message,
    };
    // Surface our own fields (InputHardeningError carries field/reason).
    for (const k of Object.keys(err)) {
      if (k === 'message' || k === 'stack' || k === 'name') continue;
      out[k] = (err as unknown as Record<string, unknown>)[k];
    }
    return out;
  }
  return {
    type: 'error',
    ts: new Date().toISOString(),
    message: String(err),
  };
}
