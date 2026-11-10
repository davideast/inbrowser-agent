import { VERSION, encoder, fault } from './protocol';

export const MAX_PREVIEW_CLIENT_SCRIPT_BYTES = 256 * 1024;
export const PREVIEW_CLIENT_PATH = '/__inbrowser__/preview-client.js';

export interface PreviewClientRouteFields {
  containerId?: string;
  port?: number;
}

export function validatePreviewClientScript(clientScript: unknown): string | undefined {
  if (clientScript === undefined) return undefined;
  if (typeof clientScript !== 'string') {
    throw fault('EINVAL', 'Invalid clientScript: expected string');
  }
  const actual = encoder.encode(clientScript).byteLength;
  if (actual > MAX_PREVIEW_CLIENT_SCRIPT_BYTES) {
    throw fault(
      'E2BIG',
      `Invalid clientScript: exceeds maximum size of ${MAX_PREVIEW_CLIENT_SCRIPT_BYTES} bytes`,
      { limit: MAX_PREVIEW_CLIENT_SCRIPT_BYTES, actual },
    );
  }
  return clientScript;
}

export function buildPreviewClientBundle(
  clientScript: string,
  routeFields: PreviewClientRouteFields = {},
): string {
  const envelope: Record<string, string | number> = {
    type: 'preview-client',
    version: VERSION,
    ...(routeFields.containerId !== undefined ? { containerId: routeFields.containerId } : {}),
    ...(routeFields.port !== undefined ? { port: routeFields.port } : {}),
  };
  const prelude =
    `(() => {\n` +
    `  const sw = typeof navigator === 'object' && navigator !== null ? navigator.serviceWorker : undefined;\n` +
    `  const controller = sw ? sw.controller : null;\n` +
    `  if (!controller) return;\n` +
    `  const channel = new MessageChannel();\n` +
    `  controller.postMessage(Object.assign(${JSON.stringify(envelope)}, { origin: location.origin }), [channel.port2]);\n` +
    `  Object.defineProperty(globalThis, '__inbrowserPreviewPort', {\n` +
    `    value: channel.port1,\n` +
    `    writable: true,\n` +
    `    configurable: true,\n` +
    `  });\n` +
    `})();`;
  return `${prelude}\n;\n${clientScript}\n`;
}
