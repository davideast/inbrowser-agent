import type {
  CreateSandboxCheckpointOptions,
  Sandbox,
  SandboxCheckpoint,
  SandboxCheckpointFilter,
  SandboxCheckpointPruneOptions,
  SandboxCheckpointRestoreOptions,
  SandboxCheckpoints,
  SandboxEventInput,
} from './types.js';

let checkpointCounter = 0;

export function createSandboxCheckpoints(
  sandbox: Pick<Sandbox, 'cwd' | 'fs'>,
  emit: (event: SandboxEventInput) => void,
): SandboxCheckpoints {
  const checkpoints = new Map<string, SandboxCheckpoint>();
  return {
    async create(input) {
      const options = normalizeCreateOptions(input);
      const createdAt = Date.now();
      const latestCheckpoint = latestFrom(checkpoints.values());
      const checkpoint: SandboxCheckpoint = {
        id: `checkpoint-${++checkpointCounter}-${createdAt.toString(36)}`,
        ...defined({
          label: options.label,
          parentId: options.parentId ?? latestCheckpoint?.id,
          turnId: options.turnId,
          messageId: options.messageId,
          toolCallId: options.toolCallId,
          reason: options.reason ?? 'manual',
          summary: options.summary,
          metadata: options.metadata,
        }),
        createdAt,
        snapshot: await sandbox.fs.snapshot(sandbox.cwd),
      };
      checkpoints.set(checkpoint.id, checkpoint);
      emit({ type: 'checkpoint:create', checkpoint });
      return checkpoint;
    },
    async restore(id, options) {
      const restoreOptions = normalizeRestoreOptions(options);
      const checkpoint = checkpoints.get(id);
      if (!checkpoint) throw new Error(`Unknown checkpoint: ${id}`);
      await sandbox.fs.restore(checkpoint.snapshot, { clearRoot: true });
      if (restoreOptions.recordEvent) {
        emit({ type: 'checkpoint:restore', checkpoint, mode: restoreOptions.mode });
      }
    },
    list(filter) {
      return filterCheckpoints(checkpoints.values(), filter);
    },
    history(filter) {
      return filterCheckpoints(checkpoints.values(), filter);
    },
    latest(filter) {
      return latestFrom(filterCheckpoints(checkpoints.values(), filter));
    },
    get(id) {
      return checkpoints.get(id);
    },
    prune(options) {
      const pruned = pruneCheckpoints(checkpoints, options);
      if (pruned.length > 0) emit({ type: 'checkpoint:prune', checkpoints: pruned });
      return pruned;
    },
  };
}

function normalizeCreateOptions(
  input: string | CreateSandboxCheckpointOptions | undefined,
): CreateSandboxCheckpointOptions {
  return typeof input === 'string' ? { label: input } : (input ?? {});
}

function normalizeRestoreOptions(
  options: SandboxCheckpointRestoreOptions | undefined,
): Required<SandboxCheckpointRestoreOptions> {
  return {
    recordEvent: options?.recordEvent ?? true,
    mode: options?.mode ?? 'replace-current',
  };
}

function filterCheckpoints(
  checkpoints: Iterable<SandboxCheckpoint>,
  filter: SandboxCheckpointFilter | undefined,
): SandboxCheckpoint[] {
  return Array.from(checkpoints)
    .filter((checkpoint) => matchesFilter(checkpoint, filter))
    .sort(compareCheckpoints);
}

function matchesFilter(
  checkpoint: SandboxCheckpoint,
  filter: SandboxCheckpointFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.turnId !== undefined && checkpoint.turnId !== filter.turnId) return false;
  if (filter.messageId !== undefined && checkpoint.messageId !== filter.messageId) return false;
  if (filter.toolCallId !== undefined && checkpoint.toolCallId !== filter.toolCallId) return false;
  if (filter.reason !== undefined && checkpoint.reason !== filter.reason) return false;
  return true;
}

function latestFrom(checkpoints: Iterable<SandboxCheckpoint>): SandboxCheckpoint | undefined {
  let latest: SandboxCheckpoint | undefined;
  for (const checkpoint of checkpoints) {
    if (
      !latest ||
      checkpoint.createdAt > latest.createdAt ||
      (checkpoint.createdAt === latest.createdAt && compareCheckpoints(checkpoint, latest) > 0)
    ) {
      latest = checkpoint;
    }
  }
  return latest;
}

function compareCheckpoints(a: SandboxCheckpoint, b: SandboxCheckpoint): number {
  return a.createdAt - b.createdAt || checkpointOrdinal(a.id) - checkpointOrdinal(b.id);
}

function checkpointOrdinal(id: string): number {
  const match = /^checkpoint-(\d+)-/.exec(id);
  return match ? Number(match[1]) : 0;
}

function pruneCheckpoints(
  checkpoints: Map<string, SandboxCheckpoint>,
  options: SandboxCheckpointPruneOptions,
): SandboxCheckpoint[] {
  const candidates = filterCheckpoints(checkpoints.values(), { reason: options.reason }).filter(
    (checkpoint) => options.before === undefined || checkpoint.createdAt < options.before,
  );
  const keepLatest = Math.max(0, options.keepLatest ?? 0);
  const keep = new Set(
    candidates.slice(Math.max(0, candidates.length - keepLatest)).map((c) => c.id),
  );
  const pruned: SandboxCheckpoint[] = [];
  for (const checkpoint of candidates) {
    if (keep.has(checkpoint.id)) continue;
    checkpoints.delete(checkpoint.id);
    pruned.push(checkpoint);
  }
  return pruned;
}

function defined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
