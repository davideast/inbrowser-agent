import type { StartRemoteContainerBridgeOptions } from '@inbrowser/sandbox/remote/host';
import { createFakeContainerProvider } from './providers/fake.js';

export interface RemoteContainerBridgeEnv {
  bridgeOptions: StartRemoteContainerBridgeOptions;
  providerName: string;
  bridgePort: number;
  uiPort: number;
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

  const bridgeOptions: StartRemoteContainerBridgeOptions = {
    image,
    provider: providerName === 'fake' ? createFakeContainerProvider() : 'auto',
    host: 'auto',
    port: bridgePort,
    allowedOrigins,
  };

  return { bridgeOptions, providerName, bridgePort, uiPort, image };
}
