import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SandboxBrowserApp } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element.');

createRoot(root).render(
  <StrictMode>
    <SandboxBrowserApp />
  </StrictMode>,
);
