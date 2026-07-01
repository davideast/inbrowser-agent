import { readRemoteContainerBridgeEnv } from './env.js';
import { startBridgeHostServer } from './server.js';

const { provider, bridgePort, allowedOrigins } = readRemoteContainerBridgeEnv();

const server = await startBridgeHostServer({ provider, port: bridgePort, allowedOrigins });

console.log(
  `remote container bridge listening on ws://127.0.0.1:${server.port} (${provider.kind})`,
);
console.log(`remote container bridge API available at http://127.0.0.1:${server.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await server.closeSessions();
    server.stop(true);
    process.exit(0);
  });
}
