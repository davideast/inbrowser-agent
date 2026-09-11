import type { Auth } from 'firebase/auth';
import type { Database } from 'firebase/database';
import type { BridgeEnvelope } from '../../types.js';

export const DEFAULT_NAMESPACE = 'inbrowserBridge';
export const ENVELOPE_LIMIT = 1_048_576;
export const REQUEST_SLOTS = 100;
export const ADMISSION_MS = 30_000;
export const ATTACHMENT_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
export const RETENTION_MS = 86_400_000;
export const OUTPUT_LIMIT = 10_485_760;

export interface FirebaseRtdbOptions {
  database: Database;
  auth: Auth;
  namespace?: string;
  executorId: string;
}
export interface FirebaseSessionManifest {
  ownerUid: string;
  members?: Record<string, 'developer' | 'reviewer'>;
}
export interface FirebaseExecutorRuntime {
  generation: string;
  uid: string;
  expiresAt: number;
}
export interface FirebaseRequestRecord {
  id: string;
  author: string;
  generation: string;
  deadline: number;
  type: string;
  envelopeJson: string;
}
export interface FirebaseResponseRecord {
  requestHash: string;
  envelopeJson: string;
  completedAt: number;
}
export interface FirebaseEventRecord {
  envelopeJson: string;
  bytes: number;
}

export function key(value: string, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error(`Invalid ${name}: use 1–128 letters, digits, underscores or hyphens`);
  return value;
}
export function basePath(options: FirebaseRtdbOptions): string {
  return `${key(options.namespace ?? DEFAULT_NAMESPACE, 'namespace')}/executors/${key(options.executorId, 'executorId')}`;
}
export function requireIdentity(options: FirebaseRtdbOptions): string {
  if (options.auth.app !== options.database.app)
    throw new Error('Firebase Auth and Database must belong to the same app');
  const uid = options.auth.currentUser?.uid;
  if (!uid) throw new Error('Firebase bridge requires a signed-in user');
  key(uid, 'Firebase UID');
  return uid;
}
export function serializeEnvelope(envelope: BridgeEnvelope): string {
  const json = JSON.stringify(envelope);
  if (new TextEncoder().encode(json).length > ENVELOPE_LIMIT)
    throw new Error('Bridge envelope exceeds 1 MiB limit');
  return json;
}
export function parseRequest(
  value: unknown,
  sessionId: string,
): { request: FirebaseRequestRecord; envelope: BridgeEnvelope } {
  const request = value as FirebaseRequestRecord;
  if (
    !request ||
    typeof request.envelopeJson !== 'string' ||
    typeof request.deadline !== 'number' ||
    !Number.isFinite(request.deadline)
  )
    throw new Error('Invalid request record');
  key(request.id, 'request id');
  key(request.author, 'author');
  key(request.generation, 'generation');
  const envelope = JSON.parse(request.envelopeJson) as BridgeEnvelope;
  serializeEnvelope(envelope);
  if (
    envelope.id !== request.id ||
    envelope.sessionId !== sessionId ||
    envelope.kind !== 'request' ||
    envelope.type !== request.type
  )
    throw new Error('Request envelope does not match immutable routing fields');
  return { request, envelope };
}
export function sequenceKey(seq: number): string {
  return String(seq).padStart(16, '0');
}

export async function requestDigest(
  author: string,
  generation: string,
  envelopeJson: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([author, generation, envelopeJson]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
