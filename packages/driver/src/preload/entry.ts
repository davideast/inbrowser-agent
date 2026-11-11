import {
  type ActRpcParams,
  type CaptureRpcParams,
  DRIVER_CHANNEL,
  type DriverHelloMessage,
  type EvalRpcParams,
  type ObserveRpcParams,
  PROTOCOL_VERSION,
  type SerializedDriverError,
} from '../protocol.js';
import { DriverError } from '../types.js';
import { executeActBatch } from './act.js';
import { captureInPreload } from './capture-seam.js';
import { drainDiagnostics, ensureDiagnosticsInstalled } from './diagnostics.js';
import { evaluateInPreload } from './eval.js';
import {
  HostMessageEvent,
  is,
  offEvent,
  onEvent,
  portClose,
  portPostMessage,
  portStart,
  reflectDefineProperty,
  reflectHas,
  win,
} from './intrinsics.js';
import { installCanvasContextTracker, observeDocument } from './observe.js';
import { failDriver, syncMinRevision } from './ref-registry.js';

const INSTALLED_KEY = Symbol.for('@inbrowser/driver:preload-installed:v1');

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const envKind = (v: unknown): string =>
  isRec(v) &&
  v['channel'] === DRIVER_CHANNEL &&
  v['protocolVersion'] === PROTOCOL_VERSION &&
  typeof v['kind'] === 'string'
    ? v['kind']
    : '';

const optType = (v: unknown, t: string): boolean => v === undefined || typeof v === t;

function isHello(v: unknown): v is DriverHelloMessage {
  if (envKind(v) !== 'hello') return false;
  const r = v as Record<string, unknown>; // Invariant: envKind('hello') narrowed isRec(v)
  return (
    typeof r['allowEval'] === 'boolean' &&
    optType(r['sessionId'], 'string') &&
    optType(r['rebindOnlyIfUnbound'], 'boolean') &&
    (r['minRev'] === undefined || isInt(r['minRev']))
  );
}

function installDriverPreload(): void {
  if (!win || typeof MessagePort === 'undefined' || reflectHas(win, INSTALLED_KEY)) return;
  reflectDefineProperty(win, INSTALLED_KEY, { value: true });

  ensureDiagnosticsInstalled();
  installCanvasContextTracker();

  let activePort: MessagePort | null = null;
  let activeAllowEval = false;
  let activeSid: string | undefined;
  let activeHandler: ((event: Event) => void) | null = null;
  let inFlightAct:
    | [id: number, fromRev: number, completedSteps: number, totalSteps: number]
    | null = null;

  const send = (port: MessagePort, body: Record<string, unknown>): void => {
    portPostMessage(port, {
      channel: DRIVER_CHANNEL,
      protocolVersion: PROTOCOL_VERSION,
      ...body,
    });
  };

  const sendAck = (port: MessagePort, allowEval: boolean): void => {
    send(port, {
      kind: 'hello_ack',
      capabilities: {
        protocolVersion: PROTOCOL_VERSION,
        allowEval,
        captureModes: ['silent'],
        trustedInput: false,
      },
    });
  };

  async function dispatch(
    port: MessagePort,
    id: number,
    method: unknown,
    p: unknown,
  ): Promise<void> {
    try {
      const r = isRec(p) ? p : null;
      let result: unknown;
      if (method === 'observe' && (p === undefined || r)) {
        result = observeDocument(p as ObserveRpcParams | undefined); // Invariant: validated optional record above
      } else if (method === 'act' && r && isInt(r['rev']) && Array.isArray(r['steps'])) {
        const ap = r as unknown as ActRpcParams; // Invariant: validated rev and steps array above
        const actTuple: [number, number, number, number] = [id, ap.rev, 0, ap.steps.length];
        inFlightAct = actTuple;
        try {
          result = await executeActBatch(ap, (fromRev, completed) => {
            actTuple[1] = fromRev;
            actTuple[2] = completed;
          });
        } finally {
          if (inFlightAct === actTuple) inFlightAct = null;
        }
      } else if (method === 'capture' && typeof r?.['mode'] === 'string') {
        result = await captureInPreload(r as unknown as CaptureRpcParams); // Invariant: validated mode string above
      } else if (method === 'eval' && typeof r?.['expression'] === 'string') {
        if (!activeAllowEval) failDriver('DRIVER_EVAL_DISABLED', 'allowEval is false.');
        result = await evaluateInPreload(r as unknown as EvalRpcParams); // Invariant: validated expression string above
      } else {
        failDriver('DRIVER_PROTOCOL', 'Bad RPC.');
      }
      if (activePort === port) {
        send(port, { kind: 'rpc_response', id, ok: true, result });
      }
    } catch (err) {
      if (activePort === port) {
        const e = err instanceof DriverError ? err : null;
        const error: SerializedDriverError = {
          code: e ? e.code : 'DRIVER_PROTOCOL',
          message: e ? e.message : err instanceof Error ? err.message : String(err),
          ...(e?.candidates ? { candidates: e.candidates } : {}),
        };
        send(port, { kind: 'rpc_response', id, ok: false, error });
      }
    }
  }

  const detach = (close: boolean): MessagePort | undefined => {
    const prev = activePort;
    if (!prev) return undefined;
    activePort = null;
    if (activeHandler) offEvent(prev, 'message', activeHandler);
    activeHandler = null;
    if (close) portClose(prev);
    return prev;
  };

  const applyHello = (port: MessagePort, d: DriverHelloMessage): void => {
    if (d.minRev !== undefined) syncMinRevision(d.minRev);
    activeAllowEval = d.allowEval;
    activeSid = d.sessionId;
    sendAck(port, d.allowEval);
  };

  function bindPort(port: MessagePort, hello?: DriverHelloMessage): void {
    if (hello?.minRev !== undefined) syncMinRevision(hello.minRev);
    detach(true);
    activePort = port;
    activeAllowEval = false;
    activeSid = undefined;
    activeHandler = (ev: Event): void => {
      if (!is(ev, HostMessageEvent)) return;
      const d: unknown = ev.data;
      if (isHello(d)) applyHello(port, d);
      else if (isRec(d) && d['channel'] === DRIVER_CHANNEL && isInt(d['id'], 1)) {
        void dispatch(port, d['id'], envKind(d) === 'rpc_request' ? d['method'] : '', d['params']);
      }
    };
    onEvent(port, 'message', activeHandler);
    portStart(port);
    if (hello) applyHello(port, hello);
  }

  onEvent(win, 'pagehide', (): void => {
    const port = detach(false);
    if (port && inFlightAct) {
      const [id, fromRev, completedSteps, totalSteps] = inFlightAct;
      inFlightAct = null;
      send(port, {
        kind: 'navigating',
        id,
        fromRev,
        completedSteps,
        totalSteps,
        diagnostics: drainDiagnostics(),
      });
    }
  });

  onEvent(win, 'message', (ev: Event): void => {
    if (!is(ev, HostMessageEvent)) return;
    const p = ev.ports[0];
    if (!p) return;
    const d: unknown = ev.data;
    if (isHello(d)) {
      if (
        d.rebindOnlyIfUnbound === true &&
        activePort !== null &&
        d.sessionId !== undefined &&
        activeSid === d.sessionId
      ) {
        portClose(p);
        return;
      }
      bindPort(p, d);
    } else if (envKind(d) === 'bind_port') {
      bindPort(p);
    }
  });
}

installDriverPreload();
