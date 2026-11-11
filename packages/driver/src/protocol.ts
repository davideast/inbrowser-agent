import type {
  ActInterruptionReason,
  ActOptions,
  ActResult,
  CaptureBackendMode,
  CaptureResult,
  DiagnosticsDelta,
  DragDestination,
  DriverCapabilities,
  DriverErrorCode,
  DriverStep,
  EvalOptions,
  EvalResult,
  ObservationOptions,
  ObservationSnapshot,
  RefId,
  ScreenshotCaptureOptions,
  SemanticFingerprint,
  SnapshotCanvasState,
  SnapshotDiff,
  SnapshotMediaState,
  SnapshotNode,
  StartRecordingCaptureOptions,
  StopRecordingCaptureOptions,
  TargetSpec,
} from './types.js';

export const DRIVER_CHANNEL = '@inbrowser/driver:v1' as const;
export const PROTOCOL_VERSION = 1 as const;

export interface DriverBindPortMessage {
  readonly channel: typeof DRIVER_CHANNEL;
  readonly kind: 'bind_port';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
}

export interface DriverHelloMessage {
  readonly channel: typeof DRIVER_CHANNEL;
  readonly kind: 'hello';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly allowEval: boolean;
  readonly sessionId?: string;
  readonly rebindOnlyIfUnbound?: boolean;
  readonly minRev?: number;
}

export interface DriverHelloAckMessage {
  readonly channel: typeof DRIVER_CHANNEL;
  readonly kind: 'hello_ack';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly capabilities: DriverCapabilities;
}

export interface DriverNavigatingMessage {
  readonly channel: typeof DRIVER_CHANNEL;
  readonly kind: 'navigating';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly fromRev: number;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly diagnostics: DiagnosticsDelta;
}

export type ObserveRpcParams = Omit<ObservationOptions, 'signal'>;
export type ActRpcParams = Omit<ActOptions, 'signal'>;
export type CaptureRpcParams =
  | Omit<ScreenshotCaptureOptions, 'signal'>
  | Omit<StartRecordingCaptureOptions, 'signal'>
  | Omit<StopRecordingCaptureOptions, 'signal'>;
export type EvalRpcParams = Omit<EvalOptions, 'signal'>;

export type DriverRpcMethod = 'observe' | 'act' | 'capture' | 'eval';

export type DriverRpcRequest =
  | {
      readonly channel: typeof DRIVER_CHANNEL;
      readonly kind: 'rpc_request';
      readonly protocolVersion: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly method: 'observe';
      readonly params?: ObserveRpcParams;
    }
  | {
      readonly channel: typeof DRIVER_CHANNEL;
      readonly kind: 'rpc_request';
      readonly protocolVersion: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly method: 'act';
      readonly params: ActRpcParams;
    }
  | {
      readonly channel: typeof DRIVER_CHANNEL;
      readonly kind: 'rpc_request';
      readonly protocolVersion: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly method: 'capture';
      readonly params: CaptureRpcParams;
    }
  | {
      readonly channel: typeof DRIVER_CHANNEL;
      readonly kind: 'rpc_request';
      readonly protocolVersion: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly method: 'eval';
      readonly params: EvalRpcParams;
    };

export interface SerializedDriverError {
  readonly code: DriverErrorCode;
  readonly message: string;
  readonly candidates?: readonly SemanticFingerprint[];
}

export interface DriverRpcSuccessResponse<R = unknown> {
  readonly channel: typeof DRIVER_CHANNEL;
  readonly kind: 'rpc_response';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly ok: true;
  readonly result: R;
}

export interface DriverRpcErrorResponse {
  readonly channel: typeof DRIVER_CHANNEL;
  readonly kind: 'rpc_response';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly ok: false;
  readonly error: SerializedDriverError;
}

export type DriverRpcResponse<R = unknown> = DriverRpcSuccessResponse<R> | DriverRpcErrorResponse;

/* @__NO_SIDE_EFFECTS__ */
function wordGuard<T extends string>(words: string): (v: unknown) => v is T {
  const s = new Set(words.split(' '));
  return (v: unknown): v is T => typeof v === 'string' && s.has(v);
}

