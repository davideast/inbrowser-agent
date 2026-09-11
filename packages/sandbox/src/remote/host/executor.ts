import { assertInsideSandbox, resolveSandboxPath } from '../../path.js';
import type { SandboxSnapshot } from '../../types.js';
import { decodeBytes, encodeBytes } from '../codec.js';
import {
  type BridgeEnvelope,
  REMOTE_PROTOCOL_TYPES as P,
  type RemoteBridgeEvent,
} from '../types.js';
import { createProviderReadiness } from './readiness.js';
import type { ContainerSandboxProvider, ContainerSession } from './types.js';

export interface BridgePrincipal {
  readonly uid: string;
  readonly role: 'owner' | 'developer' | 'reviewer';
}

/** A host-owned ceiling, never a value supplied in an RPC. */
export interface BridgeExecutionPolicy {
  run: boolean;
  fs: 'none' | 'ro' | 'rw';
}

export interface BridgeRequestContext {
  principal: BridgePrincipal;
  sessionId: string;
  /** Runs after scheduling, immediately before any provider effect. */
  admit?: () => Promise<void>;
}

export interface BridgeExecutorOptions {
  provider: ContainerSandboxProvider;
  root: string;
  policy: BridgeExecutionPolicy;
  requireRootedFileSystem?: boolean;
  providerSessionId?: (sessionId: string) => string;
  exposePort?: (
    session: ContainerSession,
    request: BridgeEnvelope,
    emit: (event: RemoteBridgeEvent) => void,
  ) => Promise<unknown>;
}

const READS = new Set<string>([P.fsRead, P.fsList, P.fsStat, P.fsLstat, P.fsSnapshot]);
const WRITES = new Set<string>([P.fsWrite, P.fsMkdir, P.fsDelete, P.fsRename, P.fsRestore]);

