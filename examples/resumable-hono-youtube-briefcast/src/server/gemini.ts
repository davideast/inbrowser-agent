import { GoogleGenAI } from '@google/genai';
import { type NormalizedRequest, geminiProvider } from '@inbrowser/relay';
import { YoutubeTranscript } from 'youtube-transcript';
import type { TranscriptSegmentView } from '../shared/types';
import type { AudioStore } from './audio-store';
import type { BriefcastRunnerServices } from './briefcast-runner';

export interface GeminiBriefcastServiceOpts {
  apiKey: string;
  textModel: string;
  ttsModel: string;
  ttsVoice: string;
  audioStore: AudioStore;
}

export function createGeminiBriefcastServices(
  opts: GeminiBriefcastServiceOpts,
): BriefcastRunnerServices {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });

  return {
    textModel: opts.textModel,
    ttsModel: opts.ttsModel,

    async fetchTranscript(url) {
      const transcript = await YoutubeTranscript.fetchTranscript(url);
      return transcript.map((part, index) => ({
        index,
        startMs: Number(part.offset ?? 0),
        durationMs: Number(part.duration ?? 0),
        text: cleanTranscriptText(part.text),
      }));
    },

    async *streamWriteup(input) {
      const req: NormalizedRequest = {
        provider: 'gemini',
        model: opts.textModel,
        apiKey: opts.apiKey,
        messages: [
          {
            role: 'user',
            text: buildWriteupPrompt(input.url, input.segments, input.transcriptText),
          },
        ],
        tools: [],
      };

      for await (const event of geminiProvider(req)) {
        if (event.kind === 'text') yield event.chunk;
        if (event.kind === 'error') throw new Error(event.message);
      }
    },

    async synthesizeSpeech(text) {
      const response = await ai.models.generateContent({
        model: opts.ttsModel,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  'Read this briefcast section in a calm, clear narrator voice.',
                  'Use a steady pace and make headings sound natural.',
                  '',
                  text,
                ].join('\n'),
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: opts.ttsVoice,
              },
            },
          },
        },
      });

      const base64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64) throw new Error('Gemini TTS returned no audio data');
      return new Uint8Array(Buffer.from(base64, 'base64'));
    },

    saveAudio: opts.audioStore.save,
    saveCombinedAudio: (jobId, wav) => opts.audioStore.saveFile(jobId, 'combined.wav', wav),
  };
}

function buildWriteupPrompt(
  url: string,
  segments: TranscriptSegmentView[],
  transcriptText: string,
): string {
  const timestampHints = segments
    .filter((segment) => segment.index % 8 === 0)
    .slice(0, 20)
    .map((segment) => `- ${formatTimestamp(segment.startMs)}: ${segment.text}`)
    .join('\n');

  return `
You are creating a "briefcast" from a YouTube transcript.

Source URL:
${url}

Write a detailed, useful briefing in Markdown. Include:
- a concise, specific H1 title that describes the video, not the URL or video id
- a two-paragraph summary
- key points with timestamps when useful
- practical takeaways
- a final short narrated recap section

Timestamp hints:
${timestampHints}

Transcript:
${transcriptText}
  `.trim();
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function cleanTranscriptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
