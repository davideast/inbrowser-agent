/** Child process used only by the opt-in live fault-injection suite. */
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { createFirebaseRtdbBridgeProvider } from '../../src/remote/firebase/rtdb/index.js';
import { createRemoteSandbox } from '../../src/remote/sandbox.js';
const input = await Bun.stdin.json();
const app = initializeApp(input.config);
const auth = getAuth(app);
await signInWithCustomToken(auth, input.token);
const sandbox = await createRemoteSandbox({
  id: 'shared',
  transport: createFirebaseRtdbBridgeProvider({
    auth,
    database: getDatabase(app),
    namespace: input.namespace,
    executorId: 'demo',
  }),
});
await sandbox.runtime.run('abrupt-client-loss');
// The parent kills this process while the command is executing, without SDK cleanup.
