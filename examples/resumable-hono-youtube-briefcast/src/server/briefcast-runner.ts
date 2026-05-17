import { combineWavFiles, pcmToWav, splitWriteupForTts } from '../shared/tts';
import type { BriefcastEvent, TranscriptSegmentView } from '../shared/types';

export interface BriefcastRunnerServices {
  fetchTranscript(url: string): Promise<TranscriptSegmentView[]>;
  streamWriteup(input: {
    url: string;
    transcriptText: string;
    segments: TranscriptSegmentView[];
  }): AsyncIterable<string>;
  synthesizeSpeech(text: string): Promise<Uint8Array>;
  saveAudio(jobId: string, index: number, wav: Uint8Array): Promise<string>;
  saveCombinedAudio(jobId: string, wav: Uint8Array): Promise<string>;
  textModel: string;
  ttsModel: string;
  now?: () => number;
  ttsConcurrency?: number;
}

export function createBriefcastRunner(
  services: BriefcastRunnerServices,
): (jobId: string, url: string) => AsyncGenerator<BriefcastEvent> {
  return async function* runBriefcast(jobId: string, url: string) {
    const now = services.now ?? Date.now;
    const startedAt = now();
    yield { kind: 'accepted', jobId, url, createdAt: startedAt };

    let transcript: TranscriptSegmentView[];
    try {
      transcript = await services.fetchTranscript(url);
    } catch (e) {
      yield { kind: 'error', message: errorMessage('Transcript fetch failed', e) };
      return;
    }

    for (const segment of transcript) {
      yield { kind: 'transcript_segment', ...segment };
    }

    const transcriptText = transcript.map((segment) => segment.text).join(' ');
    yield {
      kind: 'transcript_ready',
      segmentCount: transcript.length,
      textChars: transcriptText.length,
    };

    yield { kind: 'writeup_started', model: services.textModel };

    let markdown = '';
    try {
      for await (const chunk of services.streamWriteup({
        url,
        transcriptText,
        segments: transcript,
      })) {
        markdown += chunk;
        yield { kind: 'writeup_chunk', chunk };
      }
    } catch (e) {
      yield { kind: 'error', message: errorMessage('Gemini write-up failed', e) };
      return;
    }

    yield {
      kind: 'writeup_ready',
      markdown,
      outputChars: markdown.length,
      elapsedMs: now() - startedAt,
    };

    const sections = splitWriteupForTts(markdown);
    yield {
      kind: 'tts_started',
      model: services.ttsModel,
      sectionCount: sections.length,
    };

    try {
      for await (const event of synthesizeSections({
        jobId,
        sections,
        services,
        startedAt,
        now,
        concurrency: services.ttsConcurrency ?? 2,
      })) {
        yield event;
      }
    } catch (e) {
      yield { kind: 'error', message: errorMessage('Gemini TTS failed', e) };
      return;
    }

    yield {
      kind: 'ready',
      jobId,
      audioSegmentCount: sections.length,
      elapsedMs: now() - startedAt,
    };
  };
}

async function* synthesizeSections(opts: {
  jobId: string;
  sections: string[];
  services: BriefcastRunnerServices;
  startedAt: number;
  now: () => number;
  concurrency: number;
}): AsyncGenerator<BriefcastEvent> {
  const inFlight = new Map<
    number,
    Promise<{
      index: number;
      text: string;
      wav: Uint8Array;
      audioUrl: string;
      elapsedMs: number;
    }>
  >();
  const completed = new Map<
    number,
    {
      index: number;
      text: string;
      wav: Uint8Array;
      audioUrl: string;
      elapsedMs: number;
    }
  >();
  const wavs: Uint8Array[] = [];
  let nextToStart = 0;
  let nextToEmit = 0;

  const start = (index: number): void => {
    const text = opts.sections[index]!;
    inFlight.set(
      index,
      (async () => {
        const pcm = await opts.services.synthesizeSpeech(text);
        const wav = pcmToWav(pcm);
        const audioUrl = await opts.services.saveAudio(opts.jobId, index, wav);
        return {
          index,
          text,
          wav,
          audioUrl,
          elapsedMs: opts.now() - opts.startedAt,
        };
      })(),
    );
  };

  while (nextToStart < opts.sections.length && inFlight.size < Math.max(1, opts.concurrency)) {
    yield {
      kind: 'tts_segment_started',
      index: nextToStart,
      textChars: opts.sections[nextToStart]!.length,
    };
    start(nextToStart++);
  }

  while (nextToEmit < opts.sections.length) {
    if (!completed.has(nextToEmit)) {
      const finished = await Promise.race(inFlight.values());
      inFlight.delete(finished.index);
      completed.set(finished.index, finished);
    }

    while (completed.has(nextToEmit)) {
      const finished = completed.get(nextToEmit)!;
      completed.delete(nextToEmit);
      yield {
        kind: 'tts_segment_ready',
        index: finished.index,
        text: finished.text,
        audioUrl: finished.audioUrl,
        mimeType: 'audio/wav',
        elapsedMs: finished.elapsedMs,
      };
      wavs[finished.index] = finished.wav;
      nextToEmit++;

      if (nextToStart < opts.sections.length) {
        yield {
          kind: 'tts_segment_started',
          index: nextToStart,
          textChars: opts.sections[nextToStart]!.length,
        };
        start(nextToStart++);
      }
    }
  }

  const combined = combineWavFiles(wavs);
  const audioUrl = await opts.services.saveCombinedAudio(opts.jobId, combined);
  yield {
    kind: 'combined_audio_ready',
    audioUrl,
    mimeType: 'audio/wav',
    segmentCount: opts.sections.length,
    elapsedMs: opts.now() - opts.startedAt,
  };
}

function errorMessage(prefix: string, e: unknown): string {
  return `${prefix}: ${e instanceof Error ? e.message : String(e)}`;
}
