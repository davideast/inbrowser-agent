import { createHash } from 'node:crypto';
import {
  onChildAdded,
  onChildRemoved,
  onValue,
  ref,
  get as sdkGet,
  runTransaction as sdkRuntransaction,
  set as sdkSet,
  update as sdkUpdate,
} from 'firebase/database';
import { errorEnvelope, errorMessage, responseEnvelope } from '../../../host/envelopes.js';
import {
  type BridgeExecutionPolicy,
  type BridgePrincipal,
  createBridgeExecutor,
} from '../../../host/executor.js';
import type { ContainerSandboxProvider } from '../../../host/types.js';
import type { BridgeEnvelope, RemoteBridgeEvent, RemoteHostDiagnostic } from '../../../types.js';
import { monitorFirebase } from '../connectivity.js';
import {
  ATTACHMENT_MS,
  type FirebaseEventRecord,
  type FirebaseExecutorRuntime,
  type FirebaseResponseRecord,
  type FirebaseRtdbOptions,
  type FirebaseSessionManifest,
  HEARTBEAT_MS,
  OUTPUT_LIMIT,
  RETENTION_MS,
  basePath,
  key,
  parseRequest,
  requireIdentity,
  sequenceKey,
  serializeEnvelope,
} from '../protocol.js';
import { openJournal } from './journal.js';

export interface StartFirebaseRtdbBridgeOptions extends FirebaseRtdbOptions {
  provider: ContainerSandboxProvider;
  root?: string;
  policy: BridgeExecutionPolicy;
  stateDirectory: string;
  reconnectGraceMs?: number;
}
export interface FirebaseRtdbBridge {
  readonly generation: string;
  status(): Promise<{
    connected: boolean;
    generation: string;
    sessions: string[];
    provider: RemoteHostDiagnostic;
    lastError?: string;
  }>;
  destroySession(id: string): Promise<void>;
  stop(): Promise<void>;
}

type EventLog = {
  seq: number;
  bytes: number;
  queuedBytes: number;
  dropped: boolean;
  rows: Map<string, FirebaseEventRecord>;
  tail: Promise<void>;
};

