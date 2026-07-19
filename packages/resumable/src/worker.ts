/**
 * Worker transport — host a `JobEngine` inside a Web Worker (dedicated
 * or shared) and drive it from another context over a postMessage RPC.
 *
 * The shape mirrors the worker helpers in `@inbrowser/model/local`: a `PortLike`
 * abstraction that works for `Worker`, `MessagePort`, a SharedWorker
 * port, and `MessageChannel` ports in tests; request-id-routed frames
 * with a pending map for request→reply calls and a stream-slot map for
 * the streamed `subscribe`; and an abort-frame protocol that re-
 * synthesizes the consumer's `AbortSignal` host-side (signals don't
 * survive structured clone).
 *
 * The twist versus the model transport: a `Producer` is a function and
 * cannot cross `postMessage`. So `start` sends a serializable **spec**
 * and the host turns it into a producer via a host-supplied
 * `buildProducer(spec)`. One `createJobEngine` is shared across every
 * connected port (a SharedWorker fans one engine out to many tabs).
 *
 * Wire shape (every frame carries a `rid` request id so concurrent
 * calls — including concurrent subscribes on one port — never cross):
 *
 *   client → host (ClientFrame)
 *     start            — start a job from a spec; replies start-reply
 *     get              — read a snapshot; replies get-reply
 *     stop             — stop the shared engine; replies stop-reply
 *     subscribe        — open a stream; events flow back tagged with rid
 *     subscribe-cancel — abort a stream the consumer broke out of early
 *
 *   host → client (HostFrame)
 *     start-reply      — { rid, jobId } or { rid, error }
 *     get-reply        — { rid, snapshot } or { rid, error }
 *     stop-reply       — { rid } or { rid, error }
 *     event            — one JobEvent for an open subscribe stream
 *     subscribe-done   — terminal marker for a subscribe stream
 *     subscribe-error  — the host-side subscribe threw; closes the stream
 */

import { createJobEngine } from './engine.js';
import type { JobStore } from './store/contract.js';
import type { JobEvent, JobSnapshot, Producer } from './types.js';

// ── Transport shim ───────────────────────────────────────────────────────────
// Both sides talk to their counterpart through a minimal port. The real-world
// port is a `Worker` / SharedWorker `MessagePort` (client side) or
// `DedicatedWorkerGlobalScope` / SharedWorker connect-port (host side); tests
// substitute `MessageChannel` ports. Mirrors `model/src/worker.ts`.

export interface PortLike {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', handler: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (ev: MessageEvent) => void): void;
}

// ── Wire frames ──────────────────────────────────────────────────────────────

type ClientFrame<TSpec> =
  | { kind: 'start'; rid: number; spec: TSpec }
  | { kind: 'get'; rid: number; jobId: string }
  | { kind: 'stop'; rid: number }
  | { kind: 'subscribe'; rid: number; jobId: string; from?: number }
  | { kind: 'subscribe-cancel'; rid: number };

type HostFrame<TEvent> =
  | { kind: 'start-reply'; rid: number; jobId: string }
  | { kind: 'get-reply'; rid: number; snapshot: JobSnapshot<TEvent> | null }
  | { kind: 'stop-reply'; rid: number }
  | { kind: 'reply-error'; rid: number; message: string }
  | { kind: 'event'; rid: number; event: JobEvent<TEvent> }
  | { kind: 'subscribe-done'; rid: number }
  | { kind: 'subscribe-error'; rid: number; message: string };

// ── Host side (runs in the worker) ───────────────────────────────────────────

export interface HostJobEngineOpts<TEvent, TSpec> {
  store: JobStore<TEvent>;
  /**
   * Rebuild a `Producer` from the serializable spec the client sent.
   * A producer is a function and can't cross `postMessage`, so the
   * client ships data and the host reconstitutes the work here (e.g.
   * build a `ModelClient` + drive the agent loop in the worker).
   */
  buildProducer: (spec: TSpec) => Producer<TEvent>;
}

export interface JobEngineHost {
  /**
   * Attach a client port and begin handling its frames. Safe to call
   * for many ports — a SharedWorker fans the single engine out to
   * every connected tab. Each port gets its own frame handler and its
   * own per-port subscribe AbortControllers.
   */
  connect(port: PortLike): void;
  /** Stop the shared engine and detach every connected port. */
  stop(): Promise<void>;
}

/**
 * Build a host that owns ONE `createJobEngine({ store })` and serves it
 * to any number of client ports. Call from a worker entry:
 *
 *   const host = hostJobEngine({ store: createIdbJobStore(), buildProducer });
 *   // dedicated worker:
 *   host.connect(self);
 *   // shared worker:
 *   self.addEventListener('connect', (e) => host.connect(e.ports[0]));
 */
