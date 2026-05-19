/**
 * Worker transport — host an `Engine` inside a Web Worker; expose
 * the same `Engine` shape on the main thread via a postMessage RPC.
 *
 * The key invariant: `connectWorkerEngine` returns a value that
 * satisfies the same `Engine` interface as `createEngine`. Anything
 * downstream — adapters, agent runtime, UI — cannot tell whether it
 * holds a direct engine or a remote stub.
 *
 * RPC framing is sequence-numbered; `generate` opens a per-call
 * stream id and the worker side fans `EngineEvent`s back tagged
 * with that id. Backpressure today is implicit (postMessage queue);
 * a future revision may add explicit acks.
 *
 * Wire shape:
 *
 *   main → worker (ClientFrame)
 *     init            — once, on connect; carries CreateEngineOpts
 *     ensure-ready    — request the engine to load (seq-tracked ack/reject)
 *     generate-start  — open a stream; events flow back tagged with seq
 *     generate-abort  — request a stream to terminate (best effort)
 *     dispose         — tear down engine + transport
 *
 *   worker → main (HostFrame)
 *     init-ack        — handshake reply (model + capabilities echoed)
 *     state           — engine state transitions
 *     load            — LoadProgress events
 *     ack | reject    — per-seq reply for ensure-ready / dispose
 *     event           — a single EngineEvent for a generate stream
 *     event-end       — terminal marker for a generate stream
 */

import { createEngine as defaultCreateEngine } from './engine.js';
import type {
  CreateEngineOpts,
  Engine,
  EngineCapabilities,
  EngineEvent,
  EngineEventMap,
  EngineMessage,
  EngineState,
  GenerateOpts,
  LoadProgress,
  ModelRef,
} from './types.js';

// ── Wire frames ──────────────────────────────────────────────────────────────

type ClientFrame =
  | { kind: 'init'; opts: CreateEngineOpts }
  | { kind: 'ensure-ready'; seq: number }
  | { kind: 'generate-start'; seq: number; messages: EngineMessage[]; opts?: GenerateOpts }
  | { kind: 'generate-abort'; seq: number }
  | { kind: 'dispose'; seq: number };

type HostFrame =
  | { kind: 'init-ack'; model: ModelRef; capabilities: EngineCapabilities }
  | { kind: 'state'; value: EngineState }
  | { kind: 'load'; value: LoadProgress }
  | { kind: 'ack'; seq: number }
  | { kind: 'reject'; seq: number; message: string }
  | { kind: 'event'; seq: number; event: EngineEvent }
  | { kind: 'event-end'; seq: number };

// ── Transport shim ───────────────────────────────────────────────────────────
// Both sides interact with their counterpart via a minimal port. The default
// real-world port is a `Worker` (main side) or `DedicatedWorkerGlobalScope`
// (worker side); tests can substitute a `MessageChannel.port`.

interface PortLike<TIn, TOut> {
  postMessage(msg: TOut): void;
  addEventListener(type: 'message', handler: (ev: MessageEvent<TIn>) => void): void;
  removeEventListener(type: 'message', handler: (ev: MessageEvent<TIn>) => void): void;
}

// ── Host side (runs in the worker) ───────────────────────────────────────────

export interface WorkerHostHandle {
  dispose(): Promise<void>;
}

export interface HostEngineInWorkerOpts {
  /**
   * Factory the host uses to build the real engine after receiving
   * `init` from the main thread. Default: `createEngine` from this
   * package. Override only for testing.
   */
  factory?: (opts: CreateEngineOpts) => Engine;
}

/**
 * Install the worker-side RPC. Call from inside your worker entry:
 *
 *   import { hostEngineInWorker } from '@inbrowser/model/worker';
 *   hostEngineInWorker(self);
 */
