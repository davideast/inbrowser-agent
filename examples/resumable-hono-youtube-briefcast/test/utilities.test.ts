import { describe, expect, it } from 'bun:test';
import { extractWriteupMetadata, reduceBriefcastEvents } from '../src/shared/reducer';
import type { BriefcastEvent } from '../src/shared/types';
import { combineWavFiles, pcmToWav, splitWriteupForTts } from '../src/shared/tts';

describe('splitWriteupForTts', () => {
  it('respects paragraph boundaries and max section size', () => {
    const sections = splitWriteupForTts(
      [
        'Intro paragraph with a useful setup.',
        'Second paragraph with the main point.',
        'Third paragraph that should fit by itself.',
      ].join('\n\n'),
      70,
    );

    expect(sections).toEqual([
      'Intro paragraph with a useful setup.',
      'Second paragraph with the main point.',
      'Third paragraph that should fit by itself.',
    ]);
    expect(sections.every((section) => section.length <= 70)).toBe(true);
  });
});

describe('pcmToWav', () => {
  it('writes a valid WAV header', () => {
    const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]));
    const text = new TextDecoder().decode(wav);
    expect(text.slice(0, 4)).toBe('RIFF');
    expect(text.slice(8, 12)).toBe('WAVE');
    expect(text.slice(36, 40)).toBe('data');
    expect(wav.byteLength).toBe(48);
  });

  it('combines compatible WAV files into one WAV', () => {
    const first = pcmToWav(new Uint8Array([1, 2]));
    const second = pcmToWav(new Uint8Array([3, 4]));
    const combined = combineWavFiles([first, second]);
    const text = new TextDecoder().decode(combined);

    expect(text.slice(0, 4)).toBe('RIFF');
    expect(text.slice(8, 12)).toBe('WAVE');
    expect(combined.byteLength).toBe(48);
    expect([...combined.slice(44)]).toEqual([1, 2, 3, 4]);
  });
});

describe('reduceBriefcastEvents', () => {
  it('builds a view from stored and live events', () => {
    const events: BriefcastEvent[] = [
      {
        kind: 'accepted',
        jobId: 'job1',
        url: 'https://youtube.com/watch?v=abc123',
        createdAt: 100,
      },
      {
        kind: 'transcript_segment',
        index: 0,
        startMs: 0,
        durationMs: 2000,
        text: 'Hello world',
      },
      { kind: 'writeup_started', model: 'gemini-3.1-flash-lite' },
      { kind: 'writeup_chunk', chunk: 'A useful summary.' },
      {
        kind: 'tts_segment_ready',
        index: 0,
        text: 'A useful summary.',
        audioUrl: '/audio/job1/0.wav',
        mimeType: 'audio/wav',
        elapsedMs: 3000,
      },
      {
        kind: 'combined_audio_ready',
        audioUrl: '/audio/job1/combined.wav',
        mimeType: 'audio/wav',
        segmentCount: 1,
        elapsedMs: 3200,
      },
    ];

    const view = reduceBriefcastEvents('job1', events, {
      terminalStatus: 'running',
    });

    expect(view.nextSeq).toBe(6);
    expect(view.transcriptText).toBe('Hello world');
    expect(view.writeupMarkdown).toBe('A useful summary.');
    expect(view.audioSegments).toHaveLength(1);
    expect(view.combinedAudioUrl).toBe('/audio/job1/combined.wav');
    expect(view.status).toBe('narrating');
  });

  it('promotes generated write-up metadata over URL placeholders', () => {
    const events: BriefcastEvent[] = [
      {
        kind: 'accepted',
        jobId: 'job1',
        url: 'https://youtube.com/watch?v=DWcqbPm_Rn4',
        createdAt: 100,
      },
      {
        kind: 'writeup_ready',
        markdown: [
          '# Briefcast: The Case Against Markdown',
          '',
          '### Summary',
          'This video critiques Markdown as a format that started simple but became overloaded with incompatible extensions.',
          '',
          '### Key Points',
          '- Formal specs matter.',
        ].join('\n'),
        outputChars: 220,
        elapsedMs: 1000,
      },
    ];

    const view = reduceBriefcastEvents('job1', events, {
      index: {
        jobId: 'job1',
        url: 'https://youtube.com/watch?v=DWcqbPm_Rn4',
        title: 'YouTube video DWcqbPm_Rn4',
        status: 'ready',
        createdAt: 100,
        updatedAt: 200,
      },
      terminalStatus: 'done',
    });

    expect(view.title).toBe('The Case Against Markdown');
    expect(view.description?.startsWith('This video critiques Markdown')).toBe(true);
  });
});

describe('extractWriteupMetadata', () => {
  it('extracts a clean title and summary description', () => {
    const metadata = extractWriteupMetadata(
      [
        '# Briefcast: Practical TypeScript API Design',
        '',
        '### Summary',
        'The video explains how small API design choices affect maintainability.',
      ].join('\n'),
    );

    expect(metadata.title).toBe('Practical TypeScript API Design');
    expect(metadata.description).toBe(
      'The video explains how small API design choices affect maintainability.',
    );
  });
});
