import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { get, getDatabase, onValue, ref, set } from 'firebase/database';
import { createAppForSandbox } from 'pyric/app/internal';
import { sandbox as authSandbox } from 'pyric/auth';
import { getAdminDatabase } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';
import { startFirebaseRtdbBridge } from '../src/remote/firebase/rtdb/host/index.js';
import { openJournal } from '../src/remote/firebase/rtdb/host/journal.js';
import { createFirebaseRtdbBridgeProvider } from '../src/remote/firebase/rtdb/index.js';
import { createRemoteSandbox } from '../src/remote/sandbox.js';
import { trackingProvider } from './helpers/container.js';

const rules = JSON.parse(
  readFileSync(new URL('../rules/database.rules.json', import.meta.url), 'utf8'),
);
const suite = process.env.INBROWSER_PYRIC_TEST ? describe : describe.skip;

async function setup(
  run?: Parameters<typeof trackingProvider>[0],
  options: { reconnectGraceMs?: number } = {},
) {
  const sandbox = initializeSandbox();
  const config = { projectId: 'bridge-test', databaseURL: 'https://bridge-test.firebaseio.com' };
  async function identity(name: string) {
    const app = createAppForSandbox(sandbox, config, name);
    const auth = getAuth(app as never);
    const database = getDatabase(app as never);
    authSandbox.seedUsers(auth as never, [
      { uid: name, email: `${name}@example.com`, password: 'password123' },
    ]);
    await signInWithEmailAndPassword(auth, `${name}@example.com`, 'password123');
    return { auth, database, uid: auth.currentUser!.uid };
  }
  const owner = await identity('owner');
  const developer = await identity('developer');
  const reviewer = await identity('reviewer');
  const host = await identity('host');
  const outsider = await identity('outsider');
  const admin = getAdminDatabase(sandbox, config.databaseURL);
  const base = 'inbrowserBridge/executors/test';
  await set(ref(admin as never, base), {
    config: { uid: host.uid },
    sessions: {
      shared: {
        manifest: {
          ownerUid: owner.uid,
          members: { [developer.uid]: 'developer', [reviewer.uid]: 'reviewer' },
        },
      },
    },
  });
  setRules(admin, rules);
  const stateDirectory = await mkdtemp(join(tmpdir(), 'rtdb-test-'));
  const tracked = trackingProvider(run);
  const bridge = await startFirebaseRtdbBridge({
    ...options,
    ...host,
    executorId: 'test',
    provider: tracked.provider,
    stateDirectory,
    policy: { run: true, fs: 'rw' },
  });
  const clients: Array<{ destroy(): void }> = [];
  async function connect(who = developer) {
    const client = await createRemoteSandbox({
      id: 'shared',
      transport: createFirebaseRtdbBridgeProvider({ ...who, executorId: 'test' }),
      requestTimeoutMs: 2000,
    });
    clients.push(client);
    return client;
  }
  return {
    stateDirectory,
    sandbox,
    owner,
    developer,
    reviewer,
    host,
    outsider,
    admin,
    base,
    bridge,
    tracked,
    connect,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise((r) => setTimeout(r, 10));
      await bridge.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    },
  };
}

