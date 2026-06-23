import type {
  CreateSandboxOptions,
  RuntimeCapabilities,
  Sandbox,
  SandboxEvent,
  SandboxEventInput,
  SandboxRuntime,
} from './types.js';

const DEFAULT_CAPABILITIES: RuntimeCapabilities = {
  fs: true,
  shell: false,
  git: false,
  preview: false,
  packages: false,
  persistentStorage: false,
  syncFs: false,
};

let sandboxCounter = 0;

export function createSandbox(options: CreateSandboxOptions): Sandbox {
  const id = options.id ?? `sandbox-${++sandboxCounter}-${Date.now().toString(36)}`;
  const cwd = options.cwd ?? options.fs.root;
  const listeners = new Set<(event: SandboxEvent) => void>();
  const capabilities: RuntimeCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  let destroyed = false;

  const sandbox: Sandbox = {
    id,
    cwd,
    fs: options.fs,
    runtime: createEventedRuntime(cwd, options.runtime, emit),
    capabilities,
    services: options.services ?? {},
    on(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      emit({ type: 'destroyed' });
      listeners.clear();
    },
  };

  const unwatch = options.fs.watch?.((event) => {
    emit({ type: 'file', event });
  });
  if (unwatch) {
    sandbox.on((event) => {
      if (event.type === 'destroyed') unwatch();
    });
  }

  function emit(event: SandboxEventInput) {
    const full = {
      ...event,
      sandboxId: id,
      timestamp: event.timestamp ?? Date.now(),
    } as SandboxEvent;
    for (const listener of Array.from(listeners)) listener(full);
  }

  return sandbox;
}

export function createRuntimeAdapter(run: SandboxRuntime['run']): SandboxRuntime {
  return { run };
}

function createEventedRuntime(
  defaultCwd: string,
  runtime: SandboxRuntime,
  emit: (event: SandboxEventInput) => void,
): SandboxRuntime {
  return {
    async run(command, options) {
      const cwd = options?.cwd ?? defaultCwd;
      emit({ type: 'run:start', command, cwd });
      const started = Date.now();
      try {
        const result = await runtime.run(command, options);
        const withDuration = {
          ...result,
          durationMs: result.durationMs ?? Date.now() - started,
        };
        emit({ type: 'run:finish', command, result: withDuration });
        return withDuration;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'error', message, cause: err });
        throw err;
      }
    },
  };
}
