/**
 * Post-hoc truthfulness detector for agent traces.
 *
 * Walks a list of `TraceEvent`s, pairs each `llm_request` with its
 * matching `llm_response` (or derives the response text from the next
 * request's appended assistant message), extracts candidate factual
 * claims from the assistant text, and flags claims that do not appear
 * in the grounding corpus visible to the model at that moment.
 *
 * The grounding corpus is the union of the system prompt, every
 * message text in the request, and every tool result JSON in the
 * request. Verification is literal substring match — case sensitive.
 *
 * The implementation plan's phase zero calls for an intentionally
 * simple first version. False positives are acceptable. False
 * negatives (missed fabrications) are the failure mode the eval
 * harness will surface later via golden tasks.
 */

import type { NormalizedMessage } from '../types/chat.js';
import type { LlmRequestTrace, LlmResponseTrace, TraceEvent } from '../types/trace.js';

export type TruthfulnessFlagCategory = 'firestore-path' | 'quoted-identifier';

export interface TruthfulnessFlag {
  requestId: string;
  turnId: string;
  iteration: number;
  claim: string;
  category: TruthfulnessFlagCategory;
  context: string;
}

export interface TruthfulnessReport {
  totalAssistantTurns: number;
  totalFlags: number;
  flags: TruthfulnessFlag[];
  violationRate: number;
}

const PATH_PATTERN = /(?<![:/\w.])([A-Za-z][\w-]*(?:\/[\w\-{}$]+){1,})/g;
const QUOTED_PATTERN = /`([A-Za-z_][\w/.\-{}$]{2,})`/g;

const STOPWORDS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'object',
  'string',
  'number',
  'boolean',
  'array',
  'function',
  'request',
  'resource',
  'response',
  'auth',
  'context',
  'database',
  'document',
  'collection',
  'subcollection',
  'firestore',
  'firebase',
  'permission-denied',
  'not-found',
  'unauthenticated',
  'invalid-argument',
  'failed-precondition',
  'already-exists',
  'resource-exhausted',
  'deadline-exceeded',
  'out-of-range',
  'aborted',
  'unavailable',
  'data-loss',
  'internal',
  'cancelled',
  'unknown',
  'unimplemented',
  'getauth',
  'getfirestore',
  'getdatabase',
  'doc',
  'query',
  'where',
  'orderby',
  'limit',
]);

export function analyzeTruthfulness(events: readonly TraceEvent[]): TruthfulnessReport {
  const pairs = pairEvents(events);
  const flags: TruthfulnessFlag[] = [];

  for (const pair of pairs) {
    if (!pair.responseText) continue;
    const corpus = buildGroundingCorpus(pair.request);
    const seen = new Set<string>();
    for (const candidate of extractCandidates(pair.responseText)) {
      if (isStopword(candidate.claim)) continue;
      if (corpus.includes(candidate.claim)) continue;
      const dedupeKey = `${candidate.category}::${candidate.claim}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      flags.push({
        requestId: pair.request.requestId,
        turnId: pair.request.turnId,
        iteration: pair.request.iteration,
        claim: candidate.claim,
        category: candidate.category,
        context: candidate.context,
      });
    }
  }

  const totalAssistantTurns = pairs.filter((p) => p.responseText.length > 0).length;
  return {
    totalAssistantTurns,
    totalFlags: flags.length,
    flags,
    violationRate: totalAssistantTurns === 0 ? 0 : flags.length / totalAssistantTurns,
  };
}

function isStopword(claim: string): boolean {
  if (STOPWORDS.has(claim.toLowerCase())) return true;
  if (claim.includes('{') && claim.includes('}')) return true;
  return false;
}

interface AnalysisPair {
  request: LlmRequestTrace;
  responseText: string;
}

function pairEvents(events: readonly TraceEvent[]): AnalysisPair[] {
  const requestOrder: LlmRequestTrace[] = [];
  const responses = new Map<string, LlmResponseTrace>();
  for (const ev of events) {
    if (ev.kind === 'llm_request') {
      requestOrder.push(ev.data);
    } else if (ev.kind === 'llm_response') {
      responses.set(ev.data.requestId, ev.data);
    }
  }
  const pairs: AnalysisPair[] = [];
  for (let i = 0; i < requestOrder.length; i++) {
    const req = requestOrder[i];
    if (!req) continue;
    const resp = responses.get(req.requestId);
    let responseText = '';
    if (resp) {
      responseText = resp.text;
    } else {
      const next = requestOrder[i + 1];
      if (next) {
        const derived = trailingAssistantText(req.messages, next.messages);
        if (derived) responseText = derived;
      }
    }
    pairs.push({ request: req, responseText });
  }
  return pairs;
}

function trailingAssistantText(
  prev: readonly NormalizedMessage[],
  next: readonly NormalizedMessage[],
): string | undefined {
  for (let i = prev.length; i < next.length; i++) {
    const m = next[i];
    if (m && m.role === 'assistant' && m.text) return m.text;
  }
  return undefined;
}

function buildGroundingCorpus(req: LlmRequestTrace): string {
  const parts: string[] = [req.systemPrompt];
  for (const m of req.messages) {
    if (m.text) parts.push(m.text);
    if (m.resultJson) parts.push(m.resultJson);
  }
  return parts.join('\n');
}

interface Candidate {
  claim: string;
  category: TruthfulnessFlagCategory;
  context: string;
}

function extractCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  collect(text, PATH_PATTERN, 'firestore-path', out);
  collect(text, QUOTED_PATTERN, 'quoted-identifier', out);
  return out;
}

function collect(
  text: string,
  pattern: RegExp,
  category: TruthfulnessFlagCategory,
  out: Candidate[],
): void {
  const re = new RegExp(pattern.source, pattern.flags);
  let m = re.exec(text);
  while (m !== null) {
    const claim = m[1] ?? m[0];
    if (claim) {
      const start = Math.max(0, m.index - 32);
      const end = Math.min(text.length, m.index + claim.length + 32);
      out.push({ claim, category, context: text.slice(start, end) });
    }
    m = re.exec(text);
  }
}