suite('Firebase RTDB via Pyric', () => {
  test('developer executes and writes; reviewer attaches, observes and reads but cannot mutate', async () => {
    const t = await setup();
    try {
      const developer = await t.connect();
      const reviewer = await t.connect(t.reviewer);
      const chunks: string[] = [];
      reviewer.on((event) => {
        if (event.type === 'artifact' && event.artifact.kind === 'run.output')
          chunks.push(String(event.artifact.chunk));
      });
      await developer.fs.promises.writeFile('/work/hello.txt', 'shared file');
      expect(await reviewer.fs.promises.readFile('/work/hello.txt', 'utf8')).toBe('shared file');
      expect((await developer.runtime.run('hello')).stdout).toBe('hello\n');
      expect(chunks.join('')).toBe('hello\n');
      await expect(reviewer.runtime.run('forbidden')).rejects.toThrow();
      await expect(reviewer.fs.promises.writeFile('/work/hello.txt', 'bad')).rejects.toThrow();
      const cp = await reviewer.checkpoints.create('review');
      await expect(reviewer.checkpoints.restore(cp.id)).rejects.toThrow();
      expect(t.tracked.calls).toEqual(['hello']);
    } finally {
      await t.close();
    }
  });
  test('denies outsider access and forged executor writes', async () => {
    const t = await setup();
    try {
      await expect(t.connect(t.outsider)).rejects.toThrow();
      await expect(
        set(ref(t.developer.database, `${t.base}/sessions/shared/responses/forged`), {
          envelopeJson: '{}',
          completedAt: Date.now(),
        }),
      ).rejects.toThrow();
      await expect(
        set(
          ref(
            t.developer.database,
            `${t.base}/sessions/shared/manifest/members/${t.developer.uid}`,
          ),
          'developer',
        ),
      ).rejects.toThrow();
      await signOut(t.outsider.auth);
      await expect(t.connect(t.outsider)).rejects.toThrow('signed-in');
    } finally {
      await t.close();
    }
  });
});

