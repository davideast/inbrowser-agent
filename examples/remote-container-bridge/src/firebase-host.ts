import { resolve } from 'node:path';
import { createAppleContainerProvider } from '@inbrowser/sandbox/remote/apple-container';
import { startFirebaseRtdbBridge } from '@inbrowser/sandbox/remote/firebase/rtdb/host';
import { firebaseClients } from './firebase-config.js';
import { createFakeContainerProvider } from './providers/fake.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}; see the Firebase example README`);
  return value;
}
const clients = await firebaseClients(
  JSON.parse(required('FIREBASE_CONFIG')),
  required('FIREBASE_EXECUTOR_EMAIL'),
  required('FIREBASE_EXECUTOR_PASSWORD'),
);
const executorId = process.env.FIREBASE_EXECUTOR_ID ?? 'demo';
const provider =
  process.env.REMOTE_CONTAINER_PROVIDER === 'fake'
    ? createFakeContainerProvider()
    : createAppleContainerProvider({
        image: process.env.REMOTE_CONTAINER_IMAGE ?? 'inbrowser-firebase:latest',
        rootedFileSystem: true,
        namePrefix: `inbrowser-firebase-${executorId}`,
      });
export const bridge = await startFirebaseRtdbBridge({
  ...clients,
  executorId,
  provider,
  root: '/work',
  policy: { run: true, fs: 'rw' },
  stateDirectory: resolve(process.env.FIREBASE_STATE_DIRECTORY ?? '.pyric/firebase-executor'),
});
console.log(
  `Firebase executor ${executorId} started (${provider.kind}); generation ${bridge.generation}`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await bridge.stop();
    process.exit(0);
  });
