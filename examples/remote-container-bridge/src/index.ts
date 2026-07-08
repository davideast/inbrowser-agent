import { startRemoteContainerBridge } from '@inbrowser/sandbox/remote/host';
import { readRemoteContainerBridgeEnv } from './env.js';

const { bridgeOptions } = readRemoteContainerBridgeEnv();

const bridge = await startRemoteContainerBridge(bridgeOptions);

console.log(`remote container bridge listening on ${bridge.origin}${bridge.bridgeUrl}`);
console.log(`remote container bridge API available at ${bridge.origin}`);
console.log(`provider=${bridge.provider} host=${bridge.host}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await bridge.stop();
    process.exit(0);
  });
}