async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 2500;
  while (true) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > end) throw new Error('Condition timed out');
    await Bun.sleep(5);
  }
}
async function submit(
  t: Awaited<ReturnType<typeof setup>>,
  id: string,
  type: string,
  payload: unknown,
  slot = '0',
) {
  const envelope = { id, sessionId: 'shared', kind: 'request', type, sentAt: Date.now(), payload };
  const request = {
    id,
    author: t.developer.uid,
    generation: t.bridge.generation,
    deadline: Date.now() + 30000,
    type,
    envelopeJson: JSON.stringify(envelope),
  };
  await set(
    ref(t.developer.database, `${t.base}/sessions/shared/requests/slot-${slot.padStart(2, '0')}`),
    request,
  );
  return request;
}
async function result(t: Awaited<ReturnType<typeof setup>>, id: string) {
  const snap = await until(
    () => get(ref(t.developer.database, `${t.base}/sessions/shared/responses/${id}`)),
    (s) => s.exists(),
  );
  return JSON.parse(snap.val().envelopeJson);
}
suite('Firebase RTDB delivery and admission', () => {
  test('deduplicates a stable request and refuses changed contents without another effect', async () => {
    const t = await setup();
    try {
      await t.connect();
      const request = await submit(t, 'stable', 'run.start', { command: 'once' });
      expect((await result(t, 'stable')).kind).toBe('response');
      await until(
        () => get(ref(t.developer.database, `${t.base}/sessions/shared/requests/slot-00`)),
        (s) => !s.exists(),
      );
      await set(ref(t.developer.database, `${t.base}/sessions/shared/requests/slot-01`), request);
      await until(
        () => get(ref(t.developer.database, `${t.base}/sessions/shared/requests/slot-01`)),
        (s) => !s.exists(),
      );
      await set(ref(t.developer.database, `${t.base}/sessions/shared/requests/slot-02`), {
        ...request,
        envelopeJson: request.envelopeJson.replace('once', 'twice'),
      });
      await until(
        () => get(ref(t.developer.database, `${t.base}/sessions/shared/requests/slot-02`)),
        (s) => !s.exists(),
      );
      expect(t.tracked.calls).toEqual(['once']);
      expect((await t.bridge.status()).lastError).toContain('different contents');
    } finally {
      await t.close();
    }
  });
  test('rejects forged authors, expired requests, request edits and cross-session reads', async () => {
    let release!: () => void;
    const t = await setup(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    try {
      await t.connect();
      const request = await submit(t, 'blocking', 'run.start', { command: 'block' });
      await until(
        () => t.tracked.calls.length,
        (n) => n === 1,
      );
      const target = ref(t.developer.database, `${t.base}/sessions/shared/requests/slot-00`);
      await expect(set(target, { ...request, type: 'fs.write' })).rejects.toThrow();
      await expect(
        set(ref(t.developer.database, `${t.base}/sessions/shared/requests/slot-01`), {
          ...request,
          id: 'expired',
          deadline: Date.now() - 1,
        }),
      ).rejects.toThrow();
      await expect(
        set(ref(t.developer.database, `${t.base}/sessions/shared/requests/slot-02`), {
          ...request,
          author: t.owner.uid,
        }),
      ).rejects.toThrow();
      await expect(get(ref(t.developer.database, `${t.base}/sessions/another`))).rejects.toThrow();
    } finally {
      release?.();
      await t.close();
    }
  });
  test('reauthorizes queued work after revocation and cancellation reaches the provider', async () => {
    let aborted = false;
    const t = await setup(async (_command, options) => {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { stdout: '', stderr: '', exitCode: 143 };
    });
    try {
      await t.connect();
      await submit(t, 'running', 'run.start', { command: 'running' });
      await until(
        () => t.tracked.calls.length,
        (n) => n === 1,
      );
      await submit(t, 'queued', 'run.start', { command: 'never' }, '1');
      // Revoke via the actual owner's authenticated write, not an admin bypass.
      await set(
        ref(t.owner.database, `${t.base}/sessions/shared/manifest/members/${t.developer.uid}`),
        null,
      );
      await t.bridge.destroySession('shared');
      expect(aborted).toBe(true);
      expect(t.tracked.calls).toEqual(['running']);
      expect(t.tracked.disposed.length).toBe(1);
    } finally {
      await t.close();
    }
  });
  test('detaching preserves the running session and a reviewer can reattach', async () => {
    const t = await setup();
    try {
      const first = await t.connect();
      first.destroy();
      const second = await t.connect(t.reviewer);
      expect(t.tracked.created.length).toBe(1);
      expect(t.tracked.disposed.length).toBe(0);
      await expect(second.runtime.run('denied')).rejects.toThrow();
      await t.bridge.destroySession('shared');
      await expect(t.connect(t.reviewer)).rejects.toThrow();
    } finally {
      await t.close();
    }
  });
});

suite('Firebase RTDB recovery and retained history', () => {
  test('restart reports accepted unfinished work as unknown without invoking it', async () => {
    const t = await setup();
    let restarted: Awaited<ReturnType<typeof startFirebaseRtdbBridge>> | undefined;
    try {
      await t.connect();
      await t.bridge.stop();
      const journal = openJournal(t.stateDirectory);
      journal.put('shared/interrupted', {
        sessionId: 'shared',
        generation: t.bridge.generation,
        hash: 'a'.repeat(64),
        acceptedAt: Date.now(),
        request: {
          id: 'interrupted',
          sessionId: 'shared',
          kind: 'request',
          type: 'run.start',
          sentAt: Date.now(),
          payload: { command: 'never-retry' },
        },
      });
      journal.close();
      restarted = await startFirebaseRtdbBridge({
        ...t.host,
        executorId: 'test',
        provider: t.tracked.provider,
        stateDirectory: t.stateDirectory,
        policy: { run: true, fs: 'rw' },
      });
      expect(restarted.generation).not.toBe(t.bridge.generation);
      expect((await result(t, 'interrupted')).payload.message).toContain('Unknown outcome');
      expect((await restarted.status()).sessions).toEqual([]);
      expect(t.tracked.calls).toEqual([]);
    } finally {
      await restarted?.stop();
      await t.close();
    }
  });
  test('Pyric virtual time expires delayed submissions and listener cleanup is observable', async () => {
    const t = await setup();
    try {
      const client = await t.connect();
      const before = t.sandbox
        .history()
        .filter((event) => event.kind === 'listener' && event.phase === 'attach').length;
      expect(before).toBeGreaterThan(0);
      const { getClock } = await import('pyric/sandbox');
      getClock(t.sandbox).advance(31_000);
      await expect(
        submit(t, 'expired-in-transit', 'run.start', { command: 'never' }),
      ).rejects.toThrow();
      expect(t.tracked.calls).toEqual([]);
      client.destroy();
      await Bun.sleep(10);
      expect(
        t.sandbox.history().filter((event) => event.kind === 'listener' && event.phase === 'detach')
          .length,
      ).toBeGreaterThan(0);
    } finally {
      await t.close();
    }
  });
  test('a new attachment rejects reused IDs with altered payloads instead of returning stale success', async () => {
    const t = await setup();
    try {
      await t.connect();
      const request = await submit(t, 'prior', 'run.start', { command: 'once' });
      await result(t, 'prior');
      const connection = await createFirebaseRtdbBridgeProvider({
        ...t.developer,
        executorId: 'test',
      }).connect({ role: 'browser', sessionId: 'shared' });
      try {
        await expect(
          connection.request(
            { ...JSON.parse(request.envelopeJson), payload: { command: 'twice' } },
            { timeoutMs: 2000 },
          ),
        ).rejects.toThrow('different contents');
        expect(t.tracked.calls).toEqual(['once']);
      } finally {
        await connection.close();
      }
    } finally {
      await t.close();
    }
  });
  test('running lifecycle is observable before terminal command result', async () => {
    let release!: () => void;
    const t = await setup(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    try {
      await t.connect();
      await submit(t, 'phases', 'run.start', { command: 'wait' });
      await until(
        () => t.tracked.calls.length,
        (n) => n === 1,
      );
      expect(
        (await get(ref(t.owner.database, `${t.base}/sessions/shared/operations/phases`))).val()
          .phase,
      ).toBe('running');
      expect(
        (await get(ref(t.owner.database, `${t.base}/sessions/shared/responses/phases`))).exists(),
      ).toBe(false);
      release();
      await result(t, 'phases');
      expect(
        (await get(ref(t.owner.database, `${t.base}/sessions/shared/operations/phases`))).val()
          .phase,
      ).toBe('terminal');
    } finally {
      release?.();
      await t.close();
    }
  });
});

suite('Firebase RTDB replay', () => {
  test('reattaching exposes retained output and an explicit gap to the first sandbox observer', async () => {
    const t = await setup();
    try {
      await set(ref(t.admin as never, `${t.base}/sessions/shared/events/0000000000000100`), {
        envelopeJson: JSON.stringify({
          id: 'event-100',
          sessionId: 'shared',
          kind: 'event',
          type: 'event',
          seq: 100,
          sentAt: Date.now(),
          payload: {
            type: 'artifact',
            artifact: { kind: 'run.output', stream: 'stdout', chunk: 'retained\n' },
          },
        }),
        bytes: 300,
      });
      await set(ref(t.admin as never, `${t.base}/sessions/shared/eventWindow`), {
        first: 100,
        last: 100,
      });
      const client = await t.connect();
      const kinds: string[] = [];
      client.on((event) => {
        if (event.type === 'artifact') kinds.push(String(event.artifact.kind));
      });
      expect(kinds).toContain('bridge.replay-gap');
      expect(kinds).toContain('run.output');
    } finally {
      await t.close();
    }
  });
});

suite('Firebase RTDB bounds and expiry', () => {
  test('grace expiry disposes the detached container', async () => {
    const t = await setup(undefined, { reconnectGraceMs: 1 });
    try {
      const client = await t.connect();
      client.destroy();
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          clearInterval(timer);
          reject(new Error('Grace cleanup did not run'));
        }, 23000);
        const timer = setInterval(() => {
          if (t.tracked.disposed.length) {
            clearInterval(timer);
            clearTimeout(deadline);
            resolve();
          }
        }, 25);
      });
      expect(t.tracked.disposed.length).toBe(1);
      expect((await t.bridge.status()).sessions).toEqual([]);
    } finally {
      await t.close();
    }
  }, 25000);
  test('oversized envelopes are rejected without changing the filesystem', async () => {
    const t = await setup();
    try {
      const client = await t.connect();
      await expect(
        client.fs.promises.writeFile('/work/too-big', 'x'.repeat(1048576)),
      ).rejects.toThrow('1 MiB');
      await expect(client.fs.promises.readFile('/work/too-big')).rejects.toThrow();
    } finally {
      await t.close();
    }
  });
});

suite('shared executor contract over RTDB', () => {
  test('uses the same command/file/stream/checkpoint contract as WebSocket hosts', async () => {
    const t = await setup();
    try {
      const { remoteContract } = await import('./helpers/remote-contract.js');
      await remoteContract(await t.connect());
    } finally {
      await t.close();
    }
  });
});
