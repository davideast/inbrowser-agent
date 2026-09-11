import { type FirebaseOptions, deleteApp, initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getDatabase } from 'firebase/database';

/** Callers can replace this example login with their existing authenticated clients. */
export async function firebaseClients(config: FirebaseOptions, email: string, password: string) {
  const app = initializeApp(config, `bridge-${crypto.randomUUID()}`);
  const auth = getAuth(app);
  const database = getDatabase(app);
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    await deleteApp(app);
    throw error;
  }
  return { app, auth, database };
}
