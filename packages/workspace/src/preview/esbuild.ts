import * as esbuild from 'esbuild-wasm';

let initPromise: Promise<typeof esbuild> | null = null;

export interface EsbuildServiceOptions {
  wasmURL?: string;
  worker?: boolean;
}

export function getEsbuild(options: EsbuildServiceOptions = {}): Promise<typeof esbuild> {
  if (!initPromise) {
    initPromise = esbuild
      .initialize({
        wasmURL: options.wasmURL,
        worker: options.worker ?? true,
      })
      .then(() => esbuild);
  }
  return initPromise as Promise<typeof esbuild>;
}

export function resetEsbuildForTests(): void {
  initPromise = null;
}
