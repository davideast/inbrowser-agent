import type { CaptureRpcParams } from '../protocol.js';
import {
  type CaptureBackendMode,
  type CaptureOptions,
  type CaptureResult,
  DriverError,
  type ScreenshotCaptureOptions,
} from '../types.js';
import type { HostCaptureSeam, HostCaptureSeamContext } from './capture-seam.js';

const SILENT_RECORDING_INTERVAL_MS = 80;
const RECORDER_TIMESLICE_MS = 80;

interface PreferCurrentTabDisplayMediaOptions extends DisplayMediaStreamOptions {
  readonly preferCurrentTab?: boolean;
}

interface ElementTargetFactory {
  fromElement(element: Element): Promise<unknown>;
}

interface GrabbedBitmapLike {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close?: () => void;
}

interface ActiveRecordingSession {
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly width: number;
  readonly height: number;
  readonly modeUsed: CaptureBackendMode;
  readonly startedAtMs: number;
  readonly ownedStream: MediaStream | null;
  readonly flushFinalFrame: () => void;
  readonly stopPolling: () => void;
  rejectPendingStop: ((err: DriverError) => void) | null;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function isObjectOrFunction(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function getElementTargetFactory(
  globalName: 'RestrictionTarget' | 'CropTarget',
): ElementTargetFactory | null {
  const candidate: unknown = Reflect.get(globalThis, globalName);
  if (!isObjectOrFunction(candidate)) {
    return null;
  }
  const fromElement: unknown = Reflect.get(candidate, 'fromElement');
  if (typeof fromElement !== 'function') {
    return null;
  }
  return {
    async fromElement(element: Element): Promise<unknown> {
      const result: unknown = Reflect.apply(fromElement, candidate, [element]);
      return Promise.resolve(result);
    },
  };
}

function getTrackMethod(
  track: MediaStreamTrack,
  methodName: 'restrictTo' | 'cropTo',
): ((target: unknown) => Promise<void>) | null {
  const fn: unknown = Reflect.get(track, methodName);
  if (typeof fn !== 'function') {
    return null;
  }
  return async (target: unknown): Promise<void> => {
    const result: unknown = Reflect.apply(fn, track, [target]);
    await Promise.resolve(result);
  };
}

async function scopeTrackToIframe(
  track: MediaStreamTrack,
  iframe: HTMLIFrameElement,
): Promise<void> {
  const restrictionFactory = getElementTargetFactory('RestrictionTarget');
  const restrictTo = getTrackMethod(track, 'restrictTo');
  if (restrictionFactory !== null && restrictTo !== null) {
    try {
      const token = await restrictionFactory.fromElement(iframe);
      await restrictTo(token);
      return;
    } catch {
      // Fall through to CropTarget if Element Capture fails on this track/element.
    }
  }

  const cropFactory = getElementTargetFactory('CropTarget');
  const cropTo = getTrackMethod(track, 'cropTo');
  if (cropFactory !== null && cropTo !== null) {
    try {
      const token = await cropFactory.fromElement(iframe);
      await cropTo(token);
    } catch {
      // Proceed with uncropped stream when track does not permit Region Capture.
    }
  }
}

function stopStreamTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore already-stopped track errors.
    }
  }
}

function requestCanvasTrackFrame(stream: MediaStream): void {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    return;
  }
  const reqFrame: unknown = Reflect.get(track, 'requestFrame');
  if (typeof reqFrame === 'function') {
    try {
      Reflect.apply(reqFrame, track, []);
    } catch {
      // Ignore if track ended.
    }
  }
}

function selectWebmRecorderOptions(): MediaRecorderOptions | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  for (const candidate of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return { mimeType: candidate };
    }
  }
  return undefined;
}

function createWebmRecorder(stream: MediaStream): MediaRecorder {
  if (typeof MediaRecorder !== 'function') {
    throw new DriverError(
      'DRIVER_UNSUPPORTED',
      'MediaRecorder is unavailable in this environment.',
    );
  }
  const recorderOptions = selectWebmRecorderOptions();
  return recorderOptions !== undefined
    ? new MediaRecorder(stream, recorderOptions)
    : new MediaRecorder(stream);
}

