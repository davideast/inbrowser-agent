import { appleContainerProviderFactory } from '../apple-container/index.js';
import { bunBridgeHostAdapterFactory } from '../bun/index.js';
import { nodeBridgeHostAdapterFactory } from '../node/index.js';
import { createWebSocketBridgeProvider } from '../websocket.js';
import { DEFAULT_BRIDGE_PORT, DEFAULT_BRIDGE_ROOT } from './core.js';
import type {
  BridgeHostAdapter,
  BridgeHostAdapterFactory,
  ContainerProviderFactory,
  ContainerSandboxProvider,
  DetectionResult,
  RemoteContainerBridge,
  StartRemoteContainerBridgeOptions,
} from './types.js';

const DEFAULT_CONTAINER_PREFIX = 'inbrowser-';

export async function startRemoteContainerBridge(
  options: StartRemoteContainerBridgeOptions,
): Promise<RemoteContainerBridge> {
  const root = options.root ?? DEFAULT_BRIDGE_ROOT;
  const provider = await resolveContainerProvider(options);
  const hostAdapter = await resolveHostAdapter(options);
  const server = await hostAdapter.start({
    provider,
    port: options.port ?? DEFAULT_BRIDGE_PORT,
    hostname: options.hostname,
    token: options.token,
    root,
    uiUrl: options.uiUrl,
    allowedOrigins: options.allowedOrigins,
    cleanupStaleSessions: options.cleanupStaleSessions,
  });

  return {
    provider: provider.kind,
    host: hostAdapter.kind,
    get origin() {
      return server.bridgeOrigin;
    },
    bridgeUrl: server.bridgeUrl,
    statusUrl: server.statusUrl,
    token: server.bridgeToken,
    root,
    clientConfig() {
      return {
        provider: provider.kind,
        host: hostAdapter.kind,
        bridgeUrl: server.bridgeUrl,
        statusUrl: server.statusUrl,
        token: server.bridgeToken,
        root,
      };
    },
    createWebSocketProvider() {
      return createWebSocketBridgeProvider({
        url: toWebSocketUrl(new URL(server.bridgeUrl, server.bridgeOrigin)),
        token: server.bridgeToken,
      });
    },
    status() {
      return server.hostStatus();
    },
    closeSessions() {
      return server.closeSessions();
    },
    stop() {
      return server.stop();
    },
  };
}

async function resolveContainerProvider(
  options: StartRemoteContainerBridgeOptions,
): Promise<ContainerSandboxProvider> {
  const requested = options.provider ?? 'auto';
  if (isContainerProvider(requested)) return requested;

  const factories = [...(options.providers ?? []), appleContainerProviderFactory].sort(
    (a, b) => b.priority - a.priority,
  );
  const context = {
    image: options.image,
    containerBin: options.containerBin,
    commandRunner: options.commandRunner,
  };

  if (requested !== 'auto') {
    const factory = factories.find((candidate) => candidate.kind === requested);
    if (!factory) {
      throw new Error(
        `Unknown remote container provider: ${requested}. Available providers: ${factories
          .map((candidate) => candidate.kind)
          .join(', ')}`,
      );
    }
    const detection = await factory.detect(context);
    if (!detection.available) {
      throw new Error(
        `Remote container provider ${factory.kind} is unavailable: ${detection.reason ?? 'unknown reason'}`,
      );
    }
    return factory.create(providerOptions(options));
  }

  const checked: Array<{ factory: ContainerProviderFactory; detection: DetectionResult }> = [];
  for (const factory of factories) {
    const detection = await factory.detect(context);
    checked.push({ factory, detection });
    if (detection.available) return factory.create(providerOptions(options));
  }
  throw new Error(formatDetectionFailure('No remote container provider available.', checked));
}

async function resolveHostAdapter(
  options: StartRemoteContainerBridgeOptions,
): Promise<BridgeHostAdapter> {
  const requested = options.host ?? 'auto';
  if (isBridgeHostAdapter(requested)) return requested;

  const factories = [
    ...(options.hosts ?? []),
    bunBridgeHostAdapterFactory,
    nodeBridgeHostAdapterFactory,
  ].sort((a, b) => b.priority - a.priority);

  if (requested !== 'auto') {
    const factory = factories.find((candidate) => candidate.kind === requested);
    if (!factory) {
      throw new Error(
        `Unknown remote container host: ${requested}. Available hosts: ${factories
          .map((candidate) => candidate.kind)
          .join(', ')}`,
      );
    }
    const detection = await factory.detect();
    if (!detection.available) {
      throw new Error(
        `Remote container host ${factory.kind} is unavailable: ${detection.reason ?? 'unknown reason'}`,
      );
    }
    return factory.create();
  }

  const checked: Array<{ factory: BridgeHostAdapterFactory; detection: DetectionResult }> = [];
  for (const factory of factories) {
    const detection = await factory.detect();
    checked.push({ factory, detection });
    if (detection.available) return factory.create();
  }
  throw new Error(formatDetectionFailure('No remote container host available.', checked));
}

function providerOptions(options: StartRemoteContainerBridgeOptions) {
  return {
    image: options.image,
    containerBin: options.containerBin,
    namePrefix: options.namePrefix ?? DEFAULT_CONTAINER_PREFIX,
    maxBufferedOutputChars: options.maxBufferedOutputChars,
    commandRunner: options.commandRunner,
  };
}

function isContainerProvider(value: unknown): value is ContainerSandboxProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'ensureReady' in value &&
    'createSession' in value
  );
}

function isBridgeHostAdapter(value: unknown): value is BridgeHostAdapter {
  return typeof value === 'object' && value !== null && 'kind' in value && 'start' in value;
}

function formatDetectionFailure(
  heading: string,
  checked: readonly {
    factory: { kind: string };
    detection: DetectionResult;
  }[],
): string {
  const rows = checked.map(
    ({ factory, detection }) =>
      `- ${factory.kind}: ${detection.available ? 'available' : 'unavailable'}${
        detection.reason ? `, ${detection.reason}` : ''
      }`,
  );
  return `${heading}\n\nChecked:\n${rows.join('\n')}`;
}

function toWebSocketUrl(url: URL): string {
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export type {
  BridgeHostAdapter,
  BridgeHostAdapterFactory,
  BridgeHostServer,
  BridgeHostServerOptions,
  ContainerExposedPort,
  ContainerHostDiagnostic,
  ContainerProviderFactory,
  ContainerProcessOutput,
  ContainerRunOptions,
  ContainerSandboxProvider,
  ContainerSession,
  ContainerSessionOptions,
  DetectionResult,
  HostCommandResult,
  HostCommandRunner,
  HostCommandRunOptions,
  ProviderDetectionContext,
  RemoteContainerBridge,
  RemoteContainerBridgeClientConfig,
  ResolvedContainerProviderOptions,
  StartRemoteContainerBridgeOptions,
} from './types.js';
