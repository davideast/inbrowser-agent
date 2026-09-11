import {
  onChildAdded,
  onValue,
  orderByKey,
  query,
  ref,
  get as sdkGet,
  remove as sdkRemove,
  runTransaction as sdkRuntransaction,
  set as sdkSet,
  startAt,
} from 'firebase/database';
import { createBridgeConnection } from '../../connection.js';
import type { BridgeConnection, BridgeEnvelope, BridgeTransportProvider } from '../../types.js';
import { monitorFirebase } from './connectivity.js';
import {
  ADMISSION_MS,
  ATTACHMENT_MS,
  type FirebaseEventRecord,
  type FirebaseExecutorRuntime,
  type FirebaseRequestRecord,
  type FirebaseResponseRecord,
  type FirebaseRtdbOptions,
  HEARTBEAT_MS,
  REQUEST_SLOTS,
  basePath,
  key,
  parseRequest,
  requestDigest,
  requireIdentity,
  sequenceKey,
  serializeEnvelope,
} from './protocol.js';

export type { FirebaseRtdbOptions, FirebaseSessionManifest } from './protocol.js';

/** Firebase owns authentication; this adapter never accepts a UID from an envelope. */
export function createFirebaseRtdbBridgeProvider(
  options: FirebaseRtdbOptions,
): BridgeTransportProvider {
  const base = basePath(options);
  return {
    kind: 'firebase-rtdb',
    async connect(connectOptions) {
      if (connectOptions.role !== 'browser')
        throw new Error('Use startFirebaseRtdbBridge for an executor');
      const uid = requireIdentity(options);
      const sessionId = key(connectOptions.sessionId, 'sessionId');
      const path = `${base}/sessions/${sessionId}`;
      const attachment = `${path}/attachments/${uid}/${crypto.randomUUID()}`;
      const listeners = new Set<(event: BridgeEnvelope) => void>();
      const stops: Array<() => void> = [];
      const responseStops = new Map<string, () => void>();
      const sent = new Map<string, string>();
      let closed = false;
      let connection: BridgeConnection | undefined;
      let lastSeq = connectOptions.resumeFromSeq ?? 0;
      const buffered: BridgeEnvelope[] = [];
      let bufferOverflow = false;
      const emit = (envelope: BridgeEnvelope) => {
        if (listeners.size === 0) {
          if (buffered.length >= 256) {
            buffered.shift();
            bufferOverflow = true;
          }
          buffered.push(envelope);
        } else for (const listener of listeners) listener(envelope);
      };
      const monitor = monitorFirebase(options);
      const get: typeof sdkGet = (...args) => monitor.ack(() => sdkGet(...args));
      const set: typeof sdkSet = (...args) => monitor.ack(() => sdkSet(...args));
      const remove: typeof sdkRemove = (...args) => monitor.ack(() => sdkRemove(...args));
      const runTransaction: typeof sdkRuntransaction = (...args) =>
        monitor.ack(() => sdkRuntransaction(...args));
      let timer: ReturnType<typeof setInterval> | undefined;
      const close = async () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        for (const stop of stops) stop();
        for (const stop of responseStops.values()) stop();
        responseStops.clear();
        listeners.clear();
        const online = monitor.online();
        // Offline attachments expire by lease; do not enqueue an offline delete.
        try {
          if (online) await remove(ref(options.database, attachment)).catch(() => undefined);
        } finally {
          monitor.stop();
        }
      };
      try {
        await monitor.ready();
        const runtime = (
          await get(ref(options.database, `${base}/runtime`))
        ).val() as FirebaseExecutorRuntime | null;
        monitor.assertOnline();
        if (!runtime || runtime.expiresAt <= monitor.now())
          throw new Error('Firebase executor is not online');
        const renew = async () => {
          if (!closed && monitor.online())
            await set(ref(options.database, attachment), {
              expiresAt: monitor.now() + ATTACHMENT_MS - 1000,
              generation: runtime.generation,
            });
        };
        await renew();
        const fail = (error: Error) => {
          emit({
            id: crypto.randomUUID(),
            sessionId,
            kind: 'event',
            type: 'event',
            sentAt: Date.now(),
            payload: { type: 'sandbox', event: { type: 'error', message: error.message } },
          });
          void (connection ? connection.close(error.message) : close()).catch(() => undefined);
        };
        timer = setInterval(() => {
          void renew().catch(fail);
        }, HEARTBEAT_MS);
        stops.push(
          onValue(
            ref(options.database, `${base}/runtime`),
            (snap) => {
              const current = snap.val() as FirebaseExecutorRuntime | null;
              if (!current || current.generation !== runtime.generation)
                fail(new Error('Executor restarted; create a new attachment'));
            },
            fail,
          ),
        );
        stops.push(
          onValue(
            ref(options.database, `${path}/eventWindow`),
            (snap) => {
              const window = snap.val() as { first?: number } | null;
              if (window?.first && window.first > lastSeq + 1) {
                emit({
                  id: crypto.randomUUID(),
                  sessionId,
                  kind: 'event',
                  type: 'event',
                  sentAt: Date.now(),
                  payload: {
                    type: 'artifact',
                    artifact: {
                      kind: 'bridge.replay-gap',
                      from: lastSeq + 1,
                      to: window.first - 1,
                    },
                  },
                });
                lastSeq = window.first - 1;
              }
            },
            fail,
          ),
        );
        stops.push(
          onChildAdded(
            query(
              ref(options.database, `${path}/events`),
              orderByKey(),
              startAt(sequenceKey(lastSeq + 1)),
            ),
            (snap) => {
              const record = snap.val() as FirebaseEventRecord;
              const envelope = JSON.parse(record.envelopeJson) as BridgeEnvelope;
              if (envelope.seq && envelope.seq > lastSeq) {
                if (envelope.seq > lastSeq + 1)
                  emit({
                    id: crypto.randomUUID(),
                    sessionId,
                    kind: 'event',
                    type: 'event',
                    sentAt: Date.now(),
                    payload: {
                      type: 'artifact',
                      artifact: {
                        kind: 'bridge.replay-gap',
                        from: lastSeq + 1,
                        to: envelope.seq - 1,
                      },
                    },
                  });
                lastSeq = envelope.seq;
                emit(envelope);
              }
            },
            fail,
          ),
        );
        if (closed) throw new Error('Firebase bridge initialization failed');
        connection = createBridgeConnection({
          sessionId,
          role: 'browser',
          initialEventBuffer: 256,
          transport: {
            subscribe(callback) {
              listeners.add(callback);
              if (bufferOverflow)
                callback({
                  id: crypto.randomUUID(),
                  sessionId,
                  kind: 'event',
                  type: 'event',
                  sentAt: Date.now(),
                  payload: {
                    type: 'artifact',
                    artifact: {
                      kind: 'bridge.replay-gap',
                      reason: 'Transport initialization buffer exceeded',
                    },
                  },
                });
              for (const event of buffered.splice(0)) callback(event);
              return () => listeners.delete(callback);
            },
            close,
            async send(envelope) {
              if (closed) throw new Error('Firebase bridge is closed');
              monitor.assertOnline();
              if (envelope.sessionId !== sessionId || envelope.kind !== 'request')
                throw new Error('Invalid client envelope');
              key(envelope.id, 'requestId');
              if (responseStops.size >= REQUEST_SLOTS)
                throw new Error('This attachment has 100 pending requests');
              if (sent.size >= 10000 && !sent.has(envelope.id))
                throw new Error('Attachment request history is full; reattach');
              const json = serializeEnvelope(envelope);
              if (sent.has(envelope.id) && sent.get(envelope.id) !== json)
                throw new Error('Request ID reused with different contents');
              const expectedHash = await requestDigest(uid, runtime.generation, json);
              // Subscribe before submitting, including when a terminal result already exists.
              if (!responseStops.has(envelope.id)) {
                const stop = onValue(
                  ref(options.database, `${path}/responses/${envelope.id}`),
                  (snap) => {
                    const result = snap.val() as FirebaseResponseRecord | null;
                    if (!result) return;
                    emit(
                      result.requestHash === expectedHash
                        ? (JSON.parse(result.envelopeJson) as BridgeEnvelope)
                        : {
                            id: crypto.randomUUID(),
                            sessionId,
                            kind: 'error',
                            type: envelope.type,
                            replyTo: envelope.id,
                            sentAt: Date.now(),
                            payload: { message: 'Request ID reused with different contents' },
                          },
                    );
                    queueMicrotask(() => {
                      responseStops.get(envelope.id)?.();
                      responseStops.delete(envelope.id);
                    });
                  },
                  fail,
                );
                responseStops.set(envelope.id, stop);
              }
              sent.set(envelope.id, json);
              const request: FirebaseRequestRecord = {
                id: envelope.id,
                author: uid,
                generation: runtime.generation,
                deadline: monitor.now() + ADMISSION_MS - 1000,
                type: envelope.type,
                envelopeJson: json,
              };
              parseRequest(request, sessionId);
              try {
                const firstSlot = Math.floor(Math.random() * REQUEST_SLOTS);
                for (let i = 0; i < REQUEST_SLOTS; i++) {
                  monitor.assertOnline();
                  const slot = `slot-${String((firstSlot + i) % REQUEST_SLOTS).padStart(2, '0')}`;
                  const result = await runTransaction(
                    ref(options.database, `${path}/requests/${slot}`),
                    (existing) => (existing === null ? request : undefined),
                    { applyLocally: false },
                  );
                  if (result.committed) return;
                }
                throw new Error('Session has 100 outstanding requests');
              } catch (error) {
                responseStops.get(envelope.id)?.();
                responseStops.delete(envelope.id);
                throw error;
              }
            },
          },
        });
        return connection;
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    },
  };
}
