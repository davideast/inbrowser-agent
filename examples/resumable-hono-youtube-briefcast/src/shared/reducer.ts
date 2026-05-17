import type { BriefcastEvent, BriefcastIndexEntry, BriefcastStatus, BriefcastView } from './types';

export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const videoId = parsed.searchParams.get('v');
    if (videoId) return `YouTube video ${videoId}`;
    const path = parsed.pathname.split('/').filter(Boolean).at(-1);
    return path ? `YouTube video ${path}` : parsed.hostname;
  } catch {
    return 'Untitled briefcast';
  }
}

export function createEmptyBriefcastView(
  jobId: string,
  url = '',
  createdAt = Date.now(),
): BriefcastView {
  return {
    jobId,
    url,
    title: url ? titleFromUrl(url) : 'Untitled briefcast',
    status: 'queued',
    createdAt,
    updatedAt: createdAt,
    transcriptSegments: [],
    transcriptText: '',
    writeupMarkdown: '',
    audioSegments: [],
    nextSeq: 0,
  };
}

export function reduceBriefcastEvent(view: BriefcastView, event: BriefcastEvent): BriefcastView {
  const updatedAt = Date.now();

  switch (event.kind) {
    case 'accepted':
      return {
        ...view,
        jobId: event.jobId,
        url: event.url,
        title: titleFromUrl(event.url),
        status: 'fetching_transcript',
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
    case 'transcript_segment': {
      const transcriptSegments = [...view.transcriptSegments, event].sort(
        (a, b) => a.index - b.index,
      );
      return {
        ...view,
        status: 'fetching_transcript',
        updatedAt,
        transcriptSegments,
        transcriptText: transcriptSegments.map((segment) => segment.text).join(' '),
      };
    }
    case 'transcript_ready':
      return {
        ...view,
        status: 'writing',
        updatedAt,
      };
    case 'writeup_started':
      return {
        ...view,
        status: 'writing',
        textModel: event.model,
        updatedAt,
      };
    case 'writeup_chunk':
      return {
        ...view,
        status: 'writing',
        writeupMarkdown: view.writeupMarkdown + event.chunk,
        updatedAt,
      };
    case 'writeup_ready':
      const metadata = extractWriteupMetadata(event.markdown);
      return {
        ...view,
        ...metadata,
        status: 'narrating',
        writeupMarkdown: event.markdown,
        updatedAt,
      };
    case 'tts_started':
      return {
        ...view,
        status: 'narrating',
        ttsModel: event.model,
        ttsSectionCount: event.sectionCount,
        updatedAt,
      };
    case 'tts_segment_started':
      return {
        ...view,
        status: 'narrating',
        updatedAt,
      };
    case 'tts_segment_ready': {
      const audioSegments = [
        ...view.audioSegments.filter((segment) => segment.index !== event.index),
        {
          index: event.index,
          text: event.text,
          audioUrl: event.audioUrl,
          mimeType: event.mimeType,
          elapsedMs: event.elapsedMs,
        },
      ].sort((a, b) => a.index - b.index);
      return {
        ...view,
        status: 'narrating',
        updatedAt,
        audioSegments,
      };
    }
    case 'combined_audio_ready':
      return {
        ...view,
        status: 'narrating',
        updatedAt,
        audioSegmentCount: event.segmentCount,
        combinedAudioUrl: event.audioUrl,
        combinedAudioMimeType: event.mimeType,
      };
    case 'ready':
      return {
        ...view,
        status: 'ready',
        audioSegmentCount: event.audioSegmentCount,
        readyElapsedMs: event.elapsedMs,
        updatedAt,
      };
    case 'error':
      return {
        ...view,
        status: 'error',
        error: event.message,
        updatedAt,
      };
  }
}

export function reduceBriefcastEvents(
  jobId: string,
  events: BriefcastEvent[],
  opts: {
    index?: BriefcastIndexEntry | null;
    terminalStatus?: BriefcastView['terminalStatus'];
    terminalReason?: string;
  } = {},
): BriefcastView {
  const firstAccepted = events.find(
    (event): event is Extract<BriefcastEvent, { kind: 'accepted' }> => event.kind === 'accepted',
  );
  let view = createEmptyBriefcastView(
    jobId,
    opts.index?.url ?? firstAccepted?.url ?? '',
    opts.index?.createdAt ?? firstAccepted?.createdAt ?? Date.now(),
  );

  for (const event of events) {
    view = reduceBriefcastEvent(view, event);
  }

  const nextSeq = events.length;
  const indexTitleIsPlaceholder =
    opts.index?.title === undefined || opts.index.title === titleFromUrl(opts.index.url);
  return {
    ...view,
    title: indexTitleIsPlaceholder ? view.title : opts.index!.title,
    description: view.description ?? opts.index?.description,
    status: statusWithIndex(view.status, opts.index?.status),
    updatedAt: opts.index?.updatedAt ?? view.updatedAt,
    terminalStatus: opts.terminalStatus,
    terminalReason: opts.terminalReason,
    nextSeq,
  };
}

function statusWithIndex(
  eventStatus: BriefcastStatus,
  indexStatus: BriefcastStatus | undefined,
): BriefcastStatus {
  if (eventStatus === 'error' || eventStatus === 'ready') return eventStatus;
  return indexStatus ?? eventStatus;
}

export function applyEventToIndex(
  entry: BriefcastIndexEntry,
  event: BriefcastEvent,
  now = Date.now(),
): BriefcastIndexEntry {
  switch (event.kind) {
    case 'accepted':
      return {
        ...entry,
        url: event.url,
        title: titleFromUrl(event.url),
        status: 'fetching_transcript',
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
    case 'transcript_segment':
      return {
        ...entry,
        status: 'fetching_transcript',
        transcriptSegmentCount: Math.max(entry.transcriptSegmentCount ?? 0, event.index + 1),
        updatedAt: now,
      };
    case 'transcript_ready':
    case 'writeup_started':
    case 'writeup_chunk':
      return {
        ...entry,
        status: 'writing',
        updatedAt: now,
      };
    case 'writeup_ready':
      const metadata = extractWriteupMetadata(event.markdown);
      return {
        ...entry,
        ...metadata,
        status: 'narrating',
        writeupChars: event.outputChars,
        updatedAt: now,
      };
    case 'tts_started':
    case 'tts_segment_started':
      return {
        ...entry,
        status: 'narrating',
        updatedAt: now,
      };
    case 'tts_segment_ready':
      return {
        ...entry,
        status: 'narrating',
        audioSegmentCount: Math.max(entry.audioSegmentCount ?? 0, event.index + 1),
        updatedAt: now,
      };
    case 'combined_audio_ready':
      return {
        ...entry,
        status: 'narrating',
        audioSegmentCount: event.segmentCount,
        updatedAt: now,
      };
    case 'ready':
      return {
        ...entry,
        status: 'ready',
        audioSegmentCount: event.audioSegmentCount,
        updatedAt: now,
      };
    case 'error':
      return {
        ...entry,
        status: 'error',
        error: event.message,
        updatedAt: now,
      };
  }
}

export function extractWriteupMetadata(
  markdown: string,
): Pick<BriefcastView, 'title' | 'description'> {
  return {
    title: extractTitle(markdown),
    description: extractDescription(markdown),
  };
}

function extractTitle(markdown: string): string {
  const heading = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#\s+/.test(line));
  if (!heading) return 'Generated briefcast';
  return cleanupTitle(heading.replace(/^#\s+/, ''));
}

function cleanupTitle(title: string): string {
  return (
    title
      .replace(/^\s*briefcast\s*:\s*/i, '')
      .replace(/\*\*/g, '')
      .trim() || 'Generated briefcast'
  );
}

function extractDescription(markdown: string): string | undefined {
  const summaryStart = markdown.search(/^#{2,4}\s+summary\s*$/im);
  const source =
    summaryStart >= 0
      ? markdown.slice(summaryStart).replace(/^#{2,4}\s+summary\s*$/im, '')
      : markdown;
  const paragraph = source
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#{1,6}\s+.*/gm, '').trim())
    .find((part) => part.length > 0 && !part.startsWith('- ') && !part.startsWith('* '));
  if (!paragraph) return undefined;
  return oneLine(paragraph).slice(0, 240);
}

function oneLine(value: string): string {
  return value.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}
