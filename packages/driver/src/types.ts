/**
 * Frozen public and cross-lane contracts for `@inbrowser/driver`.
 *
 * Zero imports so both browser host bundles and the isolated preload IIFE can
 * depend on these contracts without pulling external runtime code.
 */

export type RefId = `e${number}`;

export type SnapshotRevision = number;

export interface SemanticFingerprint {
  readonly role: string;
  readonly name: string;
  readonly landmark?: string;
  readonly driverId?: string;
  readonly nth: number;
}

export type TargetSpec =
  | RefId
  | {
      readonly role: string;
      readonly name?: string;
      readonly nth?: number;
    }
  | {
      readonly driver: string;
      readonly nth?: number;
    }
  | {
      readonly text: string;
      readonly exact?: boolean;
    };

export interface SnapshotMediaState {
  readonly kind: 'video' | 'audio';
  readonly paused: boolean;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly width: number;
  readonly height: number;
  readonly ready: boolean;
  readonly error: string | null;
}

export interface SnapshotCanvasState {
  readonly width: number;
  readonly height: number;
  readonly nonBlank: boolean;
}

export interface SnapshotNode {
  readonly role: string;
  readonly name: string;
  readonly ref?: RefId;
  readonly driverId?: string;
  readonly intent?: string;
  readonly value?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly media?: SnapshotMediaState;
  readonly canvas?: SnapshotCanvasState;
  readonly children?: readonly SnapshotNode[];
}

export interface NetworkFailure {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
}

