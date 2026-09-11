import type { RemoteHostDiagnostic } from '../types.js';
import { errorMessage } from './envelopes.js';
import type { ContainerSandboxProvider } from './types.js';

interface ProviderReadiness {
  ensureReady(): Promise<void>;
  status(): Promise<RemoteHostDiagnostic>;
}

export function createProviderReadiness(provider: ContainerSandboxProvider): ProviderReadiness {
  let state: RemoteHostDiagnostic['state'] = 'idle';
  let readyPromise: Promise<void> | undefined;
  let lastError: unknown;

  async function ensureReady() {
    if (state === 'ready') return;
    if (!readyPromise) {
      state = 'starting';
      lastError = undefined;
      readyPromise = provider
        .ensureReady()
        .then(() => {
          state = 'ready';
        })
        .catch((err) => {
          state = 'error';
          lastError = err;
          readyPromise = undefined;
          throw err;
        });
    }
    await readyPromise;
  }

  async function status(): Promise<RemoteHostDiagnostic> {
    try {
      const diagnostic = provider.diagnose
        ? await provider.diagnose()
        : {
            providerKind: provider.kind,
            state,
            runtimeAvailable: true,
            systemReady: state === 'ready',
            checkedAt: Date.now(),
          };
      return {
        ...diagnostic,
        providerKind: diagnostic.providerKind || provider.kind,
        state: state === 'idle' ? diagnostic.state : state,
        message:
          state === 'error'
            ? errorMessage(lastError)
            : state === 'ready'
              ? statusMessage(state)
              : (diagnostic.message ?? statusMessage(state)),
        checkedAt: diagnostic.checkedAt || Date.now(),
      };
    } catch (err) {
      return {
        providerKind: provider.kind,
        state: 'error',
        runtimeAvailable: false,
        systemReady: false,
        message: errorMessage(err),
        checkedAt: Date.now(),
      };
    }
  }

  return { ensureReady, status };
}

function statusMessage(state: RemoteHostDiagnostic['state']): string {
  if (state === 'starting') return 'Container provider is starting';
  if (state === 'ready') return 'Container provider is ready';
  if (state === 'error') return 'Container provider failed';
  return 'Container provider is idle';
}