export function hostJobEngine<TEvent, TSpec>(
  opts: HostJobEngineOpts<TEvent, TSpec>,
): JobEngineHost {
  const engine = createJobEngine<TEvent>({ store: opts.store });
  const buildProducer = opts.buildProducer;

  // Per-port teardown so `stop()` can detach every listener.
  const ports = new Map<PortLike, () => void>();
  let stopped = false;

  function connect(port: PortLike): void {
    if (stopped) return;
    // Each open subscribe on this port gets an AbortController so a
    // subscribe-cancel frame can stop the host-side `engine.subscribe`.
    // Keyed by the request id so concurrent subscribes don't collide.
    const subAborts = new Map<number, AbortController>();

    function post(frame: HostFrame<TEvent>): void {
      port.postMessage(frame);
    }

    async function onStart(rid: number, spec: TSpec): Promise<void> {
      try {
        const producer = buildProducer(spec);
        const { jobId } = await engine.start(producer);
        post({ kind: 'start-reply', rid, jobId });
      } catch (e) {
        post({ kind: 'reply-error', rid, message: errMessage(e) });
      }
    }

    async function onGet(rid: number, jobId: string): Promise<void> {
      try {
        const snapshot = await engine.get(jobId);
        post({ kind: 'get-reply', rid, snapshot });
      } catch (e) {
        post({ kind: 'reply-error', rid, message: errMessage(e) });
      }
    }

    async function onStop(rid: number): Promise<void> {
      try {
        await engine.stop();
        post({ kind: 'stop-reply', rid });
      } catch (e) {
        post({ kind: 'reply-error', rid, message: errMessage(e) });
      }
    }

    async function onSubscribe(rid: number, jobId: string, from?: number): Promise<void> {
      // The consumer's AbortSignal can't cross the wire; synthesize one
      // here and trip it on a subscribe-cancel frame for this rid.
      const ac = new AbortController();
      subAborts.set(rid, ac);
      try {
        for await (const event of engine.subscribe(jobId, {
          ...(from !== undefined ? { from } : {}),
          signal: ac.signal,
        })) {
          if (ac.signal.aborted) break;
          post({ kind: 'event', rid, event });
        }
        // Only announce a clean end if the consumer didn't cancel. A
        // cancelled stream shouldn't get a spurious done frame after the
        // client already walked away.
        if (!ac.signal.aborted) post({ kind: 'subscribe-done', rid });
      } catch (e) {
        if (!ac.signal.aborted) post({ kind: 'subscribe-error', rid, message: errMessage(e) });
      } finally {
        subAborts.delete(rid);
      }
    }

    function onSubscribeCancel(rid: number): void {
      const ac = subAborts.get(rid);
      if (ac) ac.abort();
    }

    function onMessage(ev: MessageEvent): void {
      const frame = ev.data as ClientFrame<TSpec> | null;
      if (!frame || typeof frame !== 'object') return;
      switch (frame.kind) {
        case 'start':
          void onStart(frame.rid, frame.spec);
          return;
        case 'get':
          void onGet(frame.rid, frame.jobId);
          return;
        case 'stop':
          void onStop(frame.rid);
          return;
        case 'subscribe':
          void onSubscribe(frame.rid, frame.jobId, frame.from);
          return;
        case 'subscribe-cancel':
          onSubscribeCancel(frame.rid);
          return;
      }
    }

    port.addEventListener('message', onMessage);
    ports.set(port, () => {
      // Abort every in-flight subscribe for this port, then detach.
      for (const ac of subAborts.values()) ac.abort();
      subAborts.clear();
      port.removeEventListener('message', onMessage);
    });
  }

  return {
    connect,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const detach of ports.values()) detach();
      ports.clear();
      await engine.stop();
    },
  };
}

// ── Client side (runs in the page / another worker) ──────────────────────────

export interface ConnectedJobEngine<TEvent, TSpec> {
  start(spec: TSpec): Promise<{ jobId: string }>;
  subscribe(
    jobId: string,
    opts?: { from?: number; signal?: AbortSignal },
  ): AsyncIterable<JobEvent<TEvent>>;
  get(jobId: string): Promise<JobSnapshot<TEvent> | null>;
  /** Stop the shared host engine. */
  stop(): Promise<void>;
}

/**
 * Connect to a port whose other end is served by `hostJobEngine(...)`.
 * Returns a thin client whose calls are RPC'd over postMessage. The
 * returned `subscribe` iterable is cancelable: break the `for-await`
 * (or abort the supplied signal) and the client sends a
 * `subscribe-cancel` frame so the host aborts its `engine.subscribe`.
 */
