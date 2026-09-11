import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRemoteContainerBridge } from '@inbrowser/sandbox/remote/host';
import { readRemoteContainerBridgeEnv } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '..');
const viteEntry = fileURLToPath(import.meta.resolve('vite'));
const viteBin = resolve(dirname(viteEntry), '..', '..', 'bin', 'vite.js');
const { bridgeOptions, uiPort } = readRemoteContainerBridgeEnv();
const uiUrl = `http://127.0.0.1:${uiPort}/`;

const transport = process.env.REMOTE_CONTAINER_TRANSPORT ?? 'websocket';
if (transport !== 'websocket' && transport !== 'firebase-rtdb')
  throw new Error('REMOTE_CONTAINER_TRANSPORT must be websocket or firebase-rtdb');
const bridge =
  transport === 'firebase-rtdb'
    ? (await import('./firebase-host.js')).bridge
    : await startRemoteContainerBridge({ ...bridgeOptions, uiUrl });
const origin = 'origin' in bridge ? bridge.origin : '';

const vite = Bun.spawn(
  ['node', viteBin, '--host', '0.0.0.0', '--port', String(uiPort), '--strictPort'],
  {
    cwd: exampleRoot,
    env: {
      ...process.env,
      REMOTE_CONTAINER_BRIDGE_TARGET: origin,
      VITE_REMOTE_CONTAINER_TRANSPORT: transport,
      REMOTE_CONTAINER_UI_PORT: String(uiPort),
    },
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

if (origin) console.log(`remote container bridge API listening on ${origin}`);
console.log(`remote container bridge UI listening on ${uiUrl}`);
console.log(`transport=${transport}`);

vite.exited.then(async (code) => {
  await bridge.stop();
  if (code !== 0) process.exit(code);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    vite.kill(signal);
    await bridge.stop();
    process.exit(0);
  });
}