const isDriverErrorCode = /* @__PURE__ */ wordGuard<DriverErrorCode>(
  'DRIVER_TIMEOUT DRIVER_DISPOSED DRIVER_PROTOCOL DRIVER_UNSUPPORTED DRIVER_TARGET_NOT_FOUND DRIVER_TARGET_AMBIGUOUS DRIVER_EVAL_DISABLED',
);
const isActInterruptionReason = /* @__PURE__ */ wordGuard<ActInterruptionReason>(
  'step_error dialog_opened compile_error navigation user_takeover',
);
const isCaptureBackendMode = /* @__PURE__ */ wordGuard<CaptureBackendMode>('silent viewport-gpu');
const isClickButton = /* @__PURE__ */ wordGuard<'left' | 'middle' | 'right'>('left middle right');
const isNavAction = /* @__PURE__ */ wordGuard<'reload' | 'back' | 'forward'>('reload back forward');
const isWaitState = /* @__PURE__ */ wordGuard<'attached' | 'visible' | 'hidden' | 'detached'>(
  'attached visible hidden detached',
);
const isCaptureFormat = /* @__PURE__ */ wordGuard<'webp' | 'png'>('webp png');

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isOptStr = (v: unknown): boolean => v === undefined || isStr(v);
const isOptBool = (v: unknown): boolean => v === undefined || isBool(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegFinite = (v: unknown): v is number => isFiniteNumber(v) && v >= 0;
const isOptNonNegFinite = (v: unknown): boolean => v === undefined || isNonNegFinite(v);
export const isPosSafeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isNonNegSafeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isRefId = (v: unknown): v is RefId => isStr(v) && /^e\d+$/.test(v);

export function isVersionedEnvelope(v: unknown, kind: string): v is Record<string, unknown> {
  return (
    isRecord(v) &&
    v['channel'] === DRIVER_CHANNEL &&
    v['kind'] === kind &&
    v['protocolVersion'] === PROTOCOL_VERSION
  );
}

function isTargetSpec(v: unknown): v is TargetSpec {
  if (isRefId(v)) return true;
  if (!isRecord(v)) return false;
  if (isStr(v['role'])) {
    return isOptStr(v['name']) && (v['nth'] === undefined || isNonNegSafeInt(v['nth']));
  }
  if (isStr(v['driver'])) {
    return v['driver'].trim().length > 0 && (v['nth'] === undefined || isNonNegSafeInt(v['nth']));
  }
  return isStr(v['text']) && isOptBool(v['exact']);
}

function isDragDestination(v: unknown): v is DragDestination {
  if (!isRecord(v)) return false;
  if ('target' in v) return isTargetSpec(v['target']);
  return (
    (isFiniteNumber(v['deltaX']) && isFiniteNumber(v['deltaY'])) ||
    (isFiniteNumber(v['clientX']) && isFiniteNumber(v['clientY']))
  );
}

function isDriverStep(v: unknown): v is DriverStep {
  if (!isRecord(v)) return false;
  switch (v['kind']) {
    case 'click':
      return (
        isTargetSpec(v['target']) &&
        (v['button'] === undefined || isClickButton(v['button'])) &&
        (v['clickCount'] === undefined || isPosSafeInt(v['clickCount']))
      );
    case 'fill':
      return isTargetSpec(v['target']) && isStr(v['value']) && isOptBool(v['submit']);
    case 'setValue':
      return isTargetSpec(v['target']) && (isStr(v['value']) || isFiniteNumber(v['value']));
    case 'select': {
      const sv = v['value'];
      return isTargetSpec(v['target']) && (isStr(sv) || (Array.isArray(sv) && sv.every(isStr)));
    }
    case 'press':
      return isStr(v['key']) && (v['target'] === undefined || isTargetSpec(v['target']));
    case 'drag':
      return (
        isTargetSpec(v['from']) &&
        isDragDestination(v['to']) &&
        (v['steps'] === undefined || isPosSafeInt(v['steps']))
      );
    case 'navigate': {
      const hasUrl = v['url'] !== undefined;
      return (
        hasUrl !== (v['action'] !== undefined) &&
        (hasUrl ? isStr(v['url']) : isNavAction(v['action']))
      );
    }
    case 'waitFor': {
      const hasT = v['target'] !== undefined;
      const hasTxt = v['text'] !== undefined;
      return (
        (hasT || hasTxt || v['idleMs'] !== undefined) &&
        (!hasT || isTargetSpec(v['target'])) &&
        (!hasTxt || isStr(v['text'])) &&
        (v['state'] === undefined || isWaitState(v['state'])) &&
        isOptNonNegFinite(v['idleMs']) &&
        isOptNonNegFinite(v['timeoutMs'])
      );
    }
    default:
      return false;
  }
}

function isSemanticFingerprint(v: unknown): v is SemanticFingerprint {
  return (
    isRecord(v) &&
    isStr(v['role']) &&
    isStr(v['name']) &&
    isNonNegSafeInt(v['nth']) &&
    isOptStr(v['landmark']) &&
    isOptStr(v['driverId'])
  );
}

function isDriverCapabilities(v: unknown): v is DriverCapabilities {
  return (
    isRecord(v) &&
    v['protocolVersion'] === PROTOCOL_VERSION &&
    isBool(v['allowEval']) &&
    isBool(v['trustedInput']) &&
    Array.isArray(v['captureModes']) &&
    v['captureModes'].every(isCaptureBackendMode)
  );
}

function isObserveRpcParams(v: unknown): v is ObserveRpcParams {
  return isRecord(v) && isOptStr(v['scope']) && isOptBool(v['includeAllText']);
}

function isActRpcParams(v: unknown): v is ActRpcParams {
  return (
    isRecord(v) &&
    isNonNegSafeInt(v['rev']) &&
    Array.isArray(v['steps']) &&
    v['steps'].every(isDriverStep) &&
    isOptNonNegFinite(v['timeoutMs'])
  );
}

function isCaptureRpcParams(v: unknown): v is CaptureRpcParams {
  if (!isRecord(v)) return false;
  const m = v['mode'];
  return (
    m === 'start_recording' ||
    m === 'stop_recording' ||
    (m === 'screenshot' &&
      (v['target'] === undefined || isTargetSpec(v['target'])) &&
      (v['format'] === undefined || isCaptureFormat(v['format'])) &&
      (v['quality'] === undefined || isFiniteNumber(v['quality'])))
  );
}

function isEvalRpcParams(v: unknown): v is EvalRpcParams {
  return isRecord(v) && isStr(v['expression']) && isOptNonNegFinite(v['timeoutMs']);
}

function isSerializedDriverError(v: unknown): v is SerializedDriverError {
  if (!isRecord(v) || !isDriverErrorCode(v['code']) || !isStr(v['message'])) return false;
  const c = v['candidates'];
  return c === undefined || (Array.isArray(c) && c.every(isSemanticFingerprint));
}

export function isDriverChannelEnvelope(value: unknown): boolean {
  return isRecord(value) && value['channel'] === DRIVER_CHANNEL;
}

export function isDriverBindPort(value: unknown): value is DriverBindPortMessage {
  return isVersionedEnvelope(value, 'bind_port');
}

export function isDriverHello(value: unknown): value is DriverHelloMessage {
  return (
    isVersionedEnvelope(value, 'hello') &&
    isBool(value['allowEval']) &&
    isOptStr(value['sessionId']) &&
    isOptBool(value['rebindOnlyIfUnbound']) &&
    (value['minRev'] === undefined || isNonNegSafeInt(value['minRev']))
  );
}

export function isDriverHelloAck(value: unknown): value is DriverHelloAckMessage {
  return isVersionedEnvelope(value, 'hello_ack') && isDriverCapabilities(value['capabilities']);
}

export function isDriverRpcRequest(value: unknown): value is DriverRpcRequest {
  if (!isVersionedEnvelope(value, 'rpc_request') || !isPosSafeInt(value['id'])) return false;
  const p = value['params'];
  switch (value['method']) {
    case 'observe':
      return p === undefined || isObserveRpcParams(p);
    case 'act':
      return isActRpcParams(p);
    case 'capture':
      return isCaptureRpcParams(p);
    case 'eval':
      return isEvalRpcParams(p);
    default:
      return false;
  }
}

export function isDriverRpcResponse(value: unknown): value is DriverRpcResponse {
  if (!isVersionedEnvelope(value, 'rpc_response') || !isPosSafeInt(value['id'])) return false;
  if (value['ok'] === true) return 'result' in value;
  if (value['ok'] === false) return isSerializedDriverError(value['error']);
  return false;
}

function isDiagnosticsDelta(v: unknown): v is DiagnosticsDelta {
  return (
    isRecord(v) &&
    (v['compileOverlay'] === null || isStr(v['compileOverlay'])) &&
    Array.isArray(v['consoleErrors']) &&
    v['consoleErrors'].every(isStr) &&
    Array.isArray(v['pageErrors']) &&
    v['pageErrors'].every(isStr) &&
    Array.isArray(v['networkFailures']) &&
    v['networkFailures'].every(
      (e) =>
        isRecord(e) &&
        isStr(e['method']) &&
        isStr(e['url']) &&
        isNonNegSafeInt(e['status']) &&
        isStr(e['statusText']),
    )
  );
}

export function isDriverNavigating(value: unknown): value is DriverNavigatingMessage {
  return (
    isVersionedEnvelope(value, 'navigating') &&
    isPosSafeInt(value['id']) &&
    isNonNegSafeInt(value['fromRev']) &&
    isNonNegSafeInt(value['completedSteps']) &&
    isNonNegSafeInt(value['totalSteps']) &&
    isDiagnosticsDelta(value['diagnostics'])
  );
}

function isSnapshotMediaState(v: unknown): v is SnapshotMediaState {
  return (
    isRecord(v) &&
    (v['kind'] === 'video' || v['kind'] === 'audio') &&
    isBool(v['paused']) &&
    isNonNegFinite(v['currentTime']) &&
    (v['duration'] === null || isNonNegFinite(v['duration'])) &&
    isNonNegFinite(v['width']) &&
    isNonNegFinite(v['height']) &&
    isBool(v['ready']) &&
    (v['error'] === null || isStr(v['error']))
  );
}

function isSnapshotCanvasState(v: unknown): v is SnapshotCanvasState {
  return (
    isRecord(v) &&
    isNonNegFinite(v['width']) &&
    isNonNegFinite(v['height']) &&
    isBool(v['nonBlank'])
  );
}

function isSnapshotNode(v: unknown): v is SnapshotNode {
  return (
    isRecord(v) &&
    isStr(v['role']) &&
    isStr(v['name']) &&
    (v['ref'] === undefined || isRefId(v['ref'])) &&
    isOptStr(v['driverId']) &&
    isOptStr(v['intent']) &&
    isOptStr(v['value']) &&
    isOptBool(v['checked']) &&
    isOptBool(v['disabled']) &&
    isOptBool(v['expanded']) &&
    (v['min'] === undefined || isFiniteNumber(v['min'])) &&
    (v['max'] === undefined || isFiniteNumber(v['max'])) &&
    (v['media'] === undefined || isSnapshotMediaState(v['media'])) &&
    (v['canvas'] === undefined || isSnapshotCanvasState(v['canvas'])) &&
    (v['children'] === undefined ||
      (Array.isArray(v['children']) && v['children'].every(isSnapshotNode)))
  );
}

function isSnapshotDiff(v: unknown): v is SnapshotDiff {
  return (
    isRecord(v) &&
    isNonNegSafeInt(v['fromRev']) &&
    isNonNegSafeInt(v['toRev']) &&
    isBool(v['fullReset']) &&
    Array.isArray(v['added']) &&
    v['added'].every(isSnapshotNode) &&
    Array.isArray(v['removed']) &&
    v['removed'].every(isRefId) &&
    Array.isArray(v['changed']) &&
    v['changed'].every(isSnapshotNode) &&
    (v['elements'] === undefined ||
      (Array.isArray(v['elements']) && v['elements'].every(isSnapshotNode)))
  );
}

export function isObservationSnapshot(value: unknown): value is ObservationSnapshot {
  if (!isRecord(value) || !isNonNegSafeInt(value['rev'])) return false;
  if (!isStr(value['url']) || !isStr(value['title'])) return false;
  const vp = value['viewport'];
  return (
    isRecord(vp) &&
    isNonNegFinite(vp['width']) &&
    isNonNegFinite(vp['height']) &&
    isDiagnosticsDelta(value['diagnostics']) &&
    Array.isArray(value['elements']) &&
    value['elements'].every(isSnapshotNode)
  );
}

export function isActResult(value: unknown): value is ActResult {
  if (!isRecord(value)) return false;
  const ir = value['interruptedReason'];
  return (
    isNonNegSafeInt(value['completedSteps']) &&
    isNonNegSafeInt(value['totalSteps']) &&
    (ir === undefined || isActInterruptionReason(ir)) &&
    isOptStr(value['error']) &&
    isNonNegSafeInt(value['rev']) &&
    isStr(value['url']) &&
    isStr(value['title']) &&
    isSnapshotDiff(value['diff']) &&
    isDiagnosticsDelta(value['diagnostics'])
  );
}

export function isCaptureResult(value: unknown): value is CaptureResult {
  return (
    isRecord(value) &&
    isStr(value['mimeType']) &&
    value['bytes'] instanceof Uint8Array &&
    isNonNegFinite(value['width']) &&
    isNonNegFinite(value['height']) &&
    isCaptureBackendMode(value['modeUsed']) &&
    isOptNonNegFinite(value['durationMs'])
  );
}

export function isEvalResult(value: unknown): value is EvalResult {
  return isRecord(value) && 'value' in value && isDiagnosticsDelta(value['diagnostics']);
}