export function connectJobEngine<TEvent, TSpec>(port: PortLike): ConnectedJobEngine<TEvent, TSpec> {
  // Per-call pending promises (start, get, stop). Resolved/rejected by
  // the matching *-reply / reply-error frame.
  type Pending = { resolve: (value: unknown) => void; reject: (e: Error) => void };
  const pending = new Map<number, Pending>();

  // Per-call streams for `subscribe`. The host pushes 'event' frames; we
  // route to the matching slot's queue. 'subscribe-done'/'subscribe-error'
  // close it. `done` means "stop yielding"; `ended` means "the host drove
  // the stream to its natural terminus" — only then does the client skip
  // sending a subscribe-cancel on teardown.
  type StreamSlot = {
    queue: JobEvent<TEvent>[];
    done: boolean;
    ended: boolean;
    error: Error | null;
    resolver: (() => void) | null;
  };
  const streams = new Map<number, StreamSlot>();

  let ridCounter = 0;
  function nextRid(): number {
    ridCounter = (ridCounter + 1) | 0;
    if (ridCounter <= 0) ridCounter = 1;
    return ridCounter;
  }

  function send(frame: ClientFrame<TSpec>): void {
    port.postMessage(frame);
  }

  function onMessage(ev: MessageEvent): void {
    const frame = ev.data as HostFrame<TEvent> | null;
    if (!frame || typeof frame !== 'object') return;
    switch (frame.kind) {
      case 'start-reply': {
        resolvePending(frame.rid, { jobId: frame.jobId });
        return;
      }
      case 'get-reply': {
        resolvePending(frame.rid, frame.snapshot);
        return;
      }
      case 'stop-reply': {
        resolvePending(frame.rid, undefined);
        return;
      }
      case 'reply-error': {
        rejectPending(frame.rid, new Error(frame.message));
        return;
      }
      case 'event': {
        const slot = streams.get(frame.rid);
        if (!slot || slot.done) return;
        slot.queue.push(frame.event);
        wake(slot);
        return;
      }
      case 'subscribe-done': {
        const slot = streams.get(frame.rid);
        if (!slot) return;
        slot.done = true;
        slot.ended = true;
        wake(slot);
        return;
      }
      case 'subscribe-error': {
        const slot = streams.get(frame.rid);
        if (!slot) return;
        slot.done = true;
        slot.ended = true;
        slot.error = new Error(frame.message);
        wake(slot);
        return;
      }
    }
  }

  function resolvePending(rid: number, value: unknown): void {
    const p = pending.get(rid);
    if (!p) return;
    pending.delete(rid);
    p.resolve(value);
  }

  function rejectPending(rid: number, err: Error): void {
    const p = pending.get(rid);
    if (!p) return;
    pending.delete(rid);
    p.reject(err);
  }

  function wake(slot: StreamSlot): void {
    const r = slot.resolver;
    slot.resolver = null;
    if (r) r();
  }

  port.addEventListener('message', onMessage);

  function request<T>(frame: ClientFrame<TSpec>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.set(frame.rid, { resolve: resolve as (v: unknown) => void, reject });
      send(frame);
    });
  }

  async function start(spec: TSpec): Promise<{ jobId: string }> {
    return request<{ jobId: string }>({ kind: 'start', rid: nextRid(), spec });
  }

  async function get(jobId: string): Promise<JobSnapshot<TEvent> | null> {
    return request<JobSnapshot<TEvent> | null>({ kind: 'get', rid: nextRid(), jobId });
  }

  async function stop(): Promise<void> {
    await request<void>({ kind: 'stop', rid: nextRid() });
  }

  async function* subscribe(
    jobId: string,
    opts?: { from?: number; signal?: AbortSignal },
  ): AsyncIterable<JobEvent<TEvent>> {
    const rid = nextRid();
    const slot: StreamSlot = { queue: [], done: false, ended: false, error: null, resolver: null };
    streams.set(rid, slot);

    // The consumer's signal can't cross the wire; observe it locally and
    // forward as a subscribe-cancel frame. Same for a consumer that
    // breaks the for-await — handled in the `finally` below. `cancel` is
    // idempotent so the signal path and the teardown path can both call it.
    const signal = opts?.signal;
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      send({ kind: 'subscribe-cancel', rid });
    };
    // An aborted signal is the consumer asking out from the OUTSIDE while
    // the generator may be parked on `slot.resolver`. Mark the slot done
    // and wake it so the parked `await` resumes, drains what already
    // arrived, and exits the loop — the `finally` then sends the cancel.
    // (A `break` inside the for-await, by contrast, is observed directly
    // by the loop returning into `finally`, no wake needed.)
    const onSignalAbort = () => {
      slot.done = true;
      wake(slot);
    };
    if (signal) {
      if (signal.aborted) onSignalAbort();
      else signal.addEventListener('abort', onSignalAbort, { once: true });
    }

    send({
      kind: 'subscribe',
      rid,
      jobId,
      ...(opts?.from !== undefined ? { from: opts.from } : {}),
    });

    try {
      while (true) {
        if (slot.queue.length > 0) {
          const next = slot.queue.shift();
          if (next) yield next;
          continue;
        }
        if (slot.error) throw slot.error;
        if (slot.done) break;
        await new Promise<void>((r) => {
          slot.resolver = r;
        });
      }
    } finally {
      // Consumer is done — drained naturally, broke out of the for-await,
      // aborted the signal, or threw. If the host didn't already drive the
      // stream to its natural terminus (`ended`), tell it to stop driving.
      streams.delete(rid);
      if (signal) signal.removeEventListener('abort', onSignalAbort);
      if (!slot.ended) cancel();
    }
  }

  return { start, subscribe, get, stop };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
