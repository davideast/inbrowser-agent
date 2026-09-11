import type { BridgeEnvelope } from '../types.js';

export function responseEnvelope(request: BridgeEnvelope, payload: unknown): BridgeEnvelope {
  return {
    id: `response-${request.id}`,
    sessionId: request.sessionId,
    kind: 'response',
    type: request.type,
    replyTo: request.id,
    sentAt: Date.now(),
    peer: 'host',
    payload,
  };
}

export function errorEnvelope(request: BridgeEnvelope, err: unknown): BridgeEnvelope {
  return {
    id: `error-${request.id}`,
    sessionId: request.sessionId,
    kind: 'error',
    type: request.type,
    replyTo: request.id,
    sentAt: Date.now(),
    peer: 'host',
    payload: { message: errorMessage(err) },
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