export interface DiagnosticsDelta {
  readonly compileOverlay: string | null;
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly networkFailures: readonly NetworkFailure[];
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ObservationOptions {
  readonly scope?: string;
  readonly includeAllText?: boolean;
  readonly signal?: AbortSignal;
}

export interface ObservationSnapshot {
  readonly rev: SnapshotRevision;
  readonly url: string;
  readonly title: string;
  readonly viewport: ViewportSize;
  readonly diagnostics: DiagnosticsDelta;
  readonly elements: readonly SnapshotNode[];
}

export interface ClickStep {
  readonly kind: 'click';
  readonly target: TargetSpec;
  readonly button?: 'left' | 'middle' | 'right';
  readonly clickCount?: number;
}

export interface FillStep {
  readonly kind: 'fill';
  readonly target: TargetSpec;
  readonly value: string;
  readonly submit?: boolean;
}

export interface SetValueStep {
  readonly kind: 'setValue';
  readonly target: TargetSpec;
  readonly value: string | number;
}

export interface SelectStep {
  readonly kind: 'select';
  readonly target: TargetSpec;
  readonly value: string | readonly string[];
}

export interface PressStep {
  readonly kind: 'press';
  readonly key: string;
  readonly target?: TargetSpec;
}

export type DragDestination =
  | { readonly target: TargetSpec }
  | { readonly deltaX: number; readonly deltaY: number }
  | { readonly clientX: number; readonly clientY: number };

export interface DragStep {
  readonly kind: 'drag';
  readonly from: TargetSpec;
  readonly to: DragDestination;
  readonly steps?: number;
}

export type NavigateStep =
  | {
      readonly kind: 'navigate';
      readonly url: string;
    }
  | {
      readonly kind: 'navigate';
      readonly action: 'reload' | 'back' | 'forward';
    };

export interface WaitForStep {
  readonly kind: 'waitFor';
  readonly target?: TargetSpec;
  readonly text?: string;
  readonly state?: 'attached' | 'visible' | 'hidden' | 'detached';
  readonly idleMs?: number;
  readonly timeoutMs?: number;
}

export type DriverStep =
  | ClickStep
  | FillStep
  | SetValueStep
  | SelectStep
  | PressStep
  | DragStep
  | NavigateStep
  | WaitForStep;

export type ActInterruptionReason =
  | 'step_error'
  | 'dialog_opened'
  | 'compile_error'
  | 'navigation'
  | 'user_takeover';

export interface SnapshotDiff {
  readonly fromRev: SnapshotRevision;
  readonly toRev: SnapshotRevision;
  readonly fullReset: boolean;
  readonly added: readonly SnapshotNode[];
  readonly removed: readonly RefId[];
  readonly changed: readonly SnapshotNode[];
  readonly elements?: readonly SnapshotNode[];
}

export interface ActOptions {
  readonly rev: SnapshotRevision;
  readonly steps: readonly DriverStep[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ActResult {
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly interruptedReason?: ActInterruptionReason;
  readonly error?: string;
  readonly rev: SnapshotRevision;
  readonly url: string;
  readonly title: string;
  readonly diff: SnapshotDiff;
  readonly diagnostics: DiagnosticsDelta;
}

export type CaptureBackendMode = 'silent' | 'viewport-gpu';

export interface ScreenshotCaptureOptions {
  readonly mode: 'screenshot';
  readonly target?: TargetSpec;
  readonly format?: 'webp' | 'png';
  readonly quality?: number;
  readonly signal?: AbortSignal;
}

export interface StartRecordingCaptureOptions {
  readonly mode: 'start_recording';
  readonly signal?: AbortSignal;
}

export interface StopRecordingCaptureOptions {
  readonly mode: 'stop_recording';
  readonly signal?: AbortSignal;
}

export type CaptureOptions =
  | ScreenshotCaptureOptions
  | StartRecordingCaptureOptions
  | StopRecordingCaptureOptions;

export interface CaptureResult {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly modeUsed: CaptureBackendMode;
  readonly durationMs?: number;
}

export interface EvalOptions {
  readonly expression: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface EvalResult {
  readonly value: unknown;
  readonly diagnostics: DiagnosticsDelta;
}

export interface DriverCapabilities {
  readonly protocolVersion: 1;
  readonly allowEval: boolean;
  readonly captureModes: readonly CaptureBackendMode[];
  readonly trustedInput: boolean;
}

export interface PageDriver {
  readonly capabilities: DriverCapabilities;
  observe(options?: ObservationOptions): Promise<ObservationSnapshot>;
  act(options: ActOptions): Promise<ActResult>;
  capture(options: CaptureOptions): Promise<CaptureResult>;
  eval(options: EvalOptions): Promise<EvalResult>;
  dispose(): void;
}

export type DriverErrorCode =
  | 'DRIVER_TIMEOUT'
  | 'DRIVER_DISPOSED'
  | 'DRIVER_PROTOCOL'
  | 'DRIVER_UNSUPPORTED'
  | 'DRIVER_TARGET_NOT_FOUND'
  | 'DRIVER_TARGET_AMBIGUOUS'
  | 'DRIVER_EVAL_DISABLED';

export interface DriverErrorOptions {
  readonly cause?: unknown;
  readonly candidates?: readonly SemanticFingerprint[];
}

export class DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly candidates?: readonly SemanticFingerprint[];

  constructor(code: DriverErrorCode, message: string, options?: DriverErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DriverError';
    this.code = code;
    if (options?.candidates !== undefined) {
      this.candidates = options.candidates;
    }
  }
}

export interface DisplayMediaProvider {
  getDisplayMedia(constraints?: DisplayMediaStreamOptions): Promise<MediaStream>;
}

export interface ConnectPortOptions {
  readonly handshakeTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly allowEval?: boolean;
  readonly displayMediaProvider?: DisplayMediaProvider;
  readonly onPortReplacement?: (rebind: (port: MessagePort) => void) => () => void;
  readonly signal?: AbortSignal;
}

export interface ConnectIframeOptions extends ConnectPortOptions {
  readonly targetOrigin?: string;
}

export type DriverJsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, DriverJsonSchema>;
  required?: string[];
  items?: DriverJsonSchema | DriverJsonSchema[];
  enum?: unknown[];
  [key: string]: unknown;
};

export interface DriverToolExecutionContext {
  readonly signal?: AbortSignal;
}

export interface DriverToolResult<D = unknown> {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: D;
}

export interface DriverTool<A = unknown, D = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: DriverJsonSchema;
  readonly parallelSafe?: false;
  readonly pure?: false;
  execute(args: A, ctx?: DriverToolExecutionContext): Promise<DriverToolResult<D>>;
}
