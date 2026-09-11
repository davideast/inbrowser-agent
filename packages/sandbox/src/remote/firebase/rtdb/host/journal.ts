import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BridgeEnvelope } from '../../../types.js';

export interface JournalEntry {
  sessionId: string;
  generation: string;
  hash: string;
  acceptedAt: number;
  request: BridgeEnvelope;
  response?: BridgeEnvelope;
  completedAt?: number;
}

/** One durable owner per state directory. Accepted records precede all effects. */
export function openJournal(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'executor.lock');
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Invalid executor lock; inspect stateDirectory before removing it');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('Executor stateDirectory is already in use');
    unlinkSync(lockPath);
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  }
  const path = join(directory, 'journal.json');
  let entries: Record<string, JournalEntry>;
  try {
    entries = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  } catch (error) {
    unlinkSync(lockPath);
    throw error;
  }
  function flush() {
    const temporary = `${path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(entries));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const parent = openSync(directory, 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  return {
    get: (id: string) => entries[id],
    all: () => Object.entries(entries),
    put(id: string, entry: JournalEntry) {
      entries[id] = entry;
      flush();
    },
    prune(before: number, generation: string) {
      for (const [id, entry] of Object.entries(entries))
        if (entry.completedAt && entry.completedAt < before) {
          if (entry.generation !== generation) delete entries[id];
          else
            entries[id] = {
              ...entry,
              request: { ...entry.request, payload: {} },
              response: {
                id: `expired-${entry.request.id}`,
                sessionId: entry.sessionId,
                replyTo: entry.request.id,
                type: entry.request.type,
                kind: 'error',
                sentAt: before,
                payload: {
                  message: 'Result retention expired; request will not be executed again',
                },
              },
            };
        }
      flush();
    },
    close() {
      if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid))
        unlinkSync(lockPath);
    },
  };
}