export function createBridgeExecutor(options: BridgeExecutorOptions) {
  const root = assertInsideSandbox(options.root, options.root);
  const readiness = createProviderReadiness(options.provider);
  const sessions = new Map<string, ContainerSession>();
  const queues = new Map<string, Promise<unknown>>();
  const runs = new Map<string, AbortController>();
  const closing = new Set<string>();
  let stopped = false;

  function authorize(type: string, principal: BridgePrincipal) {
    const developer = principal.role !== 'reviewer';
    if (READS.has(type) && options.policy.fs !== 'none') return;
    if (WRITES.has(type) && developer && options.policy.fs === 'rw') return;
    if ((type === P.runStart || type === P.runCancel) && developer && options.policy.run) return;
    if (type === P.sessionCreate || type === P.hostStatus) return;
    if (type === 'session.destroy' && principal.role === 'owner') return;
    if (type === P.portExpose && developer && options.exposePort) return;
    throw new Error(`Permission denied or unsupported operation: ${type}`);
  }

  async function dispatch(
    request: BridgeEnvelope,
    context: BridgeRequestContext,
    emit: (event: RemoteBridgeEvent) => void,
  ): Promise<unknown> {
    if (stopped || closing.has(context.sessionId)) throw new Error('Session is closing');
    if (request.kind !== 'request' || request.sessionId !== context.sessionId)
      throw new Error('Request session mismatch');
    authorize(request.type, context.principal);
    const execute = async () => {
      if (stopped || closing.has(context.sessionId)) throw new Error('Session is closing');
      if (request.type === P.sessionCreate && !sessions.has(request.sessionId)) {
        if (context.principal.role === 'reviewer')
          throw new Error('Reviewers can only attach to an active session');
        await readiness.ensureReady();
      }
      await context.admit?.();
      if (stopped || closing.has(context.sessionId)) throw new Error('Session is closing');
      if (request.type === P.hostStatus)
        return {
          provider: options.provider.kind,
          authenticated: true,
          status: await readiness.status(),
        };
      if (request.type === 'session.destroy') {
        await dispose(request.sessionId);
        return {};
      }
      const payload = record(request.payload);
      if (request.type === P.sessionCreate) {
        let session = sessions.get(request.sessionId);
        if (!session) {
          if (context.principal.role === 'reviewer')
            throw new Error('Reviewers can only attach to an active session');
          session = await options.provider.createSession({
            id: options.providerSessionId?.(request.sessionId) ?? request.sessionId,
            root,
          });
          if (options.requireRootedFileSystem && session.fileSystemIsolation !== 'rooted') {
            await session.dispose();
            throw new Error('Firebase requires a provider with rooted filesystem operations');
          }
          sessions.set(request.sessionId, session);
        }
        return {
          root,
          capabilities: {
            fs: options.policy.fs !== 'none',
            shell: context.principal.role !== 'reviewer' && options.policy.run,
            persistentStorage: false,
            preview: false,
          },
        };
      }
      const session = sessions.get(request.sessionId);
      if (!session) throw new Error(`Unknown bridge session: ${request.sessionId}`);
      const path = (key = 'path') =>
        assertInsideSandbox(resolveSandboxPath(root, string(payload[key], key)), root);
      const event = (value: RemoteBridgeEvent) => emit(value);
      const file = (
        type: 'write' | 'mkdir' | 'delete' | 'rename',
        target: string,
        targetPath?: string,
      ) =>
        event({
          type: 'file',
          event: {
            type,
            path: target,
            ...(targetPath ? { targetPath } : {}),
            timestamp: Date.now(),
          },
        });
      switch (request.type) {
        case P.fsRead: {
          const target = path();
          const bytes = await session.readFile(target);
          return {
            path: target,
            content:
              payload.encoding === 'utf8' ? new TextDecoder().decode(bytes) : encodeBytes(bytes),
            encoding: payload.encoding === 'utf8' ? 'utf8' : 'base64',
          };
        }
        case P.fsWrite: {
          const target = path();
          const content = string(payload.content, 'content', true);
          await session.writeFile(
            target,
            payload.encoding === 'base64'
              ? decodeBytes(content)
              : new TextEncoder().encode(content),
          );
          file('write', target);
          return {};
        }
        case P.fsMkdir: {
          const target = path();
          await session.mkdir(target, { recursive: payload.recursive === true });
          file('mkdir', target);
          return {};
        }
        case P.fsList:
          return {
            entries: await session.readdir(path(), {
              withFileTypes: payload.withFileTypes === true,
            }),
          };
        case P.fsStat:
        case P.fsLstat: {
          const stats = await (request.type === P.fsStat
            ? session.stat(path())
            : session.lstat(path()));
          return {
            type: stats.type,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            ctimeMs: stats.ctimeMs,
          };
        }
        case P.fsDelete: {
          const target = path();
          if (target === root) throw new Error('Cannot delete sandbox root');
          if (payload.recursive === true) await session.rmdir(target, { recursive: true });
          else await session.unlink(target);
          file('delete', target);
          return {};
        }
        case P.fsRename: {
          const from = path('from');
          const to = path('to');
          if (from === root || to === root) throw new Error('Cannot rename sandbox root');
          await session.rename(from, to);
          file('rename', from, to);
          return {};
        }
        case P.fsSnapshot:
          return {
            snapshot: await session.snapshot(payload.root === undefined ? root : path('root')),
          };
        case P.fsRestore: {
          const snapshot = record(payload.snapshot) as unknown as SandboxSnapshot;
          if (snapshot.root !== root || !Array.isArray(snapshot.entries))
            throw new Error('Invalid snapshot root or entries');
          for (const entry of snapshot.entries)
            assertInsideSandbox(string(entry.path, 'entry.path'), root);
          await session.restore(snapshot, { clearRoot: payload.clearRoot === true });
          file('write', root);
          return {};
        }
        case P.runStart: {
          const controller = new AbortController();
          const key = `${request.sessionId}/${request.id}`;
          runs.set(key, controller);
          try {
            const cwd =
              payload.options === undefined
                ? root
                : assertInsideSandbox(
                    resolveSandboxPath(root, string(record(payload.options).cwd ?? root, 'cwd')),
                    root,
                  );
            return await session.run(string(payload.command, 'command'), {
              cwd,
              signal: controller.signal,
              onOutput(output) {
                event({
                  type: 'artifact',
                  artifact: { kind: 'run.output', requestId: request.id, ...output },
                });
              },
            });
          } finally {
            runs.delete(key);
          }
        }
        case P.runCancel: {
          const controller = runs.get(
            `${request.sessionId}/${string(payload.requestId, 'requestId')}`,
          );
          controller?.abort();
          return { cancellationRequested: Boolean(controller) };
        }
        case P.portExpose:
          return options.exposePort?.(session, request, emit);
        default:
          throw new Error(`Unsupported operation: ${request.type}`);
      }
    };
    // Reads and cancellation can observe a running command. All mutations and
    // session activation share one queue, so concurrent creates cannot leak containers.
    if (
      READS.has(request.type) ||
      request.type === P.runCancel ||
      request.type === P.hostStatus ||
      request.type === 'session.destroy'
    )
      return execute();
    const previous = queues.get(request.sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(execute);
    queues.set(request.sessionId, next);
    void next
      .finally(() => {
        if (queues.get(request.sessionId) === next) queues.delete(request.sessionId);
      })
      .catch(() => undefined);
    return next;
  }

  async function dispose(id: string, wait = true) {
    closing.add(id);
    for (const [key, run] of runs) if (key.startsWith(`${id}/`)) run.abort();
    const session = sessions.get(id);
    sessions.delete(id);
    try {
      if (wait) await queues.get(id)?.catch(() => undefined);
      // A create may have been in flight when closing began.
      const late = sessions.get(id);
      sessions.delete(id);
      await session?.dispose();
      if (late && late !== session) await late.dispose();
    } finally {
      closing.delete(id);
    }
  }

  return {
    dispatch,
    dispose,
    hasSession: (id: string) => sessions.has(id),
    sessionIds: () => Array.from(sessions.keys()),
    status: () => readiness.status(),
    async stop() {
      stopped = true;
      await Promise.all(
        [...new Set([...sessions.keys(), ...queues.keys()])].map((id) => dispose(id)),
      );
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object payload');
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.includes('\0'))
    throw new Error(`Invalid ${field}`);
  return value;
}
