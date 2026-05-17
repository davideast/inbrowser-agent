import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  fetchBriefcast,
  fetchBriefcasts,
  fetchHealth,
  startBriefcast,
} from './api';
import {
  createEmptyBriefcastView,
  reduceBriefcastEvent,
} from '../shared/reducer';
import { Markdown } from './Markdown';
import type {
  AudioSegmentView,
  BriefcastEvent,
  BriefcastHealthResponse,
  BriefcastIndexEntry,
  BriefcastStatus,
  BriefcastView,
} from '../shared/types';
import './styles.css';

const SELECTED_KEY = 'briefcast:selected';

export function App() {
  const [items, setItems] = useState<BriefcastIndexEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState(() =>
    typeof localStorage === 'undefined' ? '' : localStorage.getItem(SELECTED_KEY) ?? '',
  );
  const [briefcast, setBriefcast] = useState<BriefcastView | null>(null);
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [health, setHealth] = useState<BriefcastHealthResponse | null>(null);

  const clearLocalState = () => {
    localStorage.removeItem(SELECTED_KEY);
    setSelectedId('');
    setBriefcast(null);
    setListError('');
    setDetailError('');
  };

  useEffect(() => {
    let alive = true;
    fetchHealth()
      .then((result) => {
        if (alive) setHealth(result);
      })
      .catch(() => {
        if (alive) setHealth(null);
      });
    fetchBriefcasts()
      .then((result) => {
        if (!alive) return;
        setItems(result.items);
        setListError('');
        setSelectedId((current) => {
          if (!current) return result.items[0]?.jobId ?? '';
          const stillExists = result.items.some((item) => item.jobId === current);
          if (stillExists) return current;
          localStorage.removeItem(SELECTED_KEY);
          return result.items[0]?.jobId ?? '';
        });
      })
      .catch((e) => {
        if (alive) setListError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      localStorage.removeItem(SELECTED_KEY);
      setBriefcast(null);
      return;
    }
    localStorage.setItem(SELECTED_KEY, selectedId);
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentNextSeq = 0;
    let alive = true;

    fetchBriefcast(selectedId)
      .then(({ briefcast }) => {
        if (!alive) return;
        setBriefcast(briefcast);
        setDetailError('');
        currentNextSeq = briefcast.nextSeq;
        if (briefcast.terminalStatus === 'running') {
          const connect = (from: number): EventSource =>
            subscribeToBriefcast(
              briefcast.jobId,
              from,
              (event, nextSeq) => {
                currentNextSeq = nextSeq;
                setBriefcast((current) => {
                  const base =
                    current ?? createEmptyBriefcastView(briefcast.jobId, briefcast.url);
                  const next = reduceBriefcastEvent(base, event);
                  return { ...next, nextSeq, terminalStatus: 'running' };
                });
              },
              () => {
                void refreshList(setItems, setListError);
              },
              (message) => {
                setDetailError(message);
                if (!alive) return;
                reconnectTimer = setTimeout(() => {
                  if (!alive) return;
                  source = connect(currentNextSeq);
                }, 600);
              },
            );
          source = connect(currentNextSeq);
        }
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) {
          localStorage.removeItem(SELECTED_KEY);
          setSelectedId('');
          setBriefcast(null);
          setDetailError(
            'Saved briefcast selection was not found in the current store. Local selection was cleared.',
          );
          return;
        }
        setDetailError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [selectedId]);

  useEffect(() => {
    if (!briefcast) return;
    setItems((current) => updateListFromBriefcast(current, briefcast));
  }, [briefcast]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setDetailError('');
    try {
      const { jobId } = await startBriefcast(trimmed);
      const createdAt = Date.now();
      setItems((current) => [
        {
          jobId,
          url: trimmed,
          title: 'New briefcast',
          status: 'queued',
          createdAt,
          updatedAt: createdAt,
        },
        ...(current ?? []),
      ]);
      setBriefcast(createEmptyBriefcastView(jobId, trimmed, createdAt));
      setSelectedId(jobId);
      setUrl('');
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Briefcasts</h1>
          <button type="button" className="clear-button" onClick={clearLocalState}>
            Clear
          </button>
        </div>
        <form className="new-form" onSubmit={onSubmit}>
          <label htmlFor="url">New briefcast</label>
          <div className="submit-row">
            <input
              id="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://youtube.com/watch?v=..."
            />
            <button type="submit" disabled={submitting}>
              {submitting ? 'Starting' : 'Start'}
            </button>
          </div>
        </form>
        {health && !health.durable ? (
          <p className="notice" title={health.fallbackReason}>
            Memory storage is active. Briefcasts reset when the server restarts.
          </p>
        ) : null}
        {listError ? <p className="error">{listError}</p> : null}
        <BriefcastList
          items={items}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </aside>
      <section className="detail">
        {detailError ? <p className="error detail-error">{detailError}</p> : null}
        <BriefcastDetail briefcast={briefcast} />
      </section>
    </main>
  );
}

export function BriefcastList(props: {
  items: BriefcastIndexEntry[] | null;
  selectedId: string;
  onSelect: (jobId: string) => void;
}) {
  if (!props.items) {
    return (
      <div className="briefcast-list">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  if (props.items.length === 0) {
    return <p className="muted empty-list">No briefcasts yet.</p>;
  }

  return (
    <div className="briefcast-list">
      {props.items.map((item) => (
        <button
          key={item.jobId}
          type="button"
          className={item.jobId === props.selectedId ? 'list-item selected' : 'list-item'}
          onClick={() => props.onSelect(item.jobId)}
        >
          <span className="item-title">{item.title}</span>
          {item.description ? (
            <span className="item-description">{item.description}</span>
          ) : null}
          <span className={`badge ${item.status}`}>{statusLabel(item.status)}</span>
        </button>
      ))}
    </div>
  );
}

export function BriefcastDetail({ briefcast }: { briefcast: BriefcastView | null }) {
  if (!briefcast) {
    return (
      <div className="empty-state">
        <h2>Select or create a briefcast</h2>
        <p>Generated audio and text will appear here as the job runs.</p>
      </div>
    );
  }

  const hasCombinedAudio = Boolean(briefcast.combinedAudioUrl);
  const hasAudio = hasCombinedAudio || briefcast.audioSegments.length > 0;
  const hasWriteup = briefcast.writeupMarkdown.length > 0;
  const hasTranscript = briefcast.transcriptSegments.length > 0;

  return (
    <article className="briefcast-detail">
      <header className="detail-header">
        <div>
          <p className="eyebrow">{statusLabel(briefcast.status)}</p>
          <h2>{briefcast.title}</h2>
          <a href={briefcast.url} target="_blank" rel="noreferrer">
            {briefcast.url}
          </a>
          {briefcast.description ? (
            <p className="detail-description">{briefcast.description}</p>
          ) : null}
        </div>
        <span className={`badge ${briefcast.status}`}>
          {statusLabel(briefcast.status)}
        </span>
      </header>
      {briefcast.error ? (
        <p className="error">Briefcast stopped: {briefcast.error}</p>
      ) : null}

      <section className="player-section">
        {briefcast.combinedAudioUrl ? (
          <audio className="combined-player" controls src={briefcast.combinedAudioUrl} />
        ) : hasAudio ? (
          <SegmentedAudioPlayer segments={briefcast.audioSegments} />
        ) : (
          <AudioSkeleton active={briefcast.status === 'narrating'} />
        )}
      </section>

      <section className="writeup-section">
        <h3>Briefcast text</h3>
        {hasWriteup ? (
          <Markdown source={briefcast.writeupMarkdown} />
        ) : (
          <TextSkeleton />
        )}
      </section>

      <details className="transcript-section">
        <summary>Transcript</summary>
        {hasTranscript ? (
          <div className="transcript-list">
            {briefcast.transcriptSegments.map((segment) => (
              <p key={segment.index}>
                <time>{formatTime(segment.startMs)}</time>
                <span>{segment.text}</span>
              </p>
            ))}
          </div>
        ) : (
          <TextSkeleton compact />
        )}
      </details>
    </article>
  );
}

function SegmentedAudioPlayer({ segments }: { segments: AudioSegmentView[] }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const active = useMemo(
    () => segments.find((segment) => segment.index === activeIndex) ?? segments[0],
    [activeIndex, segments],
  );

  useEffect(() => {
    if (!active) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
  }, [active]);

  if (!active) return null;

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        controls
        src={active.audioUrl}
        onEnded={() => {
          const next = segments.find((segment) => segment.index === active.index + 1);
          if (next) setActiveIndex(next.index);
        }}
      />
      <div className="segment-strip">
        {segments.map((segment) => (
          <button
            key={segment.index}
            type="button"
            className={segment.index === active.index ? 'segment active' : 'segment'}
            onClick={() => setActiveIndex(segment.index)}
            title={segment.text}
          >
            {segment.index + 1}
          </button>
        ))}
      </div>
    </div>
  );
}

function AudioSkeleton({ active }: { active: boolean }) {
  return (
    <div className="audio-skeleton" aria-label="Audio loading">
      <div className="play-dot" />
      <div className={active ? 'wave active' : 'wave'}>
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function TextSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'text-skeleton compact' : 'text-skeleton'}>
      <span />
      <span />
      <span />
      {!compact ? <span /> : null}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="skeleton-row">
      <span />
      <span />
    </div>
  );
}

function subscribeToBriefcast(
  jobId: string,
  from: number,
  onEvent: (event: BriefcastEvent, nextSeq: number) => void,
  onDone: () => void,
  onError: (message: string) => void,
): EventSource {
  const source = new EventSource(
    `/api/briefcasts/${encodeURIComponent(jobId)}/stream?from=${from}`,
  );
  source.onmessage = (message) => {
    if (message.data === '[DONE]') {
      source.close();
      onDone();
      return;
    }
    const event = JSON.parse(message.data) as BriefcastEvent;
    const seq = Number.parseInt(message.lastEventId, 10);
    onEvent(event, Number.isFinite(seq) ? seq + 1 : from + 1);
  };
  source.onerror = () => {
    onError('Stream connection dropped. Refreshing will resume from the log.');
    source.close();
  };
  return source;
}

async function refreshList(
  setItems: (items: BriefcastIndexEntry[]) => void,
  setError: (message: string) => void,
) {
  try {
    const result = await fetchBriefcasts();
    setItems(result.items);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}

function updateListFromBriefcast(
  items: BriefcastIndexEntry[] | null,
  briefcast: BriefcastView,
): BriefcastIndexEntry[] | null {
  if (!items) return items;
  return items.map((item) =>
    item.jobId === briefcast.jobId
      ? {
          ...item,
          status: briefcast.status,
          title: briefcast.title,
          description: briefcast.description,
          updatedAt: briefcast.updatedAt,
          error: briefcast.error,
          audioSegmentCount: briefcast.audioSegments.length,
          transcriptSegmentCount: briefcast.transcriptSegments.length,
          writeupChars: briefcast.writeupMarkdown.length,
        }
      : item,
  );
}

function statusLabel(status: BriefcastStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'fetching_transcript':
      return 'Fetching transcript';
    case 'writing':
      return 'Writing';
    case 'narrating':
      return 'Narrating';
    case 'ready':
      return 'Ready';
    case 'error':
      return 'Error';
  }
}

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
