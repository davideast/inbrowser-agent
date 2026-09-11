import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteContainerBridgeApp } from './App.js';
import './styles.css';

const FirebaseBridgeApp = lazy(() =>
  import('./FirebaseApp.js').then((module) => ({ default: module.FirebaseBridgeApp })),
);
const firebase = import.meta.env.VITE_REMOTE_CONTAINER_TRANSPORT === 'firebase-rtdb';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element.');

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={<p>Loading bridge…</p>}>
      {firebase ? <FirebaseBridgeApp /> : <RemoteContainerBridgeApp />}
    </Suspense>
  </StrictMode>,
);
