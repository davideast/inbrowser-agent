import type { Sandbox, SandboxCheckpoint, SandboxCheckpoints, SandboxEventInput } from './types.js';

let checkpointCounter = 0;

export function createSandboxCheckpoints(
  sandbox: Pick<Sandbox, 'cwd' | 'fs'>,
  emit: (event: SandboxEventInput) => void,
): SandboxCheckpoints {
  const checkpoints = new Map<string, SandboxCheckpoint>();
  return {
    async create(label) {
      const createdAt = Date.now();
      const checkpoint: SandboxCheckpoint = {
        id: `checkpoint-${++checkpointCounter}-${createdAt.toString(36)}`,
        label,
        createdAt,
        snapshot: await sandbox.fs.snapshot(sandbox.cwd),
      };
      checkpoints.set(checkpoint.id, checkpoint);
      emit({ type: 'checkpoint:create', checkpoint });
      return checkpoint;
    },
    async restore(id) {
      const checkpoint = checkpoints.get(id);
      if (!checkpoint) throw new Error(`Unknown checkpoint: ${id}`);
      await sandbox.fs.restore(checkpoint.snapshot, { clearRoot: true });
      emit({ type: 'checkpoint:restore', checkpoint });
    },
    list() {
      return Array.from(checkpoints.values()).sort((a, b) => a.createdAt - b.createdAt);
    },
    get(id) {
      return checkpoints.get(id);
    },
  };
}
