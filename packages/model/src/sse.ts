/**
 * SSE reader shared by the cloud providers. Gemini, OpenRouter, and
 * Ollama all stream `data:`-prefixed SSE upstream; each provider parses
 * the raw line payloads itself (JSON.parse + a `[DONE]` sentinel). The
 * relay's *outbound* SSE wire helpers (`encodeSseEvent`, `SSE_DONE_LINE`,
 * `SSE_STREAM_OPEN`) are a transport concern and stay in
 * `@inbrowser/relay`.
 */

/**
 * Stream-line SSE reader. Yields each `data:` line payload as a raw
 * string. Caller decides how to parse (JSON.parse, `[DONE]` sentinel).
 *
 * Splits on `\n` and accumulates a buffer across reads so a chunk
 * boundary mid-line doesn't lose data. SSE event boundaries (blank
 * lines) aren't tracked here because every format this is used against
 * (Gemini's SSE, OpenRouter's SSE, Ollama's OAI-compatible SSE) uses
 * single-line `data:` events.
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
