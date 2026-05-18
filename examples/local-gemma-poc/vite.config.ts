import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // `@huggingface/transformers` ships ESM with dynamic worker imports
    // and an onnxruntime-web peer that Vite's optimizer mangles when
    // it tries to pre-bundle. Excluding lets it load at runtime from
    // node_modules directly — the upstream recommendation.
    exclude: ['@huggingface/transformers'],
  },
  server: {
    // Unlock `SharedArrayBuffer` (and therefore ONNX Runtime Web's
    // multi-threaded WASM backend) by making the page
    // cross-origin-isolated. Without these headers, ORT-Web's
    // numThreads silently falls back to 1, which on a 3 GB Gemma 4
    // graph means model init takes 10+ minutes.
    //
    // `require-corp` is the strict variant — every cross-origin
    // subresource (HF Hub CDN responses) must send
    // `Cross-Origin-Resource-Policy: cross-origin`. HF Hub does;
    // many other CDNs don't. If you swap in a model whose host
    // doesn't, switch to 'credentialless'.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
