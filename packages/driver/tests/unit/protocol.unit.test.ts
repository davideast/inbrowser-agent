import { describe, expect, it } from 'vitest';
import {
  DRIVER_CHANNEL,
  PROTOCOL_VERSION,
  isActResult,
  isCaptureResult,
  isDriverBindPort,
  isDriverChannelEnvelope,
  isDriverHello,
  isDriverHelloAck,
  isDriverNavigating,
  isDriverRpcRequest,
  isDriverRpcResponse,
  isObservationSnapshot,
} from '../../src/protocol.js';

describe('wire protocol envelope guards', () => {
  it('exposes frozen channel namespace and protocol version 1', () => {
    expect(DRIVER_CHANNEL).toBe('@inbrowser/driver:v1');
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('distinguishes driver channel envelopes from unrelated postMessage traffic', () => {
    expect(isDriverChannelEnvelope({ channel: '@inbrowser/driver:v1', kind: 'hello' })).toBe(true);
    expect(isDriverChannelEnvelope(null)).toBe(false);
    expect(isDriverChannelEnvelope(['@inbrowser/driver:v1'])).toBe(false);
    expect(isDriverChannelEnvelope({ channel: 'vite:hmr', type: 'update' })).toBe(false);
  });

  it('accepts valid hello and bind_port envelopes and rejects wrong version or missing fields', () => {
    expect(
      isDriverHello({
        channel: '@inbrowser/driver:v1',
        kind: 'hello',
        protocolVersion: 1,
        allowEval: false,
      }),
    ).toBe(true);

    expect(
      isDriverBindPort({
        channel: '@inbrowser/driver:v1',
        kind: 'bind_port',
        protocolVersion: 1,
      }),
    ).toBe(true);

    expect(
      isDriverHello({
        channel: '@inbrowser/driver:v1',
        kind: 'hello',
        protocolVersion: 2,
        allowEval: false,
      }),
    ).toBe(false);

    expect(
      isDriverHello({
        channel: '@inbrowser/driver:v2',
        kind: 'hello',
        protocolVersion: 1,
        allowEval: false,
      }),
    ).toBe(false);

    expect(
      isDriverHello({
        channel: '@inbrowser/driver:v1',
        kind: 'hello',
        protocolVersion: 1,
        allowEval: 'yes',
      }),
    ).toBe(false);
  });

  it('validates hello_ack capabilities shape strictly', () => {
    expect(
      isDriverHelloAck({
        channel: '@inbrowser/driver:v1',
        kind: 'hello_ack',
        protocolVersion: 1,
        capabilities: {
          protocolVersion: 1,
          allowEval: true,
          captureModes: ['silent', 'viewport-gpu'],
          trustedInput: false,
        },
      }),
    ).toBe(true);

    expect(
      isDriverHelloAck({
        channel: '@inbrowser/driver:v1',
        kind: 'hello_ack',
        protocolVersion: 1,
        capabilities: {
          protocolVersion: 1,
          allowEval: true,
          captureModes: ['unknown-mode'],
          trustedInput: false,
        },
      }),
    ).toBe(false);
  });

  it('validates rpc_request envelopes across observe, act, capture, and eval methods', () => {
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 1,
        method: 'observe',
        params: { scope: 'main', includeAllText: false },
      }),
    ).toBe(true);

    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 2,
        method: 'act',
        params: {
          rev: 4,
          steps: [
            { kind: 'click', target: 'e1' },
            { kind: 'fill', target: 'e2', value: 'clip-01', submit: true },
            { kind: 'navigate', action: 'back' },
            { kind: 'navigate', url: '/items' },
            { kind: 'waitFor', text: 'Ready', timeoutMs: 1000 },
            { kind: 'waitFor', idleMs: 150 },
          ],
        },
      }),
    ).toBe(true);

    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 3,
        method: 'capture',
        params: { mode: 'screenshot', format: 'webp' },
      }),
    ).toBe(true);

    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 4,
        method: 'eval',
        params: { expression: 'document.title' },
      }),
    ).toBe(true);

    // Reject non-positive or non-integer request IDs
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 0,
        method: 'observe',
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 1.5,
        method: 'observe',
      }),
    ).toBe(false);

    // Reject unknown method or malformed method params
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 5,
        method: 'destroyEverything',
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 6,
        method: 'act',
        params: { rev: 'not-a-number', steps: [] },
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 7,
        method: 'eval',
        params: { expression: 42 },
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 8,
        method: 'act',
        params: { rev: 1, steps: [{ kind: 'unknownStep', target: 'e1' }] },
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 9,
        method: 'capture',
        params: { mode: 'screenshot', target: 'invalid-ref' },
      }),
    ).toBe(false);

    // Reject invalid FillStep.submit, ambiguous/empty NavigateStep, empty WaitForStep, and NaN/Infinity numeric fields
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 10,
        method: 'act',
        params: { rev: 1, steps: [{ kind: 'fill', target: 'e1', value: 'abc', submit: 'yes' }] },
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 11,
        method: 'act',
        params: { rev: 1, steps: [{ kind: 'navigate' }] },
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 12,
        method: 'act',
        params: { rev: 1, steps: [{ kind: 'navigate', url: '/items', action: 'reload' }] },
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 13,
        method: 'act',
        params: { rev: 1, steps: [{ kind: 'waitFor' }] },
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 14,
        method: 'act',
        params: {
          rev: 1,
          steps: [{ kind: 'drag', from: 'e1', to: { deltaX: Number.NaN, deltaY: 10 } }],
        },
      }),
    ).toBe(false);
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 15,
        method: 'capture',
        params: { mode: 'screenshot', quality: Number.POSITIVE_INFINITY },
      }),
    ).toBe(false);
  });

  it('validates rpc_response success and coded error envelopes', () => {
    expect(
      isDriverRpcResponse({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_response',
        protocolVersion: 1,
        id: 1,
        ok: true,
        result: { value: 'Timeline', diagnostics: null },
      }),
    ).toBe(true);

    expect(
      isDriverRpcResponse({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_response',
        protocolVersion: 1,
        id: 2,
        ok: false,
        error: {
          code: 'DRIVER_TARGET_AMBIGUOUS',
          message: 'Matched 2 buttons named Play',
          candidates: [{ role: 'button', name: 'Play', landmark: 'player', nth: 0 }],
        },
      }),
    ).toBe(true);

    // Reject unknown DriverErrorCode or missing result property
    expect(
      isDriverRpcResponse({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_response',
        protocolVersion: 1,
        id: 3,
        ok: false,
        error: {
          code: 'UNKNOWN_CODE',
          message: 'bad code',
        },
      }),
    ).toBe(false);

    expect(
      isDriverRpcResponse({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_response',
        protocolVersion: 1,
        id: 4,
        ok: true,
      }),
    ).toBe(false);
  });

  it('validates ObservationSnapshot, ActResult, and CaptureResult wire payloads including optional SnapshotNode fields and finite numbers', () => {
    const validBaseSnapshot = {
      rev: 1,
      url: 'http://localhost:4701/frame',
      title: 'Player Workspace',
      viewport: { width: 1280, height: 720 },
      diagnostics: {
        compileOverlay: null,
        consoleErrors: [],
        pageErrors: [],
        networkFailures: [{ method: 'GET', url: '/api/items', status: 500, statusText: 'Error' }],
      },
      elements: [
        {
          role: 'region',
          name: 'player',
          ref: 'e1',
          expanded: true,
          children: [
            {
              role: 'slider',
              name: 'timeline',
              ref: 'e2',
              value: '12.5',
              min: 0,
              max: 60,
              disabled: false,
            },
            {
              role: 'video',
              name: 'preview',
              ref: 'e3',
              media: {
                kind: 'video',
                paused: true,
                currentTime: 0,
                duration: null,
                width: 640,
                height: 360,
                ready: true,
                error: null,
              },
            },
            {
              role: 'canvas',
              name: 'waveform',
              canvas: { width: 640, height: 80, nonBlank: true },
            },
          ],
        },
      ],
    };

    expect(isObservationSnapshot(validBaseSnapshot)).toBe(true);

    // Reject NaN viewport dimensions
    expect(
      isObservationSnapshot({
        ...validBaseSnapshot,
        viewport: { width: Number.NaN, height: 720 },
      }),
    ).toBe(false);

    // Reject malformed optional SnapshotNode properties (bad ref, non-boolean checked, NaN media duration, invalid canvas)
    expect(
      isObservationSnapshot({
        ...validBaseSnapshot,
        elements: [{ role: 'button', name: 'Play', ref: 'bad-ref' }],
      }),
    ).toBe(false);
    expect(
      isObservationSnapshot({
        ...validBaseSnapshot,
        elements: [{ role: 'checkbox', name: 'Mute', checked: 'yes' }],
      }),
    ).toBe(false);
    expect(
      isObservationSnapshot({
        ...validBaseSnapshot,
        elements: [
          {
            role: 'video',
            name: 'preview',
            media: {
              kind: 'video',
              paused: false,
              currentTime: 1,
              duration: Number.POSITIVE_INFINITY,
              width: 640,
              height: 360,
              ready: true,
              error: null,
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isObservationSnapshot({
        ...validBaseSnapshot,
        elements: [
          {
            role: 'canvas',
            name: 'waveform',
            canvas: { width: 640, height: 80, nonBlank: 'true' },
          },
        ],
      }),
    ).toBe(false);

    // Reject ActResult with malformed changed node ref and CaptureResult with NaN dimensions
    expect(
      isActResult({
        completedSteps: 1,
        totalSteps: 1,
        rev: 2,
        url: 'http://localhost:4701/frame',
        title: 'Player Workspace',
        diff: {
          fromRev: 1,
          toRev: 2,
          fullReset: false,
          added: [],
          removed: [],
          changed: [{ role: 'slider', name: 'timeline', min: Number.NaN }],
        },
        diagnostics: validBaseSnapshot.diagnostics,
      }),
    ).toBe(false);

    expect(
      isCaptureResult({
        mimeType: 'image/webp',
        bytes: new Uint8Array([1, 2, 3]),
        width: 800,
        height: 600,
        modeUsed: 'silent',
        durationMs: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
  });

  it('validates cross-navigation hello continuity fields and navigating notifications', () => {
    expect(
      isDriverHello({
        channel: '@inbrowser/driver:v1',
        kind: 'hello',
        protocolVersion: 1,
        allowEval: true,
        sessionId: 'drv-1-abc',
        rebindOnlyIfUnbound: true,
        minRev: 7,
      }),
    ).toBe(true);

    expect(
      isDriverHello({
        channel: '@inbrowser/driver:v1',
        kind: 'hello',
        protocolVersion: 1,
        allowEval: false,
        minRev: -1,
      }),
    ).toBe(false);

    expect(
      isDriverNavigating({
        channel: '@inbrowser/driver:v1',
        kind: 'navigating',
        protocolVersion: 1,
        id: 3,
        fromRev: 4,
        completedSteps: 1,
        totalSteps: 2,
        diagnostics: {
          compileOverlay: null,
          consoleErrors: ['leaving'],
          pageErrors: [],
          networkFailures: [],
        },
      }),
    ).toBe(true);

    expect(
      isDriverNavigating({
        channel: '@inbrowser/driver:v1',
        kind: 'navigating',
        protocolVersion: 1,
        id: 0,
        fromRev: 4,
        completedSteps: 1,
        totalSteps: 2,
        diagnostics: {
          compileOverlay: null,
          consoleErrors: [],
          pageErrors: [],
          networkFailures: [],
        },
      }),
    ).toBe(false);
  });

  it('validates driver target specs and SnapshotNode driverId/intent fields across protocol envelopes', () => {
    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 9,
        method: 'act',
        params: {
          rev: 2,
          steps: [
            { kind: 'click', target: { driver: 'inspector.issue', nth: 0 } },
            { kind: 'fill', target: { driver: 'editor.source' }, value: 'ok' },
          ],
        },
      }),
    ).toBe(true);

    expect(
      isDriverRpcRequest({
        channel: '@inbrowser/driver:v1',
        kind: 'rpc_request',
        protocolVersion: 1,
        id: 10,
        method: 'act',
        params: {
          rev: 2,
          steps: [{ kind: 'click', target: { driver: '', nth: 0 } }],
        },
      }),
    ).toBe(false);

    expect(
      isObservationSnapshot({
        rev: 1,
        url: 'http://localhost:4700/frame',
        title: 'Stage',
        viewport: { width: 800, height: 600 },
        diagnostics: {
          compileOverlay: null,
          consoleErrors: [],
          pageErrors: [],
          networkFailures: [],
        },
        elements: [
          {
            role: 'button',
            name: 'Reset',
            ref: 'e1',
            driverId: 'toolbar.reset',
            intent: 'Resets sample fixture',
          },
        ],
      }),
    ).toBe(true);

    expect(
      isObservationSnapshot({
        rev: 1,
        url: 'http://localhost:4700/frame',
        title: 'Stage',
        viewport: { width: 800, height: 600 },
        diagnostics: {
          compileOverlay: null,
          consoleErrors: [],
          pageErrors: [],
          networkFailures: [],
        },
        elements: [
          {
            role: 'button',
            name: 'Reset',
            ref: 'e1',
            driverId: 42,
          },
        ],
      }),
    ).toBe(false);
  });
});
