import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteContainerBridgeApp } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element.');

createRoot(root).render(
  <StrictMode>
    <RemoteContainerBridgeApp />
  </StrictMode>,
);
