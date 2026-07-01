import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const bridgeTarget = process.env.REMOTE_CONTAINER_BRIDGE_TARGET ?? 'http://127.0.0.1:8790';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.REMOTE_CONTAINER_UI_PORT ?? 5184),
    strictPort: true,
    allowedHosts: ['davids-macbook-pro-2.tail8926aa.ts.net'],
    proxy: {
      '/bridge': {
        target: bridgeTarget,
        ws: true,
        changeOrigin: true,
      },
      '/bridge-config': {
        target: bridgeTarget,
        changeOrigin: true,
      },
      '/status': {
        target: bridgeTarget,
        changeOrigin: true,
      },
      '/__inbrowser/ports': {
        target: bridgeTarget,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@inbrowser/example-shared', '@inbrowser/sandbox'],
  },
});