async function drawEncodedBytesToContext(
  ctx: CanvasRenderingContext2D,
  bytes: Uint8Array,
  mimeType: string,
  width: number,
  height: number,
): Promise<void> {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob);
    try {
      ctx.drawImage(bmp, 0, 0, width, height);
    } finally {
      bmp.close();
    }
    return;
  }
  if (typeof Image === 'function' && typeof URL !== 'undefined') {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = objectUrl;
      await img.decode();
      ctx.drawImage(img, 0, 0, width, height);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

async function grabViaImageCapture(track: MediaStreamTrack): Promise<GrabbedBitmapLike | null> {
  const ctor: unknown = Reflect.get(globalThis, 'ImageCapture');
  if (typeof ctor !== 'function') {
    return null;
  }
  try {
    const instance: unknown = Reflect.construct(ctor, [track]);
    if (!isObjectOrFunction(instance)) {
      return null;
    }
    const grabFrame: unknown = Reflect.get(instance, 'grabFrame');
    if (typeof grabFrame !== 'function') {
      return null;
    }
    const rawBitmap: unknown = await Promise.resolve(Reflect.apply(grabFrame, instance, []));
    if (!isObjectOrFunction(rawBitmap)) {
      return null;
    }
    const width: unknown = Reflect.get(rawBitmap, 'width');
    const height: unknown = Reflect.get(rawBitmap, 'height');
    if (typeof width !== 'number' || typeof height !== 'number') {
      return null;
    }
    const closeFn: unknown = Reflect.get(rawBitmap, 'close');
    return {
      source: rawBitmap as unknown as CanvasImageSource, // Invariant: ImageCapture.grabFrame resolves to an ImageBitmap CanvasImageSource
      width,
      height,
      ...(typeof closeFn === 'function'
        ? {
            close(): void {
              Reflect.apply(closeFn, rawBitmap, []);
            },
          }
        : {}),
    };
  } catch {
    return null;
  }
}

async function encodeSourceToBytes(
  source: CanvasImageSource,
  width: number,
  height: number,
  mimeType: 'image/webp' | 'image/png',
  quality: number,
): Promise<Uint8Array | null> {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));

  try {
    if (typeof OffscreenCanvas === 'function') {
      const offscreen = new OffscreenCanvas(safeWidth, safeHeight);
      const ctx = offscreen.getContext('2d');
      if (ctx === null) {
        return null;
      }
      ctx.drawImage(source, 0, 0, safeWidth, safeHeight);
      const blob = await offscreen.convertToBlob({ type: mimeType, quality });
      return new Uint8Array(await blob.arrayBuffer());
    }

    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = safeWidth;
      canvas.height = safeHeight;
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        return null;
      }
      ctx.drawImage(source, 0, 0, safeWidth, safeHeight);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((result) => resolve(result), mimeType, quality);
      });
      if (blob === null) {
        return null;
      }
      return new Uint8Array(await blob.arrayBuffer());
    }
  } catch {
    return null;
  }

  return null;
}

function stripScreenshotOptions(options: ScreenshotCaptureOptions): CaptureRpcParams {
  return {
    mode: 'screenshot',
    ...(options.target !== undefined ? { target: options.target } : {}),
    ...(options.format !== undefined ? { format: options.format } : {}),
    ...(options.quality !== undefined ? { quality: options.quality } : {}),
  };
}

function extractBlobEventData(event: Event): Blob | null {
  const rawData: unknown = Reflect.get(event, 'data');
  return rawData instanceof Blob && rawData.size > 0 ? rawData : null;
}

async function concatenateRecordingChunks(chunks: readonly Blob[]): Promise<Uint8Array> {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  const combined = new Blob([...chunks], { type: 'video/webm' });
  return new Uint8Array(await combined.arrayBuffer());
}

