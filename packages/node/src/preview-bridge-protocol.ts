import { VERSION, record } from './protocol';

// Messages between the host page, the hidden bridge document on a preview
// origin, and that origin's service worker (design §5(a) and §7.1). The bridge
// protocol has its own version; every message also carries the preview frame
// protocol VERSION, because the worker speaks the frames of src/preview-stream.ts.
//
//   bridge -> host page    need-port | failed | closed           (window.postMessage)
//   host page -> bridge    port (+ MessagePort) | close          (window.postMessage)
//   bridge -> worker       port (+ MessagePort), forwarded as received
//   worker -> bridge       need-port                             (Client.postMessage)
//   page -> worker         socket (+ MessagePort)                (src/preview-origin-socket.ts)
//   worker -> host page    ready | refused | http (+ port) | socket (+ port) | alive (+ reply port)
//   host page -> worker    alive (reply) | closed                (on the bridge port)

export const PREVIEW_BRIDGE_VERSION = 1;
/** The bridge document every preview origin serves. */
export const PREVIEW_BRIDGE_PATH = '/__inbrowser__/bridge.html';
/** The WebSocket bridge script, which the preview worker serves itself. */
export const PREVIEW_SOCKET_PATH = '/__inbrowser__/preview-socket.js';
/** The preview worker script, at the origin root so it may control `/`. */
export const PREVIEW_WORKER_PATH = '/__inbrowser_preview_sw.js';
/** Ports one bridge may be issued over its lifetime (first issue plus reissues). */
export const PREVIEW_BRIDGE_PORT_ISSUES = 256;
/** How long teardown waits for a bridge to unregister its worker. */
export const PREVIEW_BRIDGE_CLOSE_MS = 1000;

export type BridgeMessageType =
  | 'need-port'
  | 'failed'
  | 'closed'
  | 'port'
  | 'close'
  | 'ready'
  | 'refused'
  | 'alive';

export function bridgeMessage(
  type: BridgeMessageType,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...fields, type, bridge: PREVIEW_BRIDGE_VERSION, version: VERSION };
}

/** The message's type when it is a bridge message of this version, else undefined. */
export function readBridgeMessage(
  value: unknown,
): { type: string; versionMatch: boolean; data: Record<string, unknown> } | undefined {
  if (!record(value) || typeof value.type !== 'string' || typeof value.bridge !== 'number') return;
  return {
    type: value.type,
    versionMatch: value.bridge === PREVIEW_BRIDGE_VERSION && value.version === VERSION,
    data: value,
  };
}
