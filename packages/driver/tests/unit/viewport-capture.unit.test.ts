import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CaptureResult,
  type CaptureRpcParams,
  type DisplayMediaProvider,
  createHostCaptureSeam,
} from '../../src/index.js';

interface FakeVideoTrackOptions {
  readonly width?: number;
  readonly height?: number;
  readonly restrictTo?: (target: unknown) => Promise<void>;
  readonly cropTo?: (target: unknown) => Promise<void>;
}

interface FakeStreamHarness {
  readonly stream: MediaStream;
  readonly setReadyState: (state: MediaStreamTrackState) => void;
  readonly wasStopped: () => boolean;
}

function createFakeStreamHarness(options: FakeVideoTrackOptions = {}): FakeStreamHarness {
  let readyState: MediaStreamTrackState = 'live';
  let stopped = false;
  const width = options.width ?? 640;
  const height = options.height ?? 360;

  const track = {
    kind: 'video',
    get readyState(): MediaStreamTrackState {
      return readyState;
    },
    stop(): void {
      stopped = true;
      readyState = 'ended';
    },
    getSettings(): MediaTrackSettings {
      return { width, height };
    },
    ...(options.restrictTo !== undefined ? { restrictTo: options.restrictTo } : {}),
    ...(options.cropTo !== undefined ? { cropTo: options.cropTo } : {}),
  };

  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream; // Invariant: minimal MediaStream boundary test double for Node environment

  return {
    stream,
    setReadyState(state: MediaStreamTrackState): void {
      readyState = state;
    },
    wasStopped: () => stopped,
  };
}

