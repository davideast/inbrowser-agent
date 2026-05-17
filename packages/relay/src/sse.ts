/**
 * Server-Sent Events helpers shared by the relay HTTP binding, the
 * reconnecting client, and the built-in providers (Gemini + OpenRouter
 * both speak SSE upstream, and so do third-party adapters that wrap
 * other LLM SSE APIs).
 *
 * Wire format on the relay → client channel:
 *   data: <JSON InferenceEvent>\n\n
 * A final `data: [DONE]\n\n` line marks end-of-stream when the job
 * reached a terminal status. A connection that closes WITHOUT `[DONE]`
 * means the tail dropped — the client should reconnect from the last
 * seq it saw.
 *
 * The leading `: stream-open\n\n` is an SSE comment (ignored by SSE
 * parsers) emitted as the first body byte so proxies that buffer
 * headers (Cloud Run, Hosting) flush them immediately rather than
 * waiting for the first model token. See PR #327 for the empirical
 * proof.
 */

/**
 * Stream-line SSE reader. Yields each `data:` line payload as a raw
 * string. Caller decides how to parse (JSON.parse, `[DONE]` sentinel).
 *
 * Splits on `\n` and accumulates a buffer across reads so a chunk
 * boundary mid-line doesn't lose data. SSE event boundaries (blank
 * lines) aren't tracked here because every format this is used
 * against (Gemini's SSE, OpenRouter's SSE, our internal relay → client
 * SSE) uses single-line `data:` events.
 */
export async function* readSseDataLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string> {
  if (!body) throw new Error('SSE response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data: ')) continue;
        yield line.slice(6);
      }
    }
    if (buf.startsWith('data: ')) yield buf.slice(6);
  } finally {
    reader.releaseLock();
  }
}

/** Serialize one event as an SSE `data:` line for the relay → client wire. */
export function encodeSseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** End-of-stream sentinel emitted only when the job is terminal. */
export const SSE_DONE_LINE = 'data: [DONE]\n\n';

/**
 * First body byte that flushes response headers through buffering
 * proxies. SSE comments (lines starting with `:`) are silently
 * ignored by every SSE client.
 */
export const SSE_STREAM_OPEN = ': stream-open\n\n';
