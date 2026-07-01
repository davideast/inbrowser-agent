import { createAppleContainerProvider } from './providers/apple-container.js';
import { createFakeContainerProvider } from './providers/fake.js';
import type { ContainerSandboxProvider } from './providers/types.js';

export interface RemoteContainerBridgeEnv {
  provider: ContainerSandboxProvider;
  providerName: string;
  bridgePort: number;
  uiPort: number;
  allowedOrigins: string[];
  image: string;
}

export function readRemoteContainerBridgeEnv(): RemoteContainerBridgeEnv {
  const providerName = process.env.REMOTE_CONTAINER_PROVIDER ?? 'apple';
  const bridgePort = Number(process.env.PORT ?? process.env.REMOTE_CONTAINER_BRIDGE_PORT ?? 8790);
  const uiPort = Number(process.env.REMOTE_CONTAINER_UI_PORT ?? 5184);
  const image = process.env.REMOTE_CONTAINER_IMAGE ?? 'ubuntu:latest';
  const explicitOrigins = process.env.REMOTE_CONTAINER_BRIDGE_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const uiOrigins = [`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`];
  const allowedOrigins = explicitOrigins?.length ? explicitOrigins : uiOrigins;

  const provider =
    providerName === 'apple'
      ? createAppleContainerProvider({ image })
      : createFakeContainerProvider();

  return { provider, providerName, bridgePort, uiPort, allowedOrigins, image };
}
