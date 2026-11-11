import type { CaptureRpcParams } from '../protocol.js';
import type {
  CaptureBackendMode,
  CaptureOptions,
  CaptureResult,
  DisplayMediaProvider,
} from '../types.js';
import { createViewportCapture } from './viewport-capture.js';

export interface HostCaptureSeamContext {
  readonly iframe?: HTMLIFrameElement;
  readonly displayMediaProvider?: DisplayMediaProvider;
  readonly requestPreloadCapture: (
    params: CaptureRpcParams,
    signal?: AbortSignal,
  ) => Promise<CaptureResult>;
}

export interface HostCaptureSeam {
  readonly captureModes: readonly CaptureBackendMode[];
  capture(options: CaptureOptions): Promise<CaptureResult>;
  dispose(): void;
}

/**
 * Creates the host-side visual capture seam supporting silent preload screenshots,
 * optional DisplayMediaProvider GPU frame capture, and WebM MediaRecorder sessions.
 */
export function createHostCaptureSeam(context: HostCaptureSeamContext): HostCaptureSeam {
  return createViewportCapture(context);
}
