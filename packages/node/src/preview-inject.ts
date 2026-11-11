// Streaming insertion of the preview WebSocket bridge into an HTML response.
//
// The buffered transport searched the whole document for a head start tag. A
// streamed document cannot be searched whole, so this holds only the leading
// bytes that may still precede a head tag - whitespace, a doctype, comments and
// the html start tag - and decides as soon as either a head tag is present or
// other content shows that no head tag can follow. The held prefix is bounded;
// at the bound, or at the end of the stream, it falls back to the position the
// buffered transport used: directly after the doctype, else the start.
//
// Matching is done on a one-byte-per-character view, so positions are byte
// offsets and non-ASCII content is never decoded or re-encoded.

/** Leading bytes held while the insertion point is undecided. */
export const HEAD_HOLD_BYTES = 65536;

const HEAD = /<head(?:\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;
const PRELUDE =
  /^\s*(?:<!doctype[^>]*>)?(?:\s|<!--[\s\S]*?-->)*(?:<html(?:\s[^>]*)?>)?(?:\s|<!--[\s\S]*?-->)*/i;
// Start tags and markup that may still become part of the prelude or the head tag.
const CANDIDATES = ['<!doctype', '<html', '<head'];

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export class HeadInjector {
  #parts: Uint8Array[] = [];
  #held = 0;
  #decided = false;
  readonly #script: Uint8Array;
  constructor(
    script: string,
    private readonly holdBytes = HEAD_HOLD_BYTES,
  ) {
    this.#script = new TextEncoder().encode(script);
  }
  /** Bytes currently held back from the consumer. */
  get held(): number {
    return this.#held;
  }
  /** Returns the bytes that may be delivered now, possibly none. */
  write(bytes: Uint8Array): Uint8Array[] {
    if (this.#decided) return [bytes];
    this.#parts.push(bytes);
    this.#held += bytes.length;
    return this.#decide(this.#held >= this.holdBytes);
  }
  /** Returns whatever is still held, with the script at the fallback position. */
  end(): Uint8Array[] {
    return this.#decided ? [] : this.#decide(true);
  }
  #decide(final: boolean): Uint8Array[] {
    const prefix = concat(this.#parts, this.#held);
    this.#parts = [prefix];
    // A UTF-8 byte order mark stays in front of everything, as bytes.
    const mark = prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf ? 3 : 0;
    const source = new TextDecoder('latin1').decode(prefix.subarray(mark));
    const head = HEAD.exec(source);
    let at: number;
    if (head) at = head.index + head[0].length;
    else {
      if (!final && this.#undecided(source)) return [];
      const doctype = DOCTYPE.exec(source);
      at = doctype ? doctype[0].length : 0;
    }
    at += mark;
    this.#decided = true;
    this.#parts = [];
    this.#held = 0;
    const output = new Uint8Array(prefix.length + this.#script.length);
    output.set(prefix.subarray(0, at), 0);
    output.set(this.#script, at);
    output.set(prefix.subarray(at), at + this.#script.length);
    return [output];
  }
  /** True while the bytes so far could still be followed by a head start tag. */
  #undecided(source: string): boolean {
    const rest = source.slice(PRELUDE.exec(source)?.[0].length ?? 0).toLowerCase();
    if (!rest) return true;
    // An unterminated comment, whatever it contains.
    if (rest.startsWith('<!--') || '<!--'.startsWith(rest)) return true;
    // An unterminated tag that may still turn out to be prelude or the head tag.
    if (rest.includes('>')) return false;
    return CANDIDATES.some((candidate) =>
      rest.length <= candidate.length
        ? candidate.startsWith(rest)
        : rest.startsWith(candidate) && /\s/.test(rest[candidate.length]),
    );
  }
}
