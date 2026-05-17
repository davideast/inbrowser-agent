export function splitWriteupForTts(
  markdown: string,
  maxChars = 1500,
): string[] {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const sections: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) {
        sections.push(current);
        current = '';
      }
      sections.push(...splitLongParagraph(paragraph, maxChars));
      continue;
    }

    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxChars) {
      if (current) sections.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }

  if (current) sections.push(current);
  return sections;
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+|\S[\s\S]*$/g) ?? [paragraph];
  const sections: string[] = [];
  let current = '';

  for (const sentence of sentences.map((s) => s.trim()).filter(Boolean)) {
    if (sentence.length > maxChars) {
      if (current) {
        sections.push(current);
        current = '';
      }
      for (let i = 0; i < sentence.length; i += maxChars) {
        sections.push(sentence.slice(i, i + maxChars).trim());
      }
      continue;
    }

    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > maxChars) {
      if (current) sections.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current) sections.push(current);
  return sections;
}

export function pcmToWav(
  pcm: Uint8Array,
  opts: {
    channels?: number;
    sampleRate?: number;
    bitsPerSample?: number;
  } = {},
): Uint8Array {
  const channels = opts.channels ?? 1;
  const sampleRate = opts.sampleRate ?? 24000;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(out, 8, 'WAVE');
  writeAscii(out, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(out, 36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

export function combineWavFiles(wavs: Uint8Array[]): Uint8Array {
  if (wavs.length === 0) return pcmToWav(new Uint8Array());

  const parsed = wavs.map(parseWav);
  const first = parsed[0]!;
  for (const wav of parsed.slice(1)) {
    if (
      wav.channels !== first.channels ||
      wav.sampleRate !== first.sampleRate ||
      wav.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error('Cannot combine WAV files with different audio formats');
    }
  }

  const byteLength = parsed.reduce((total, wav) => total + wav.data.byteLength, 0);
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const wav of parsed) {
    combined.set(wav.data, offset);
    offset += wav.data.byteLength;
  }

  return pcmToWav(combined, {
    channels: first.channels,
    sampleRate: first.sampleRate,
    bitsPerSample: first.bitsPerSample,
  });
}

function parseWav(wav: Uint8Array): {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Uint8Array;
} {
  if (
    wav.byteLength < 44 ||
    ascii(wav, 0, 4) !== 'RIFF' ||
    ascii(wav, 8, 4) !== 'WAVE'
  ) {
    throw new Error('Invalid WAV file');
  }

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Uint8Array | null = null;

  while (offset + 8 <= wav.byteLength) {
    const chunkId = ascii(wav, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > wav.byteLength) throw new Error('Invalid WAV chunk size');

    if (chunkId === 'fmt ') {
      const format = view.getUint16(chunkStart, true);
      if (format !== 1) throw new Error('Only PCM WAV files can be combined');
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);
    } else if (chunkId === 'data') {
      data = wav.slice(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!channels || !sampleRate || !bitsPerSample || !data) {
    throw new Error('Missing WAV format or data chunk');
  }

  return { channels, sampleRate, bitsPerSample, data };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function writeAscii(out: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    out[offset + i] = text.charCodeAt(i);
  }
}
