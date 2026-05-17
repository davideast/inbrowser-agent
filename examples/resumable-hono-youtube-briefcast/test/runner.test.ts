import { describe, expect, it } from 'bun:test';
import { createBriefcastRunner } from '../src/server/briefcast-runner';
import type { BriefcastEvent } from '../src/shared/types';

describe('createBriefcastRunner', () => {
  it('emits TTS ready events in index order even when workers finish out of order', async () => {
    const saved: string[] = [];
    const runner = createBriefcastRunner({
      textModel: 'text-model',
      ttsModel: 'tts-model',
      ttsConcurrency: 2,
      fetchTranscript: async () => [
        { index: 0, startMs: 0, durationMs: 1000, text: 'Transcript' },
      ],
      async *streamWriteup() {
        yield [
          `First ${'a'.repeat(1000)}`,
          `Second ${'b'.repeat(1000)}`,
          `Third ${'c'.repeat(1000)}`,
        ].join('\n\n');
      },
      async synthesizeSpeech(text) {
        if (text.startsWith('First')) await sleep(20);
        if (text.startsWith('Second')) await sleep(5);
        return new Uint8Array([1, 2, 3, text.length]);
      },
      async saveAudio(_jobId, index) {
        const url = `/audio/job/${index}.wav`;
        saved.push(url);
        return url;
      },
      async saveCombinedAudio() {
        const url = '/audio/job/combined.wav';
        saved.push(url);
        return url;
      },
      now: () => 1000,
    });

    const events: BriefcastEvent[] = [];
    for await (const event of runner('job', 'https://youtube.com/watch?v=x')) {
      events.push(event);
    }

    const readyIndexes = events
      .filter(
        (event): event is Extract<BriefcastEvent, { kind: 'tts_segment_ready' }> =>
          event.kind === 'tts_segment_ready',
      )
      .map((event) => event.index);

    expect(readyIndexes).toEqual([0, 1, 2]);
    expect(saved).toEqual([
      '/audio/job/1.wav',
      '/audio/job/0.wav',
      '/audio/job/2.wav',
      '/audio/job/combined.wav',
    ]);
    expect(events.some((event) => event.kind === 'combined_audio_ready')).toBe(true);
  });

  it('turns transcript failures into an error event', async () => {
    const runner = createBriefcastRunner({
      textModel: 'text-model',
      ttsModel: 'tts-model',
      fetchTranscript: async () => {
        throw new Error('captions unavailable');
      },
      async *streamWriteup() {},
      synthesizeSpeech: async () => new Uint8Array(),
      saveAudio: async () => '',
      saveCombinedAudio: async () => '',
    });

    const events: BriefcastEvent[] = [];
    for await (const event of runner('job', 'https://youtube.com/watch?v=x')) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      kind: 'error',
      message: 'Transcript fetch failed: captions unavailable',
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
