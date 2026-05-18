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
 * POC: bodies are stubs. The frame types are stable.
 */

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

// Reference unused types so dead-code elimination doesn't complain when
// future wiring picks them up. No runtime effect.
type _ClientFrame = ClientFrame;
type _HostFrame = HostFrame;

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
  _workerScope: DedicatedWorkerGlobalScope,
  _opts?: HostEngineInWorkerOpts,
): WorkerHostHandle {
  return {
    async dispose() {
      // POC stub. Real impl: tear down `engine.dispose()`, drop all
      // subscriptions, stop accepting frames.
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

  let state: EngineState = 'idle';
  const stateSubs = new Set<(s: EngineState) => void>();
  const loadSubs = new Set<(p: LoadProgress) => void>();

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
    // POC stub. Real impl: send 'ensure-ready' frame, await 'ack' or
    // 'reject', mirror state transitions from 'state' frames.
    throw new Error('connectWorkerEngine.ensureReady not yet wired (POC stub)');
  }

  async function* generate(
    _messages: ReadonlyArray<EngineMessage>,
    _opts?: GenerateOpts,
  ): AsyncIterable<EngineEvent> {
    yield {
      kind: 'error',
      message: 'connectWorkerEngine.generate not yet wired (POC stub)',
      recoverable: false,
    };
  }

  async function dispose(): Promise<void> {
    state = 'disposed';
    stateSubs.clear();
    loadSubs.clear();
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
