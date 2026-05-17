export type BriefcastStatus =
  | 'queued'
  | 'fetching_transcript'
  | 'writing'
  | 'narrating'
  | 'ready'
  | 'error';

export interface TranscriptSegmentView {
  index: number;
  startMs: number;
  durationMs: number;
  text: string;
}

export interface AudioSegmentView {
  index: number;
  text: string;
  audioUrl: string;
  mimeType: 'audio/wav';
  elapsedMs: number;
}

export type BriefcastEvent =
  | { kind: 'accepted'; jobId: string; url: string; createdAt: number }
  | {
      kind: 'transcript_segment';
      index: number;
      startMs: number;
      durationMs: number;
      text: string;
    }
  | { kind: 'transcript_ready'; segmentCount: number; textChars: number }
  | { kind: 'writeup_started'; model: string }
  | { kind: 'writeup_chunk'; chunk: string }
  | {
      kind: 'writeup_ready';
      markdown: string;
      outputChars: number;
      elapsedMs: number;
    }
  | { kind: 'tts_started'; model: string; sectionCount: number }
  | { kind: 'tts_segment_started'; index: number; textChars: number }
  | {
      kind: 'tts_segment_ready';
      index: number;
      text: string;
      audioUrl: string;
      mimeType: 'audio/wav';
      elapsedMs: number;
    }
  | {
      kind: 'combined_audio_ready';
      audioUrl: string;
      mimeType: 'audio/wav';
      segmentCount: number;
      elapsedMs: number;
    }
  | { kind: 'ready'; jobId: string; audioSegmentCount: number; elapsedMs: number }
  | { kind: 'error'; message: string };

export interface BriefcastIndexEntry {
  jobId: string;
  url: string;
  title: string;
  description?: string;
  status: BriefcastStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  transcriptSegmentCount?: number;
  writeupChars?: number;
  audioSegmentCount?: number;
}

export interface BriefcastView {
  jobId: string;
  url: string;
  title: string;
  description?: string;
  status: BriefcastStatus;
  createdAt: number;
  updatedAt: number;
  transcriptSegments: TranscriptSegmentView[];
  transcriptText: string;
  writeupMarkdown: string;
  textModel?: string;
  ttsModel?: string;
  ttsSectionCount?: number;
  audioSegments: AudioSegmentView[];
  audioSegmentCount?: number;
  combinedAudioUrl?: string;
  combinedAudioMimeType?: 'audio/wav';
  error?: string;
  readyElapsedMs?: number;
  terminalStatus?: 'done' | 'error' | 'cancelled' | 'running';
  terminalReason?: string;
  nextSeq: number;
}

export interface BriefcastListResponse {
  items: BriefcastIndexEntry[];
}

export interface BriefcastHealthResponse {
  ok: true;
  storeMode: 'memory' | 'rtdb';
  durable: boolean;
  fallbackReason?: string;
  geminiConfigured: boolean;
}

export interface BriefcastStartResponse {
  jobId: string;
}

export interface BriefcastSnapshotResponse {
  briefcast: BriefcastView;
}