export function hostEngineInWorker(
  workerScope: DedicatedWorkerGlobalScope,
  opts?: HostEngineInWorkerOpts,
): WorkerHostHandle {
  const factory = opts?.factory ?? defaultCreateEngine;
  const port = workerScope as unknown as PortLike<ClientFrame, HostFrame>;

  let engine: Engine | null = null;
  let stateOff: (() => void) | null = null;
  let loadOff: (() => void) | null = null;
  const abortControllers = new Map<number, AbortController>();
  let disposed = false;

  function post(frame: HostFrame): void {
    if (disposed) return;
    port.postMessage(frame);
  }

  function attachSubscribers(eng: Engine): void {
    stateOff = eng.on('state', (value) => post({ kind: 'state', value }));
    loadOff = eng.on('load', (value) => post({ kind: 'load', value }));
  }

  function onInit(frame: Extract<ClientFrame, { kind: 'init' }>): void {
    if (engine) {
      // Double-init: just re-ack with current model. The client likely
      // crossed wires; never destroy a live engine on a duplicate init.
      post({ kind: 'init-ack', model: engine.model, capabilities: engine.capabilities });
      return;
    }
    try {
      engine = factory(frame.opts);
      attachSubscribers(engine);
      post({ kind: 'init-ack', model: engine.model, capabilities: engine.capabilities });
    } catch (e) {
      // Surface as a state=error so the client side learns the engine
      // is unusable. Subsequent ensure-ready calls will reject too.
      post({ kind: 'state', value: 'error' });
      // No seq to reject against; the client's ensure-ready will fail
      // when it runs because engine is null.
      post({
        kind: 'load',
        value: { phase: 'ready' }, // best-effort terminal; not load-bearing
      });
      const msg = e instanceof Error ? e.message : String(e);
      post({ kind: 'reject', seq: -1, message: msg });
    }
  }

  async function onEnsureReady(seq: number): Promise<void> {
    if (!engine) {
      post({ kind: 'reject', seq, message: 'engine not initialized' });
      return;
    }
    try {
      await engine.ensureReady();
      post({ kind: 'ack', seq });
    } catch (e) {
      post({ kind: 'reject', seq, message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function onGenerateStart(
    frame: Extract<ClientFrame, { kind: 'generate-start' }>,
  ): Promise<void> {
    const { seq, messages, opts: genOpts } = frame;
    if (!engine) {
      post({
        kind: 'event',
        seq,
        event: { kind: 'error', message: 'engine not initialized', recoverable: false },
      });
      post({ kind: 'event-end', seq });
      return;
    }

    const controller = new AbortController();
    abortControllers.set(seq, controller);

    // GenerateOpts may contain a caller-side AbortSignal, but signals
    // don't cross postMessage boundaries. We synthesize one on the
    // host from generate-abort frames.
    const forwardedOpts: GenerateOpts = { ...(genOpts ?? {}), signal: controller.signal };

    try {
      for await (const event of engine.generate(messages, forwardedOpts)) {
        if (disposed) break;
        post({ kind: 'event', seq, event });
        if (controller.signal.aborted) break;
      }
    } catch (e) {
      post({
        kind: 'event',
        seq,
        event: {
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      });
    } finally {
      abortControllers.delete(seq);
      post({ kind: 'event-end', seq });
    }
  }

  function onGenerateAbort(seq: number): void {
    const ctrl = abortControllers.get(seq);
    if (ctrl) ctrl.abort();
  }

  async function onDispose(seq: number): Promise<void> {
    try {
      // Abort every in-flight generate before tearing down the engine.
      for (const ctrl of abortControllers.values()) ctrl.abort();
      abortControllers.clear();
      if (engine) await engine.dispose();
      post({ kind: 'ack', seq });
    } catch (e) {
      post({ kind: 'reject', seq, message: e instanceof Error ? e.message : String(e) });
    } finally {
      stateOff?.();
      loadOff?.();
      stateOff = null;
      loadOff = null;
      engine = null;
      disposed = true;
      port.removeEventListener('message', onMessage);
    }
  }

  function onMessage(ev: MessageEvent<ClientFrame>): void {
    const frame = ev.data;
    if (!frame || typeof frame !== 'object') return;
    switch (frame.kind) {
      case 'init':
        onInit(frame);
        return;
      case 'ensure-ready':
        void onEnsureReady(frame.seq);
        return;
      case 'generate-start':
        void onGenerateStart(frame);
        return;
      case 'generate-abort':
        onGenerateAbort(frame.seq);
        return;
      case 'dispose':
        void onDispose(frame.seq);
        return;
    }
  }

  port.addEventListener('message', onMessage);

  return {
    async dispose() {
      if (disposed) return;
      for (const ctrl of abortControllers.values()) ctrl.abort();
      abortControllers.clear();
      if (engine) {
        try {
          await engine.dispose();
        } catch {
          // best effort during teardown
        }
      }
      stateOff?.();
      loadOff?.();
      stateOff = null;
      loadOff = null;
      engine = null;
      disposed = true;
      port.removeEventListener('message', onMessage);
    },
  };
}

// ── Client side (runs on the main thread) ────────────────────────────────────

export interface ConnectWorkerEngineOpts {
  worker: Worker;
  engine: CreateEngineOpts;
  /** Handshake timeout for the initial capabilities exchange. Default 10s. */
  handshakeTimeoutMs?: number;
}

/**
 * Connect to a worker that has called `hostEngineInWorker(self)`.
 * Returns an `Engine` whose calls are RPC'd over postMessage.
 */
export function connectWorkerEngine(opts: ConnectWorkerEngineOpts): Engine {
  const model = opts.engine.model;
  const capabilities = opts.engine.capabilities;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
  const port = opts.worker as unknown as PortLike<HostFrame, ClientFrame>;

  let state: EngineState = 'idle';
  const stateSubs = new Set<(s: EngineState) => void>();
  const loadSubs = new Set<(p: LoadProgress) => void>();
  // Caller-supplied onLoadProgress mirrors what createEngine does: keep
  // the worker transport feature-compatible with the in-thread engine.
  if (opts.engine.onLoadProgress) loadSubs.add(opts.engine.onLoadProgress);

  // Per-call pending promises (ensure-ready, dispose). Resolved by `ack`,
  // rejected by `reject`.
  type Pending = { resolve: () => void; reject: (e: Error) => void };
  const pending = new Map<number, Pending>();

  // Per-call streams for `generate`. The host pushes 'event' frames; we
  // route to the matching queue. 'event-end' closes the queue.
  type StreamSlot = {
    queue: EngineEvent[];
    done: boolean;
    resolver: (() => void) | null;
  };
  const streams = new Map<number, StreamSlot>();

  // Handshake state. The init frame is sent eagerly so the worker can
  // start fetching weights as soon as ensureReady fires.
  let handshakeResolve: (() => void) | null = null;
  let handshakeReject: ((e: Error) => void) | null = null;
  const handshake = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
  });
  // Avoid an unhandled-rejection warning if the consumer disposes
  // before ever calling ensureReady/generate.
  handshake.catch(() => {});
  const handshakeTimer = setTimeout(() => {
    handshakeReject?.(new Error('connectWorkerEngine: handshake timeout'));
  }, handshakeTimeoutMs);

  let seqCounter = 0;
  function nextSeq(): number {
    seqCounter = (seqCounter + 1) | 0;
    if (seqCounter <= 0) seqCounter = 1;
    return seqCounter;
  }

  let disposed = false;

  function send(frame: ClientFrame): void {
    if (disposed) return;
    port.postMessage(frame);
  }

  function setState(next: EngineState): void {
    if (state === next) return;
    state = next;
    for (const sub of stateSubs) sub(next);
  }

  function emitLoad(p: LoadProgress): void {
    for (const sub of loadSubs) sub(p);
  }

  function onMessage(ev: MessageEvent<HostFrame>): void {
    const frame = ev.data;
    if (!frame || typeof frame !== 'object') return;
    switch (frame.kind) {
      case 'init-ack': {
        clearTimeout(handshakeTimer);
        handshakeResolve?.();
        handshakeResolve = null;
        handshakeReject = null;
        return;
      }
      case 'state': {
        setState(frame.value);
        return;
      }
      case 'load': {
        emitLoad(frame.value);
        return;
      }
      case 'ack': {
        const p = pending.get(frame.seq);
        if (p) {
          pending.delete(frame.seq);
          p.resolve();
        }
        return;
      }
      case 'reject': {
        const p = pending.get(frame.seq);
        if (p) {
          pending.delete(frame.seq);
          p.reject(new Error(frame.message));
        }
        // If the host emits an unsolicited reject (seq=-1 on init
        // failure), fail the handshake so consumers find out.
        if (frame.seq === -1 && handshakeReject) {
          clearTimeout(handshakeTimer);
          handshakeReject(new Error(frame.message));
          handshakeResolve = null;
          handshakeReject = null;
        }
        return;
      }
      case 'event': {
        const slot = streams.get(frame.seq);
        if (!slot || slot.done) return;
        slot.queue.push(frame.event);
        const r = slot.resolver;
        slot.resolver = null;
        if (r) r();
        return;
      }
      case 'event-end': {
        const slot = streams.get(frame.seq);
        if (!slot) return;
        slot.done = true;
        const r = slot.resolver;
        slot.resolver = null;
        if (r) r();
        return;
      }
    }
  }

  port.addEventListener('message', onMessage);

  // Kick the handshake.
  send({ kind: 'init', opts: opts.engine });

  function on<K extends keyof EngineEventMap>(
    event: K,
    handler: (value: EngineEventMap[K]) => void,
  ): () => void {
    if (event === 'state') {
      const h = handler as (s: EngineState) => void;
      stateSubs.add(h);
      return () => stateSubs.delete(h);
    }
    const h = handler as (p: LoadProgress) => void;
    loadSubs.add(h);
    return () => loadSubs.delete(h);
  }

  async function ensureReady(): Promise<void> {
    if (state === 'disposed') throw new Error('engine disposed');
    await handshake;
    if (state === 'ready') return;
    const seq = nextSeq();
    const p = new Promise<void>((resolve, reject) => {
      pending.set(seq, { resolve, reject });
    });
    send({ kind: 'ensure-ready', seq });
    await p;
  }

  async function* generate(
    messages: ReadonlyArray<EngineMessage>,
    genOpts?: GenerateOpts,
  ): AsyncIterable<EngineEvent> {
    if (disposed || state === 'disposed') {
      yield { kind: 'error', message: 'engine disposed', recoverable: false };
      return;
    }
    try {
      await handshake;
    } catch (e) {
      yield {
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
        recoverable: false,
      };
      return;
    }

    const seq = nextSeq();
    const slot: StreamSlot = { queue: [], done: false, resolver: null };
    streams.set(seq, slot);

    // GenerateOpts.signal can't cross the wire; observe locally and
    // forward as a generate-abort frame.
    const localSignal = genOpts?.signal;
    const abortHandler = () => send({ kind: 'generate-abort', seq });
    if (localSignal) {
      if (localSignal.aborted) {
        send({ kind: 'generate-abort', seq });
      } else {
        localSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    // Strip non-serializable fields from the wire payload. AbortSignal
    // (and any future host-only fields) shouldn't be cloned.
    const wireOpts: GenerateOpts | undefined = genOpts ? stripNonSerializable(genOpts) : undefined;

    send({
      kind: 'generate-start',
      seq,
      messages: messages as EngineMessage[],
      ...(wireOpts ? { opts: wireOpts } : {}),
    });

    try {
      while (true) {
        if (slot.queue.length === 0) {
          if (slot.done) break;
          await new Promise<void>((r) => {
            slot.resolver = r;
          });
          continue;
        }
        const next = slot.queue.shift();
        if (next) yield next;
      }
    } finally {
      streams.delete(seq);
      if (localSignal) localSignal.removeEventListener('abort', abortHandler);
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      state = 'disposed';
      return;
    }
    disposed = true;
    // Fail any in-flight handshake so callers awaiting ensureReady
    // through it unblock immediately.
    clearTimeout(handshakeTimer);
    handshakeReject?.(new Error('engine disposed'));
    handshakeResolve = null;
    handshakeReject = null;
    const seq = nextSeq();
    const p = new Promise<void>((resolve, reject) => {
      pending.set(seq, { resolve, reject });
    });
    port.postMessage({ kind: 'dispose', seq });
    // Race the ack against a short grace period — a dead host (worker
    // already terminated, channel closed) must not hang dispose forever.
    const grace = new Promise<void>((resolve) => setTimeout(resolve, 250));
    try {
      await Promise.race([p, grace]);
    } catch {
      // Best-effort: even if the host rejects, the client is gone.
    }
    // Drain pending RPCs and streams so awaiters don't hang forever.
    for (const [, pend] of pending) pend.reject(new Error('engine disposed'));
    pending.clear();
    for (const [, slot] of streams) {
      slot.done = true;
      slot.queue.push({ kind: 'error', message: 'engine disposed', recoverable: false });
      const r = slot.resolver;
      slot.resolver = null;
      if (r) r();
    }
    setState('disposed');
    stateSubs.clear();
    loadSubs.clear();
    port.removeEventListener('message', onMessage);
  }

  return {
    get model() {
      return model;
    },
    get state() {
      return state;
    },
    get capabilities() {
      return capabilities;
    },
    ensureReady,
    on,
    generate,
    dispose,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Drop fields that can't survive structured clone (AbortSignal,
 * functions). Today only `signal` qualifies; we forward everything
 * else verbatim so future options pass through automatically.
 */
function stripNonSerializable(o: GenerateOpts): GenerateOpts {
  const { signal: _signal, ...rest } = o;
  return rest;
}
