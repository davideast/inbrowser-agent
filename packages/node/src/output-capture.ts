// Bounded tail retention for a host process handle's convenience captures.
// Pure: no browser, Worker or memfs dependency, so it runs in the unit tier.
//
// The retained bytes are the single source of both `ContainerProcess.stdout`
// (the chunk array, mutated in place) and `stdoutText` (decoded on demand), so
// the two can never disagree and no second copy of the output is kept.

const CONTINUATION_MASK = 0xc0;
const CONTINUATION = 0x80;
// A UTF-8 sequence has at most three continuation bytes.
const MAX_CONTINUATION_RUN = 3;

export class TailCapture {
  /** Retained byte chunks, oldest first. Mutated in place; never reassigned. */
  readonly chunks: Uint8Array[] = [];
  private retained = 0;
  private dropped = 0;
  private cached: { complete: boolean; value: string } | undefined;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('The capture limit must be a positive safe integer');
  }

  /** Bytes discarded from the front so far, 0 while the capture is complete. */
  get truncatedBytes(): number {
    return this.dropped;
  }

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.retained += bytes.byteLength;
    this.cached = undefined;
    if (this.retained <= this.limit) return;
    this.dropFront(this.retained - this.limit);
    // The cut may fall inside a multibyte character; drop its remaining bytes so
    // the retained text never begins with a fragment. Counted as dropped.
    for (let run = 0; run < MAX_CONTINUATION_RUN; run++) {
      const first = this.chunks[0]?.[0];
      if (first === undefined || (first & CONTINUATION_MASK) !== CONTINUATION) break;
      this.dropFront(1);
    }
  }

  /**
   * The retained bytes as text. While the stream is still open (`complete`
   * false) an incomplete trailing sequence is withheld until its remaining bytes
   * arrive, as a streaming decoder does; once complete it is flushed. A leading
   * byte-order mark is stripped only from untruncated output, where it is the
   * start of the real stream.
   */
  text(complete: boolean): string {
    if (this.cached?.complete === complete) return this.cached.value;
    const joined = new Uint8Array(this.retained);
    let offset = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoder = new TextDecoder('utf-8', { ignoreBOM: this.dropped > 0 });
    const value = decoder.decode(joined, { stream: !complete });
    this.cached = { complete, value };
    return value;
  }

  private dropFront(count: number): void {
    let remaining = count;
    this.dropped += count;
    this.retained -= count;
    while (remaining > 0) {
      const first = this.chunks[0];
      // retained >= count by construction, so a chunk exists while bytes remain.
      if (first === undefined) return;
      if (first.byteLength <= remaining) {
        remaining -= first.byteLength;
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(remaining);
        remaining = 0;
      }
    }
  }
}
