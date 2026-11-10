import { type WasiHostDeps, createWasiClass } from '../wasi';

export interface WasiBuiltinDeps extends WasiHostDeps {
  process: object;
}

export function createWasiBuiltin(deps: WasiBuiltinDeps): () => {
  WASI: ReturnType<typeof createWasiClass>;
} {
  let warned = false;
  const WASI = createWasiClass(deps);
  const mod = { WASI };
  return () => {
    if (!warned) {
      warned = true;
      const emitWarning: unknown = Reflect.get(deps.process, 'emitWarning');
      if (typeof emitWarning === 'function') {
        Reflect.apply(emitWarning, deps.process, [
          'WASI is an experimental feature and might change at any time',
          'ExperimentalWarning',
        ]);
      }
    }
    return mod;
  };
}
