import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRemoteContainerBridgeEnv } from './env.js';
import { startBridgeHostServer } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '..');
const viteEntry = fileURLToPath(import.meta.resolve('vite'));
const viteBin = resolve(dirname(viteEntry), '..', '..', 'bin', 'vite.js');
const { provider, bridgePort, uiPort, allowedOrigins } = readRemoteContainerBridgeEnv();
const uiUrl = `http://127.0.0.1:${uiPort}/`;

const bridge = await startBridgeHostServer({
  provider,
  port: bridgePort,
  allowedOrigins,
  uiUrl,
});

const vite = Bun.spawn(
  ['node', viteBin, '--host', '0.0.0.0', '--port', String(uiPort), '--strictPort'],
  {
    cwd: exampleRoot,
    env: {
      ...process.env,
      REMOTE_CONTAINER_BRIDGE_TARGET: `http://127.0.0.1:${bridgePort}`,
      REMOTE_CONTAINER_UI_PORT: String(uiPort),
    },
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

console.log(`remote container bridge API listening on http://127.0.0.1:${bridge.port}`);
console.log(`remote container bridge UI listening on ${uiUrl}`);
console.log(`provider=${provider.kind}`);

vite.exited.then(async (code) => {
  await bridge.closeSessions();
  bridge.stop(true);
  if (code !== 0) process.exit(code);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    vite.kill(signal);
    await bridge.closeSessions();
    bridge.stop(true);
    process.exit(0);
  });
}