function stubRasterGlobals(encodedBytes: Uint8Array): void {
  class FakeImageCapture {
    readonly track: MediaStreamTrack;
    constructor(track: MediaStreamTrack) {
      this.track = track;
    }
    async grabFrame(): Promise<{ width: number; height: number; close: () => void }> {
      const settings = this.track.getSettings();
      return {
        width: settings.width ?? 640,
        height: settings.height ?? 360,
        close(): void {},
      };
    }
  }

  class FakeOffscreenCanvas {
    readonly width: number;
    readonly height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext(): { drawImage: () => void } {
      return { drawImage(): void {} };
    }
    async convertToBlob(opts?: { type?: string }): Promise<Blob> {
      return new Blob([new Uint8Array(encodedBytes)], { type: opts?.type ?? 'image/webp' });
    }
  }

  vi.stubGlobal('ImageCapture', FakeImageCapture);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('host viewport capture seam', () => {
  it('negotiates captureModes from displayMediaProvider presence and delegates silent or element-targeted screenshots to preload', async () => {
    const receivedCalls: Array<{ params: CaptureRpcParams; aborted: boolean }> = [];
    const preloadResult: CaptureResult = {
      mimeType: 'image/webp',
      bytes: new Uint8Array([82, 73, 70, 70]),
      width: 320,
      height: 180,
      modeUsed: 'silent',
    };

    const requestPreloadCapture = async (
      params: CaptureRpcParams,
      signal?: AbortSignal,
    ): Promise<CaptureResult> => {
      receivedCalls.push({ params, aborted: Boolean(signal?.aborted) });
      return preloadResult;
    };

    const silentSeam = createHostCaptureSeam({ requestPreloadCapture });
    expect(silentSeam.captureModes).toEqual(['silent']);

    const silentShot = await silentSeam.capture({
      mode: 'screenshot',
      format: 'webp',
      quality: 0.8,
    });
    expect(silentShot).toEqual(preloadResult);
    expect(receivedCalls).toEqual([
      {
        params: { mode: 'screenshot', format: 'webp', quality: 0.8 },
        aborted: false,
      },
    ]);

    let displayMediaCalls = 0;
    const displayMediaProvider: DisplayMediaProvider = {
      async getDisplayMedia(): Promise<MediaStream> {
        displayMediaCalls += 1;
        throw new Error('getDisplayMedia should not run for element-targeted screenshot');
      },
    };

    const gpuCapableSeam = createHostCaptureSeam({
      displayMediaProvider,
      requestPreloadCapture,
    });
    expect(gpuCapableSeam.captureModes).toEqual(['silent', 'viewport-gpu']);

    const targetedShot = await gpuCapableSeam.capture({
      mode: 'screenshot',
      target: 'e4',
      format: 'png',
    });
    expect(targetedShot).toEqual(preloadResult);
    expect(displayMediaCalls).toBe(0);
    expect(receivedCalls[1]).toEqual({
      params: { mode: 'screenshot', target: 'e4', format: 'png' },
      aborted: false,
    });
  });

  it('prefers RestrictionTarget over CropTarget, reuses live GPU streams, and re-acquires ended streams', async () => {
    stubRasterGlobals(new Uint8Array([137, 80, 78, 71]));
    const fakeIframe = { tagName: 'IFRAME' } as unknown as HTMLIFrameElement; // Invariant: minimal iframe identity token for RestrictionTarget/CropTarget boundary

    const events: string[] = [];
    vi.stubGlobal('RestrictionTarget', {
      async fromElement(el: Element): Promise<unknown> {
        events.push(`RestrictionTarget.fromElement:${String(el === fakeIframe)}`);
        return { kind: 'restriction-token' };
      },
    });
    vi.stubGlobal('CropTarget', {
      async fromElement(el: Element): Promise<unknown> {
        events.push(`CropTarget.fromElement:${String(el === fakeIframe)}`);
        return { kind: 'crop-token' };
      },
    });

    const firstHarness = createFakeStreamHarness({
      width: 800,
      height: 450,
      async restrictTo(target: unknown): Promise<void> {
        events.push(`track1.restrictTo:${JSON.stringify(target)}`);
      },
      async cropTo(target: unknown): Promise<void> {
        events.push(`track1.cropTo:${JSON.stringify(target)}`);
      },
    });

    const secondHarness = createFakeStreamHarness({
      width: 1024,
      height: 576,
      async cropTo(target: unknown): Promise<void> {
        events.push(`track2.cropTo:${JSON.stringify(target)}`);
      },
    });

    let getDisplayMediaCount = 0;
    const receivedConstraints: Array<DisplayMediaStreamOptions | undefined> = [];
    const displayMediaProvider: DisplayMediaProvider = {
      async getDisplayMedia(constraints?: DisplayMediaStreamOptions): Promise<MediaStream> {
        getDisplayMediaCount += 1;
        receivedConstraints.push(constraints);
        return getDisplayMediaCount === 1 ? firstHarness.stream : secondHarness.stream;
      },
    };

    const seam = createHostCaptureSeam({
      iframe: fakeIframe,
      displayMediaProvider,
      async requestPreloadCapture(): Promise<CaptureResult> {
        throw new Error('unexpected silent preload fallback');
      },
    });

    const shot1 = await seam.capture({ mode: 'screenshot', format: 'png' });
    expect(shot1).toEqual({
      mimeType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71]),
      width: 800,
      height: 450,
      modeUsed: 'viewport-gpu',
    });
    expect(getDisplayMediaCount).toBe(1);
    expect(receivedConstraints[0]).toEqual({
      video: true,
      audio: false,
      preferCurrentTab: true,
    });
    expect(events).toEqual([
      'RestrictionTarget.fromElement:true',
      'track1.restrictTo:{"kind":"restriction-token"}',
    ]);

    // Second screenshot reuses live stream without re-calling getDisplayMedia or restrictTo
    const shot2 = await seam.capture({ mode: 'screenshot' });
    expect(shot2.mimeType).toBe('image/webp');
    expect(shot2.modeUsed).toBe('viewport-gpu');
    expect(getDisplayMediaCount).toBe(1);
    expect(events).toHaveLength(2);

    // When track ends and RestrictionTarget is unavailable on track2, re-acquires and uses CropTarget
    firstHarness.setReadyState('ended');
    const shot3 = await seam.capture({ mode: 'screenshot', format: 'webp', quality: 0.9 });
    expect(shot3.width).toBe(1024);
    expect(shot3.height).toBe(576);
    expect(shot3.modeUsed).toBe('viewport-gpu');
    expect(getDisplayMediaCount).toBe(2);
    expect(events).toEqual([
      'RestrictionTarget.fromElement:true',
      'track1.restrictTo:{"kind":"restriction-token"}',
      'CropTarget.fromElement:true',
      'track2.cropTo:{"kind":"crop-token"}',
    ]);
  });

  it('falls back to silent preload capture on permission denial and enforces start/stop recording state machine', async () => {
    const preloadResult: CaptureResult = {
      mimeType: 'image/webp',
      bytes: new Uint8Array([1, 2, 3, 4]),
      width: 480,
      height: 270,
      modeUsed: 'silent',
    };

    const deniedSeam = createHostCaptureSeam({
      displayMediaProvider: {
        async getDisplayMedia(): Promise<MediaStream> {
          throw new DOMException('Permission denied by user', 'NotAllowedError');
        },
      },
      async requestPreloadCapture(): Promise<CaptureResult> {
        return preloadResult;
      },
    });

    const fallbackShot = await deniedSeam.capture({ mode: 'screenshot' });
    expect(fallbackShot).toEqual(preloadResult);

    // Stopping when no recording is active throws DRIVER_PROTOCOL
    await expect(deniedSeam.capture({ mode: 'stop_recording' })).rejects.toMatchObject({
      name: 'DriverError',
      code: 'DRIVER_PROTOCOL',
    });

    // GPU MediaRecorder lifecycle with multi-chunk WebM concatenation
    const webmHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    const webmCluster = new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0x99]);
    let recorderState: RecordingState = 'inactive';

    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(mimeType: string): boolean {
        return mimeType.startsWith('video/webm');
      }
      readonly stream: MediaStream;
      constructor(stream: MediaStream) {
        super();
        this.stream = stream;
      }
      get state(): RecordingState {
        return recorderState;
      }
      start(): void {
        recorderState = 'recording';
        const headerEvent = Object.assign(new Event('dataavailable'), {
          data: new Blob([new Uint8Array(webmHeader)], { type: 'video/webm' }),
        });
        this.dispatchEvent(headerEvent);
      }
      requestData(): void {}
      stop(): void {
        recorderState = 'inactive';
        const clusterEvent = Object.assign(new Event('dataavailable'), {
          data: new Blob([new Uint8Array(webmCluster)], { type: 'video/webm' }),
        });
        this.dispatchEvent(clusterEvent);
        this.dispatchEvent(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const streamHarness = createFakeStreamHarness({ width: 720, height: 405 });
    const gpuSeam = createHostCaptureSeam({
      displayMediaProvider: {
        async getDisplayMedia(): Promise<MediaStream> {
          return streamHarness.stream;
        },
      },
      async requestPreloadCapture(): Promise<CaptureResult> {
        return preloadResult;
      },
    });

    const started = await gpuSeam.capture({ mode: 'start_recording' });
    expect(started).toEqual({
      mimeType: 'video/webm',
      bytes: new Uint8Array(0),
      width: 720,
      height: 405,
      modeUsed: 'viewport-gpu',
      durationMs: 0,
    });

    // Double start_recording throws DRIVER_PROTOCOL
    await expect(gpuSeam.capture({ mode: 'start_recording' })).rejects.toMatchObject({
      name: 'DriverError',
      code: 'DRIVER_PROTOCOL',
    });

    const stopped = await gpuSeam.capture({ mode: 'stop_recording' });
    expect(stopped.mimeType).toBe('video/webm');
    expect(stopped.modeUsed).toBe('viewport-gpu');
    expect(stopped.width).toBe(720);
    expect(stopped.height).toBe(405);
    expect(Array.from(stopped.bytes)).toEqual([
      0x1a, 0x45, 0xdf, 0xa3, 0x1f, 0x43, 0xb6, 0x75, 0x99,
    ]);
    expect(stopped.durationMs).toBeGreaterThanOrEqual(0);
    // GPU stream remains live for reuse until dispose()
    expect(streamHarness.wasStopped()).toBe(false);

    // Stopping again after stop_recording throws DRIVER_PROTOCOL
    await expect(gpuSeam.capture({ mode: 'stop_recording' })).rejects.toMatchObject({
      name: 'DriverError',
      code: 'DRIVER_PROTOCOL',
    });
  });

  it('stops active MediaRecorder and acquired MediaStream tracks on dispose, including mid-restriction teardown and RestrictionTarget rejection fallback', async () => {
    stubRasterGlobals(new Uint8Array([82, 73, 70, 70]));
    const fakeIframe = { tagName: 'IFRAME' } as unknown as HTMLIFrameElement; // Invariant: minimal iframe identity token for RestrictionTarget/CropTarget boundary

    let cropCalled = false;
    vi.stubGlobal('RestrictionTarget', {
      async fromElement(): Promise<unknown> {
        throw new Error('Element not eligible for RestrictionTarget');
      },
    });
    vi.stubGlobal('CropTarget', {
      async fromElement(): Promise<unknown> {
        return { kind: 'fallback-crop' };
      },
    });

    let recorderStoppedCount = 0;
    class ActiveFakeMediaRecorder extends EventTarget {
      state: RecordingState = 'inactive';
      start(): void {
        this.state = 'recording';
      }
      stop(): void {
        recorderStoppedCount += 1;
        this.state = 'inactive';
      }
    }
    vi.stubGlobal('MediaRecorder', ActiveFakeMediaRecorder);

    const activeHarness = createFakeStreamHarness({
      width: 640,
      height: 360,
      async restrictTo(): Promise<void> {},
      async cropTo(): Promise<void> {
        cropCalled = true;
      },
    });

    const seam = createHostCaptureSeam({
      iframe: fakeIframe,
      displayMediaProvider: {
        async getDisplayMedia(): Promise<MediaStream> {
          return activeHarness.stream;
        },
      },
      async requestPreloadCapture(): Promise<CaptureResult> {
        throw new Error('unexpected preload call');
      },
    });

    await seam.capture({ mode: 'start_recording' });
    expect(cropCalled).toBe(true);
    expect(activeHarness.wasStopped()).toBe(false);

    seam.dispose();
    seam.dispose(); // Idempotent
    expect(recorderStoppedCount).toBe(1);
    expect(activeHarness.wasStopped()).toBe(true);
    await expect(seam.capture({ mode: 'screenshot' })).rejects.toMatchObject({
      code: 'DRIVER_DISPOSED',
    });

    // Mid-scoping dispose race: dispose() called while RestrictionTarget.fromElement is still pending
    const gate: { resolve: (val: unknown) => void } = { resolve: () => {} };
    vi.stubGlobal('RestrictionTarget', {
      fromElement(): Promise<unknown> {
        return new Promise((resolve) => {
          gate.resolve = resolve;
        });
      },
    });

    const inFlightHarness = createFakeStreamHarness({
      async restrictTo(): Promise<void> {},
    });

    const racingSeam = createHostCaptureSeam({
      iframe: fakeIframe,
      displayMediaProvider: {
        async getDisplayMedia(): Promise<MediaStream> {
          return inFlightHarness.stream;
        },
      },
      async requestPreloadCapture(): Promise<CaptureResult> {
        throw new Error('unexpected preload call');
      },
    });

    const pendingShot = racingSeam.capture({ mode: 'screenshot' });
    await Promise.resolve();
    racingSeam.dispose();
    gate.resolve({ kind: 'late-token' });

    await expect(pendingShot).rejects.toMatchObject({
      name: 'DriverError',
      code: 'DRIVER_DISPOSED',
    });
    expect(inFlightHarness.wasStopped()).toBe(true);
  });
});