export async function startFirebaseRtdbBridge(
  options: StartFirebaseRtdbBridgeOptions,
): Promise<FirebaseRtdbBridge> {
  const base = basePath(options);
  const uid = requireIdentity(options);
  if (!options.stateDirectory) throw new Error('stateDirectory is required');
  if (!options.provider.cleanupStaleSessions)
    throw new Error('Firebase requires provider cleanupStaleSessions for restart recovery');
  const grace = options.reconnectGraceMs ?? 600_000;
  if (!Number.isFinite(grace) || grace < 0) throw new Error('Invalid reconnectGraceMs');
  const journal = openJournal(options.stateDirectory);
  const monitor = monitorFirebase(options);
  const get: typeof sdkGet = (...args) => monitor.ack(() => sdkGet(...args));
  const set: typeof sdkSet = (...args) => monitor.ack(() => sdkSet(...args));
  const update: typeof sdkUpdate = (...args) => monitor.ack(() => sdkUpdate(...args));
  const runTransaction: typeof sdkRuntransaction = (...args) =>
    monitor.ack(() => sdkRuntransaction(...args));
  const generation = crypto.randomUUID();
  const stops: Array<() => void> = [];
  let leaseStop: (() => void) | undefined;
  const sessionStops = new Map<string, () => void>();
  const pending = new Map<string, Promise<void>>();
  const events = new Map<string, EventLog>();
  const eventLoads = new Map<string, Promise<EventLog>>();
  const detached = new Map<string, number>();
  let stopped = false;
  let lastError: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let maintenance: Promise<void> = Promise.resolve();
  const report = (error: unknown) => {
    lastError = errorMessage(error);
  };
  const executor = createBridgeExecutor({
    provider: options.provider,
    root: options.root ?? '/work',
    policy: options.policy,
    requireRootedFileSystem: true,
    providerSessionId: (id) =>
      `firebase-${createHash('sha256').update(`${base}/${id}`).digest('hex').slice(0, 24)}`,
  });
  const sessionPath = (id: string) => `${base}/sessions/${key(id, 'sessionId')}`;
  const journalKey = (id: string, request: string) => `${id}/${request}`;

  async function assertCurrent() {
    if (stopped) throw new Error('Executor stopped');
    monitor.assertOnline();
    const runtime = (
      await get(ref(options.database, `${base}/runtime`))
    ).val() as FirebaseExecutorRuntime | null;
    if (!runtime || runtime.generation !== generation)
      throw new Error('Executor generation changed');
    monitor.assertOnline();
  }
  async function principal(id: string, author: string): Promise<BridgePrincipal> {
    const manifest = (
      await get(ref(options.database, `${sessionPath(id)}/manifest`))
    ).val() as FirebaseSessionManifest | null;
    if (!manifest) throw new Error('Unknown session manifest');
    const role = manifest.ownerUid === author ? 'owner' : manifest.members?.[author];
    if (role !== 'owner' && role !== 'developer' && role !== 'reviewer')
      throw new Error('Session membership denied');
    return { uid: author, role };
  }
  async function publish(
    id: string,
    response: BridgeEnvelope,
    completedAt: number,
    requestHash: string,
  ) {
    monitor.assertOnline();
    await set(ref(options.database, `${sessionPath(id)}/operations/${response.replyTo}`), {
      phase: 'terminal',
      generation,
      at: completedAt,
    });
    await set(ref(options.database, `${sessionPath(id)}/responses/${response.replyTo}`), {
      envelopeJson: serializeEnvelope(response),
      completedAt,
      requestHash,
    } satisfies FirebaseResponseRecord);
  }
  function eventLog(id: string): Promise<EventLog> {
    let load = eventLoads.get(id);
    if (!load) {
      load = loadEventLog(id);
      eventLoads.set(id, load);
      void load.catch(() => eventLoads.delete(id));
    }
    return load;
  }
  async function loadEventLog(id: string) {
    let log = events.get(id);
    if (log) return log;
    const stored = (await get(ref(options.database, `${sessionPath(id)}/events`))).val() as Record<
      string,
      FirebaseEventRecord
    > | null;
    const rows = new Map(Object.entries(stored ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    const seq = [...rows.keys()].reduce((a, b) => Math.max(a, Number(b)), 0);
    log = {
      seq,
      queuedBytes: 0,
      dropped: false,
      bytes: [...rows.values()].reduce((sum, row) => sum + row.bytes, 0),
      rows,
      tail: Promise.resolve(),
    };
    events.set(id, log);
    return log;
  }
  function emit(id: string, event: RemoteBridgeEvent) {
    const log = events.get(id);
    if (!log) return;
    // Bound each stdout chunk before serializing; provider callbacks remain synchronous.
    const chunks: RemoteBridgeEvent[] =
      event.type === 'artifact' && typeof event.artifact.chunk === 'string'
        ? (event.artifact.chunk.match(/[\s\S]{1,16384}/g) ?? []).map((chunk) => ({
            type: 'artifact',
            artifact: { ...event.artifact, chunk },
          }))
        : [event];
    for (const chunk of chunks) {
      const seq = ++log.seq;
      const envelopeJson = serializeEnvelope({
        id: `event-${seq}`,
        sessionId: id,
        kind: 'event',
        type: 'event',
        sentAt: monitor.now(),
        seq,
        peer: 'host',
        payload: chunk,
      });
      const record = { envelopeJson, bytes: new TextEncoder().encode(envelopeJson).length };
      if (log.queuedBytes + record.bytes > OUTPUT_LIMIT) {
        log.dropped = true;
        continue;
      }
      log.queuedBytes += record.bytes;
      // Retention is also applied in memory before a slow Firebase write completes.
      const eventKey = sequenceKey(seq);
      log.rows.set(eventKey, record);
      log.bytes += record.bytes;
      const changes: Record<string, unknown> = { [`events/${eventKey}`]: record };
      while (log.bytes > OUTPUT_LIMIT) {
        const oldest = log.rows.keys().next().value;
        if (!oldest) break;
        log.bytes -= log.rows.get(oldest)?.bytes ?? 0;
        log.rows.delete(oldest);
        changes[`events/${oldest}`] = null;
      }
      changes.eventWindow = { first: Number(log.rows.keys().next().value ?? seq), last: seq };
      log.tail = log.tail
        .catch(report)
        .then(async () => {
          if (!monitor.online()) {
            log.dropped = true;
            return;
          }
          await update(ref(options.database, sessionPath(id)), changes);
        })
        .finally(() => {
          log.queuedBytes -= record.bytes;
        });
      void log.tail.catch((error) => {
        log.dropped = true;
        report(error);
      });
    }
  }
  async function clearSlot(id: string, slot: string) {
    if (!monitor.online()) return;
    await update(ref(options.database, sessionPath(id)), {
      [`requests/${slot}`]: null,
      [`admissions/${slot}`]: null,
    });
  }
  async function handle(id: string, slot: string, value: unknown) {
    let envelope: BridgeEnvelope | undefined;
    let requestHash = '';
    try {
      const parsed = parseRequest(value, id);
      envelope = parsed.envelope;
      const request = parsed.request;
      const jkey = journalKey(id, request.id);
      const hash = createHash('sha256')
        .update(JSON.stringify([request.author, request.generation, request.envelopeJson]))
        .digest('hex');
      requestHash = hash;
      await assertCurrent();
      await principal(id, request.author);
      const existing = journal.get(jkey);
      if (existing) {
        if (existing.hash !== hash) throw new Error('Request ID reused with different contents');
        if (existing.response)
          await publish(
            id,
            existing.response,
            existing.completedAt ?? monitor.now(),
            existing.hash,
          );
        else throw new Error('Accepted request has an unknown outcome; it will not be re-executed');
        return;
      }
      if (request.generation !== generation || request.deadline <= monitor.now())
        throw new Error('Request expired or belongs to an earlier executor generation');
      await eventLog(id);
      const identity = await principal(id, request.author);
      const result = await executor.dispatch(
        envelope,
        {
          sessionId: id,
          principal: identity,
          async admit() {
            await assertCurrent();
            const current = await principal(id, request.author);
            if (current.role !== identity.role)
              throw new Error('Membership changed while request was queued');
            if (request.deadline <= monitor.now())
              throw new Error('Request admission deadline expired');
            // Rules recheck the immutable author's membership at commit time. Never
            // execute in the transaction callback: Firebase may retry it.
            const admission = await runTransaction(
              ref(options.database, `${sessionPath(id)}/admissions/${slot}`),
              (old) =>
                old === null
                  ? { id: request.id, generation, at: monitor.now(), phase: 'accepted' }
                  : undefined,
              { applyLocally: false },
            );
            if (!admission.committed) throw new Error('Request already admitted');
            monitor.assertOnline();
            if (stopped || request.deadline <= monitor.now())
              throw new Error('Admission expired before execution');
            journal.put(jkey, {
              sessionId: id,
              generation,
              hash,
              acceptedAt: monitor.now(),
              request: envelope as BridgeEnvelope,
            });
            const lifecycle = ref(options.database, `${sessionPath(id)}/operations/${request.id}`);
            await set(lifecycle, { phase: 'accepted', generation, at: monitor.now() });
            await set(lifecycle, { phase: 'running', generation, at: monitor.now() });
            const running = await runTransaction(
              ref(options.database, `${sessionPath(id)}/admissions/${slot}`),
              (old) =>
                old?.id === request.id && old.phase === 'accepted'
                  ? { ...old, phase: 'running', at: monitor.now() }
                  : undefined,
              { applyLocally: false },
            );
            if (!running.committed) throw new Error('Execution admission lost');
            monitor.assertOnline();
            if (request.deadline <= monitor.now())
              throw new Error('Admission expired before execution');
          },
        },
        (event) => emit(id, event),
      );
      if (request.type === 'session.create') {
        await set(ref(options.database, `${sessionPath(id)}/status`), { active: true, generation });
        detached.set(id, monitor.now());
      }
      if (request.type === 'session.destroy')
        await set(ref(options.database, `${sessionPath(id)}/status`), {
          active: false,
          generation,
        });
      await events.get(id)?.tail.catch(report);
      const log = events.get(id);
      if (log?.dropped) {
        log.dropped = false;
        emit(id, { type: 'artifact', artifact: { kind: 'bridge.output-truncated' } });
        await log.tail.catch(report);
      }
      let response = responseEnvelope(envelope, result);
      try {
        serializeEnvelope(response);
      } catch {
        // Streaming already carried complete output; retain a bounded final result.
        if (request.type === 'run.start' && result && typeof result === 'object') {
          const output = result as Record<string, unknown>;
          response = responseEnvelope(envelope, {
            ...output,
            stdout: String(output.stdout ?? '').slice(0, 65536),
            stderr: String(output.stderr ?? '').slice(0, 65536),
            stdoutTruncated: true,
            stderrTruncated: true,
          });
        } else response = errorEnvelope(envelope, new Error('Response exceeds 1 MiB limit'));
      }
      const entry = journal.get(jkey);
      if (entry) journal.put(jkey, { ...entry, response, completedAt: monitor.now() });
      await publish(id, response, monitor.now(), requestHash);
    } catch (error) {
      report(error);
      if (envelope) {
        const jkey = journalKey(id, envelope.id);
        const response = errorEnvelope(envelope, error);
        const existing = journal.get(jkey);
        // Do not overwrite an earlier completed result on a forged ID reuse.
        if (existing && !existing.response)
          journal.put(jkey, { ...existing, response, completedAt: monitor.now() });
        if (!existing?.response)
          await publish(id, response, monitor.now(), requestHash).catch(report);
      }
    } finally {
      await clearSlot(id, slot).catch(report);
    }
  }
  function attach(id: string) {
    key(id, 'sessionId');
    if (sessionStops.has(id)) return;
    const stop = onChildAdded(
      ref(options.database, `${sessionPath(id)}/requests`),
      (snap) => {
        const slot = snap.key;
        if (!slot || !/^slot-[0-9][0-9]$/.test(slot)) return;
        const value = snap.val() as { id?: string } | null;
        const idKey = `${id}/${value?.id ?? slot}`;
        const previous = pending.get(idKey);
        // Repeated delivery in a second slot waits for the original journal result.
        const task = (previous ?? Promise.resolve()).then(() => handle(id, slot, value));
        pending.set(idKey, task);
        void task
          .finally(() => {
            if (pending.get(idKey) === task) pending.delete(idKey);
          })
          .catch(report);
      },
      report,
    );
    sessionStops.set(id, stop);
  }
  async function destroySession(id: string) {
    await executor.dispose(id);
    detached.delete(id);
    if (monitor.online())
      await set(ref(options.database, `${sessionPath(id)}/status`), { active: false, generation });
  }
  async function sweep() {
    if (stopped) return;
    if (monitor.online()) {
      const refreshed = await runTransaction(
        ref(options.database, `${base}/runtime`),
        (current: FirebaseExecutorRuntime | null) =>
          current?.generation === generation
            ? { generation, uid, expiresAt: monitor.now() + ATTACHMENT_MS - 1000 }
            : undefined,
        { applyLocally: false },
      );
      if (!refreshed.committed) {
        void stop().catch(report);
        throw new Error('Executor lease lost');
      }
    }
    for (const id of executor.sessionIds()) {
      let latest = detached.get(id) ?? monitor.now();
      if (monitor.online()) {
        const all = (
          await get(ref(options.database, `${sessionPath(id)}/attachments`))
        ).val() as Record<string, Record<string, { expiresAt: number; generation: string }>> | null;
        const expired: Record<string, null> = {};
        for (const [user, leases] of Object.entries(all ?? {}))
          for (const [leaseId, lease] of Object.entries(leases)) {
            if (lease.generation === generation && lease.expiresAt > monitor.now())
              latest = Math.max(latest, lease.expiresAt);
            else expired[`${user}/${leaseId}`] = null;
          }
        if (Object.keys(expired).length)
          await update(ref(options.database, `${sessionPath(id)}/attachments`), expired);
      }
      detached.set(id, latest);
      if (monitor.now() - latest >= grace) await destroySession(id);
    }
    if (monitor.online()) {
      for (const [jkey, entry] of journal.all())
        if (entry.completedAt && entry.completedAt < monitor.now() - RETENTION_MS) {
          await set(
            ref(options.database, `${sessionPath(entry.sessionId)}/responses/${entry.request.id}`),
            null,
          );
        }
      journal.prune(monitor.now() - RETENTION_MS, generation);
    }
  }
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= shutdown();
    return stopping;
  }
  async function shutdown() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const unsubscribe of stops) unsubscribe();
    for (const unsubscribe of sessionStops.values()) unsubscribe();
    await executor.stop();
    await maintenance;
    await Promise.allSettled(pending.values());
    if (monitor.online())
      await runTransaction(
        ref(options.database, `${base}/runtime`),
        (current: FirebaseExecutorRuntime | null) =>
          current?.generation === generation ? null : undefined,
        { applyLocally: false },
      ).catch(report);
    leaseStop?.();
    monitor.stop();
    journal.close();
  }
  try {
    await monitor.ready();
    const config = (await get(ref(options.database, `${base}/config`))).val() as {
      uid?: string;
    } | null;
    if (config?.uid !== uid) throw new Error('Signed-in user is not the configured executor');
    const claimed = await runTransaction(
      ref(options.database, `${base}/runtime`),
      (current: FirebaseExecutorRuntime | null) =>
        current && current.expiresAt > monitor.now()
          ? undefined
          : { generation, uid, expiresAt: monitor.now() + ATTACHMENT_MS - 1000 },
      { applyLocally: false },
    );
    if (!claimed.committed) throw new Error('Another executor holds an active lease');
    // RTDB transaction callbacks may initially see null unless a listener keeps
    // this location in the SDK cache. Hold the lease location for refresh/stop.
    leaseStop = onValue(
      ref(options.database, `${base}/runtime`),
      (snapshot) => {
        const runtime = snapshot.val() as FirebaseExecutorRuntime | null;
        if (!stopped && runtime?.generation !== generation) {
          report(new Error('Executor lease lost'));
          void stop().catch(report);
        }
      },
      report,
    );
    await options.provider.cleanupStaleSessions?.();
    for (const [jkey, entry] of journal.all())
      if (!entry.response) {
        const response = errorEnvelope(
          entry.request,
          new Error(
            'Unknown outcome: executor restarted after acceptance; request will not be retried',
          ),
        );
        const recovered = { ...entry, response, completedAt: monitor.now() };
        journal.put(jkey, recovered);
        await publish(entry.sessionId, response, recovered.completedAt, entry.hash);
      }
    const sessions = (await get(ref(options.database, `${base}/sessions`))).val() as Record<
      string,
      unknown
    > | null;
    for (const id of Object.keys(sessions ?? {}))
      await set(ref(options.database, `${sessionPath(id)}/status`), { active: false, generation });
    stops.push(
      onChildAdded(
        ref(options.database, `${base}/sessions`),
        (snap) => {
          if (snap.key) attach(snap.key);
        },
        report,
      ),
    );
    stops.push(
      onChildRemoved(
        ref(options.database, `${base}/sessions`),
        (snap) => {
          if (snap.key) {
            sessionStops.get(snap.key)?.();
            sessionStops.delete(snap.key);
            void executor.dispose(snap.key).catch(report);
          }
        },
        report,
      ),
    );
    timer = setInterval(() => {
      maintenance = maintenance.then(sweep).catch(report);
    }, HEARTBEAT_MS);
    return {
      generation,
      destroySession,
      stop,
      async status() {
        return {
          connected: monitor.online(),
          generation,
          sessions: executor.sessionIds(),
          provider: await executor.status(),
          ...(lastError ? { lastError } : {}),
        };
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
