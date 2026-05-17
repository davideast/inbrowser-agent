import type {
  BriefcastHealthResponse,
  BriefcastListResponse,
  BriefcastSnapshotResponse,
  BriefcastStartResponse,
} from '../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchBriefcasts(): Promise<BriefcastListResponse> {
  const res = await fetch('/api/briefcasts');
  if (!res.ok) throw await apiError(res, `List failed: ${res.status}`);
  return (await res.json()) as BriefcastListResponse;
}

export async function fetchHealth(): Promise<BriefcastHealthResponse> {
  const res = await fetch('/api/health');
  if (!res.ok) throw await apiError(res, `Health failed: ${res.status}`);
  return (await res.json()) as BriefcastHealthResponse;
}

export async function fetchBriefcast(
  jobId: string,
): Promise<BriefcastSnapshotResponse> {
  const res = await fetch(`/api/briefcasts/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    throw await apiError(res, `Briefcast fetch failed: ${res.status}`);
  }
  return (await res.json()) as BriefcastSnapshotResponse;
}

export async function startBriefcast(url: string): Promise<BriefcastStartResponse> {
  const res = await fetch('/api/briefcasts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    throw await apiError(res, `Start failed: ${res.status}`);
  }
  return (await res.json()) as BriefcastStartResponse;
}

async function apiError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(body?.error ?? fallback, res.status);
}
