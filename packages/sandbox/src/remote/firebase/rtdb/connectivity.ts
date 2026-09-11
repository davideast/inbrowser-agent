import { onAuthStateChanged } from 'firebase/auth';
import { onValue, ref } from 'firebase/database';
import { type FirebaseRtdbOptions, requireIdentity } from './protocol.js';

export function monitorFirebase(options: FirebaseRtdbOptions, changed?: () => void) {
  const uid = requireIdentity(options);
  let connected = false;
  let identityValid = true;
  let offset = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    changed?.();
    for (const listener of listeners) listener();
  };
  const stops = [
    onValue(ref(options.database, '.info/connected'), (snap) => {
      connected = snap.val() === true;
      notify();
    }),
    onValue(ref(options.database, '.info/serverTimeOffset'), (snap) => {
      offset = Number(snap.val()) || 0;
    }),
    onAuthStateChanged(options.auth, (user) => {
      identityValid = user?.uid === uid;
      notify();
    }),
  ];
  function assertOnline() {
    if (!identityValid || options.auth.currentUser?.uid !== uid)
      throw new Error('Firebase identity changed; reconnect the bridge');
    if (!connected) throw new Error('Firebase bridge is offline; request was not admitted');
  }
  return {
    uid,
    online: () => connected && identityValid,
    now: () => Date.now() + offset,
    assertOnline,
    async ack<T>(operation: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
      assertOnline();
      return new Promise<T>((resolve, reject) => {
        const check = () => {
          try {
            assertOnline();
          } catch (error) {
            finish();
            reject(error);
          }
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error('Firebase acknowledgement timed out; outcome may be unknown'));
        }, timeoutMs);
        const finish = () => {
          clearTimeout(timer);
          listeners.delete(check);
        };
        listeners.add(check);
        operation().then(
          (value) => {
            finish();
            resolve(value);
          },
          (error) => {
            finish();
            reject(error);
          },
        );
      });
    },
    async ready(timeoutMs = 10_000) {
      if (connected && identityValid) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error('Firebase connection timed out'));
        }, timeoutMs);
        const check = () => {
          if (connected && identityValid) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve();
          } else if (!identityValid) {
            clearTimeout(timer);
            listeners.delete(check);
            reject(new Error('Firebase identity changed'));
          }
        };
        listeners.add(check);
        check();
      });
    },
    stop() {
      for (const stop of stops) stop();
      listeners.clear();
    },
  };
}
