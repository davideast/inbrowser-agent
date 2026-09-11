import { test } from 'bun:test';
import { startBunBridgeHostServer } from '../src/remote/bun/index.js';
import { createRemoteSandbox, createWebSocketBridgeProvider } from '../src/remote/index.js';
import { startNodeBridgeHostServer } from '../src/remote/node/index.js';
import { trackingProvider } from './helpers/container.js';
import { remoteContract } from './helpers/remote-contract.js';
for (const start of [startBunBridgeHostServer, startNodeBridgeHostServer]) {
  test(`shared executor contract over ${start.name}`, async () => {
    const tracked = trackingProvider();
    const host = await start({ provider: tracked.provider, port: 0, token: 'contract-token' });
    try {
      const sandbox = await createRemoteSandbox({
        id: 'contract',
        requestTimeoutMs: 1000,
        transport: createWebSocketBridgeProvider({
          url: `ws://127.0.0.1:${host.port}/bridge`,
          token: 'contract-token',
        }),
      });
      try {
        await remoteContract(sandbox);
      } finally {
        sandbox.destroy();
      }
    } finally {
      await host.stop();
    }
  });
}