export function createViewportCapture(context: HostCaptureSeamContext): HostCaptureSeam {
  const captureModes: readonly CaptureBackendMode[] =
    context.displayMediaProvider !== undefined ? ['silent', 'viewport-gpu'] : ['silent'];
  const scopedTracks = new WeakSet<MediaStreamTrack>();

  let disposed = false;
  let gpuStream: MediaStream | null = null;
  let gpuVideoEl: HTMLVideoElement | null = null;
  let acquiringStream: Promise<MediaStream | null> | null = null;
  let activeRecording: ActiveRecordingSession | null = null;
  let startingRecording = false;

  const assertOperational = (signal?: AbortSignal): void => {
    if (disposed) {
      throw new DriverError('DRIVER_DISPOSED', 'Capture seam has been disposed.');
    }
    if (signal?.aborted) {
      throw new DriverError('DRIVER_TIMEOUT', "Driver 'capture' operation aborted by signal.", {
        cause: signal.reason,
      });
    }
  };

  const releaseGpuResources = (): void => {
    if (gpuVideoEl !== null) {
      gpuVideoEl.pause();
      gpuVideoEl.srcObject = null;
      gpuVideoEl = null;
    }
    if (gpuStream !== null) {
      stopStreamTracks(gpuStream);
      gpuStream = null;
    }
  };

  const abortActiveRecordingOnDispose = (): void => {
    const session = activeRecording;
    activeRecording = null;
    if (session === null) {
      return;
    }
    session.stopPolling();
    try {
      if (session.recorder.state !== 'inactive') {
        session.recorder.stop();
      }
    } catch {
      // Ignore recorder teardown errors during dispose.
    }
    if (session.ownedStream !== null) {
      stopStreamTracks(session.ownedStream);
    }
    session.rejectPendingStop?.(
      new DriverError('DRIVER_DISPOSED', 'Driver was disposed before recording completed.'),
    );
    session.rejectPendingStop = null;
  };

  const ensureGpuVideoReady = async (stream: MediaStream): Promise<HTMLVideoElement | null> => {
    if (typeof document === 'undefined') {
      return null;
    }
    if (gpuVideoEl === null) {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      gpuVideoEl = v;
    }
    if (gpuVideoEl.srcObject !== stream) {
      gpuVideoEl.srcObject = stream;
    }
    if (gpuVideoEl.readyState < 2) {
      try {
        await gpuVideoEl.play();
      } catch {
        // Wait for loadeddata if play() rejected or resolved before metadata/frame ready.
      }
      if (gpuVideoEl.readyState < 2) {
        await new Promise<void>((resolve) => {
          const video = gpuVideoEl;
          if (!video || video.readyState >= 2) {
            resolve();
            return;
          }
          const done = (): void => {
            clearTimeout(timer);
            video.removeEventListener('loadeddata', done);
            resolve();
          };
          const timer = setTimeout(done, 400);
          video.addEventListener('loadeddata', done, { once: true });
        });
      }
    }
    return gpuVideoEl !== null && gpuVideoEl.readyState >= 2 ? gpuVideoEl : null;
  };

  const acquireGpuStream = async (): Promise<MediaStream | null> => {
    if (context.displayMediaProvider === undefined) {
      return null;
    }
    if (gpuStream !== null) {
      const existingTrack = gpuStream.getVideoTracks()[0];
      if (existingTrack !== undefined && existingTrack.readyState === 'live') {
        return gpuStream;
      }
      releaseGpuResources();
    }
    if (acquiringStream !== null) {
      return acquiringStream;
    }

    const provider = context.displayMediaProvider;
    const runAcquire = async (): Promise<MediaStream | null> => {
      const constraints: PreferCurrentTabDisplayMediaOptions = {
        video: true,
        audio: false,
        preferCurrentTab: true,
      };

      let acquired: MediaStream;
      try {
        acquired = await provider.getDisplayMedia(constraints);
      } catch {
        return null;
      }

      if (disposed) {
        stopStreamTracks(acquired);
        throw new DriverError('DRIVER_DISPOSED', 'Capture seam has been disposed.');
      }

      const videoTrack = acquired.getVideoTracks()[0];
      if (videoTrack === undefined || videoTrack.readyState !== 'live') {
        stopStreamTracks(acquired);
        return null;
      }

      if (context.iframe !== undefined && !scopedTracks.has(videoTrack)) {
        scopedTracks.add(videoTrack);
        await scopeTrackToIframe(videoTrack, context.iframe);
        if (disposed) {
          stopStreamTracks(acquired);
          throw new DriverError('DRIVER_DISPOSED', 'Capture seam has been disposed.');
        }
      }

      gpuStream = acquired;
      return acquired;
    };

    const pending = runAcquire().finally(() => {
      if (acquiringStream === pending) {
        acquiringStream = null;
      }
    });
    acquiringStream = pending;
    return pending;
  };

  const captureGpuScreenshot = async (
    stream: MediaStream,
    options: ScreenshotCaptureOptions,
  ): Promise<CaptureResult | null> => {
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack === undefined || videoTrack.readyState !== 'live') {
      return null;
    }

    const mimeType = options.format === 'png' ? 'image/png' : 'image/webp';
    const quality = options.quality ?? 0.85;

    if (gpuVideoEl !== null && gpuVideoEl.srcObject === stream && gpuVideoEl.readyState >= 2) {
      const w = Math.max(1, gpuVideoEl.videoWidth || context.iframe?.clientWidth || 800);
      const h = Math.max(1, gpuVideoEl.videoHeight || context.iframe?.clientHeight || 600);
      const bytes = await encodeSourceToBytes(gpuVideoEl, w, h, mimeType, quality);
      if (bytes !== null) {
        return { mimeType, bytes, width: w, height: h, modeUsed: 'viewport-gpu' };
      }
    }

    const bitmap = await grabViaImageCapture(videoTrack);
    if (bitmap !== null) {
      try {
        const w = Math.max(1, Math.round(bitmap.width));
        const h = Math.max(1, Math.round(bitmap.height));
        const bytes = await encodeSourceToBytes(bitmap.source, w, h, mimeType, quality);
        if (bytes !== null) {
          return { mimeType, bytes, width: w, height: h, modeUsed: 'viewport-gpu' };
        }
      } finally {
        bitmap.close?.();
      }
    }

    const video = await ensureGpuVideoReady(stream);
    if (video !== null) {
      const settings = videoTrack.getSettings();
      const w = Math.max(
        1,
        video.videoWidth || settings.width || context.iframe?.clientWidth || 800,
      );
      const h = Math.max(
        1,
        video.videoHeight || settings.height || context.iframe?.clientHeight || 600,
      );
      const bytes = await encodeSourceToBytes(video, w, h, mimeType, quality);
      if (bytes !== null) {
        return { mimeType, bytes, width: w, height: h, modeUsed: 'viewport-gpu' };
      }
    }

    return null;
  };

  const startGpuRecording = (stream: MediaStream): CaptureResult => {
    const videoTrack = stream.getVideoTracks()[0];
    const settings = videoTrack?.getSettings();
    const width = Math.max(
      1,
      Math.round(
        settings?.width ??
          context.iframe?.clientWidth ??
          (typeof window !== 'undefined' ? window.innerWidth : 0) ??
          800,
      ),
    );
    const height = Math.max(
      1,
      Math.round(
        settings?.height ??
          context.iframe?.clientHeight ??
          (typeof window !== 'undefined' ? window.innerHeight : 0) ??
          600,
      ),
    );

    const recorder = createWebmRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event: Event) => {
      const blob = extractBlobEventData(event);
      if (blob !== null) {
        chunks.push(blob);
      }
    });
    recorder.start(RECORDER_TIMESLICE_MS);

    activeRecording = {
      recorder,
      chunks,
      width,
      height,
      modeUsed: 'viewport-gpu',
      startedAtMs: nowMs(),
      ownedStream: null,
      flushFinalFrame: () => {
        requestCanvasTrackFrame(stream);
      },
      stopPolling: () => {},
      rejectPendingStop: null,
    };

    return {
      mimeType: 'video/webm',
      bytes: new Uint8Array(0),
      width,
      height,
      modeUsed: 'viewport-gpu',
      durationMs: 0,
    };
  };

  const startSilentRecording = async (signal?: AbortSignal): Promise<CaptureResult> => {
    if (typeof document === 'undefined' || typeof MediaRecorder !== 'function') {
      throw new DriverError(
        'DRIVER_UNSUPPORTED',
        'Silent video recording requires browser canvas and MediaRecorder support.',
      );
    }

    const initialFrame = await context.requestPreloadCapture(
      { mode: 'screenshot', format: 'webp', quality: 0.8 },
      signal,
    );
    assertOperational(signal);

    const width = Math.max(1, Math.round(initialFrame.width));
    const height = Math.max(1, Math.round(initialFrame.height));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx === null || typeof canvas.captureStream !== 'function') {
      throw new DriverError(
        'DRIVER_UNSUPPORTED',
        'Canvas stream recording is unavailable in this environment.',
      );
    }

    const stream = canvas.captureStream(30);
    let recorder: MediaRecorder;
    try {
      recorder = createWebmRecorder(stream);
    } catch (err) {
      stopStreamTracks(stream);
      throw err;
    }

    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event: Event) => {
      const blob = extractBlobEventData(event);
      if (blob !== null) {
        chunks.push(blob);
      }
    });

    recorder.start(RECORDER_TIMESLICE_MS);
    await drawEncodedBytesToContext(
      ctx,
      initialFrame.bytes,
      initialFrame.mimeType,
      width,
      height,
    ).catch(() => {});
    requestCanvasTrackFrame(stream);

    let pollingStopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNextFrame = (): void => {
      if (pollingStopped || disposed) {
        return;
      }
      pollTimer = setTimeout(() => {
        pollTimer = null;
        if (pollingStopped || disposed) {
          return;
        }
        void context
          .requestPreloadCapture({ mode: 'screenshot', format: 'webp', quality: 0.8 })
          .then((frame) => {
            if (pollingStopped || disposed) {
              return;
            }
            return drawEncodedBytesToContext(ctx, frame.bytes, frame.mimeType, width, height).then(
              () => {
                requestCanvasTrackFrame(stream);
              },
            );
          })
          .catch(() => {})
          .finally(() => {
            scheduleNextFrame();
          });
      }, SILENT_RECORDING_INTERVAL_MS);
    };

    scheduleNextFrame();

    const stopPolling = (): void => {
      pollingStopped = true;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    activeRecording = {
      recorder,
      chunks,
      width,
      height,
      modeUsed: 'silent',
      startedAtMs: nowMs(),
      ownedStream: stream,
      flushFinalFrame: () => {
        ctx.drawImage(canvas, 0, 0);
        requestCanvasTrackFrame(stream);
      },
      stopPolling,
      rejectPendingStop: null,
    };

    return {
      mimeType: 'video/webm',
      bytes: new Uint8Array(0),
      width,
      height,
      modeUsed: 'silent',
      durationMs: 0,
    };
  };

  const stopRecordingSession = async (signal?: AbortSignal): Promise<CaptureResult> => {
    if (activeRecording === null) {
      throw new DriverError('DRIVER_PROTOCOL', 'No active recording session to stop.');
    }

    const session = activeRecording;
    activeRecording = null;
    session.stopPolling();
    session.flushFinalFrame();

    try {
      if (session.recorder.state !== 'inactive') {
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            session.recorder.removeEventListener('stop', onStop);
            session.recorder.removeEventListener('error', onError);
            signal?.removeEventListener('abort', onAbort);
            session.rejectPendingStop = null;
          };

          const onStop = (): void => {
            cleanup();
            resolve();
          };

          const onError = (): void => {
            cleanup();
            reject(new DriverError('DRIVER_PROTOCOL', 'MediaRecorder failed while stopping.'));
          };

          const onAbort = (): void => {
            cleanup();
            reject(
              new DriverError('DRIVER_TIMEOUT', "Driver 'capture' operation aborted by signal.", {
                cause: signal?.reason,
              }),
            );
          };

          session.rejectPendingStop = (err: DriverError): void => {
            cleanup();
            reject(err);
          };

          session.recorder.addEventListener('stop', onStop, { once: true });
          session.recorder.addEventListener('error', onError, { once: true });
          signal?.addEventListener('abort', onAbort, { once: true });

          try {
            if (typeof session.recorder.requestData === 'function') {
              session.recorder.requestData();
            }
          } catch {
            // Ignore requestData errors prior to stop.
          }
          session.recorder.stop();
        });
      }

      assertOperational(signal);
      const bytes = await concatenateRecordingChunks(session.chunks);
      const durationMs = Math.max(0, Math.round(nowMs() - session.startedAtMs));

      return {
        mimeType: 'video/webm',
        bytes,
        width: session.width,
        height: session.height,
        modeUsed: session.modeUsed,
        durationMs,
      };
    } finally {
      if (session.ownedStream !== null) {
        stopStreamTracks(session.ownedStream);
      }
    }
  };

  return {
    captureModes,
    async capture(options: CaptureOptions): Promise<CaptureResult> {
      assertOperational(options.signal);

      if (options.mode === 'screenshot') {
        const rpcParams = stripScreenshotOptions(options);
        if (options.target === undefined && context.displayMediaProvider !== undefined) {
          const stream = await acquireGpuStream();
          assertOperational(options.signal);
          if (stream !== null) {
            const gpuResult = await captureGpuScreenshot(stream, options);
            if (gpuResult !== null) {
              return gpuResult;
            }
          }
        }
        return context.requestPreloadCapture(rpcParams, options.signal);
      }

      if (options.mode === 'start_recording') {
        if (activeRecording !== null || startingRecording) {
          throw new DriverError('DRIVER_PROTOCOL', 'A recording session is already active.');
        }
        startingRecording = true;
        try {
          if (context.displayMediaProvider !== undefined) {
            const stream = await acquireGpuStream();
            assertOperational(options.signal);
            if (stream !== null) {
              return startGpuRecording(stream);
            }
          }
          return await startSilentRecording(options.signal);
        } finally {
          startingRecording = false;
        }
      }

      return stopRecordingSession(options.signal);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      abortActiveRecordingOnDispose();
      releaseGpuResources();
    },
  };
}
