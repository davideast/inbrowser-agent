import { expect, test } from 'bun:test';
import { createSign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FirebaseOptions, deleteApp, initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { get, getDatabase, goOffline, goOnline, ref, set } from 'firebase/database';
import { startFirebaseRtdbBridge } from '../src/remote/firebase/rtdb/host/index.js';
import { createFirebaseRtdbBridgeProvider } from '../src/remote/firebase/rtdb/index.js';
import { createRemoteSandbox } from '../src/remote/sandbox.js';
import { trackingProvider } from './helpers/container.js';

const live = process.env.INBROWSER_FIREBASE_SA ? test : test.skip;
/** Explicit opt-in only. The credential is used for isolated test provisioning,
 * never passed to the executor, workload, browser package or emitted output. */
live(
  'dedicated Firebase project: Rules, distinct client identities, reconnect and contention',
  async () => {
    const credential = JSON.parse(await readFile(process.env.INBROWSER_FIREBASE_SA!, 'utf8'));
    function jwt(claims: object) {
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
      return `${body}.${createSign('RSA-SHA256').update(body).sign(credential.private_key, 'base64url')}`;
    }
    const now = Math.floor(Date.now() / 1000);
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt({
          iss: credential.client_email,
          scope:
            'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
        }),
      }),
    });
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) throw new Error('Test provisioning OAuth failed');
    async function admin(url: string, method = 'GET', body?: unknown) {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          `Test provisioning ${method} failed (${response.status}): ${JSON.stringify(value)}`,
        );
      return value;
    }
    const project = credential.project_id;
    const instances = await admin(
      `https://firebasedatabase.googleapis.com/v1beta/projects/${project}/locations/-/instances`,
    );
    const databaseURL =
      process.env.INBROWSER_FIREBASE_DATABASE_URL ?? instances.instances?.[0]?.databaseUrl;
    if (!databaseURL) throw new Error('No configured RTDB instance');
    const apps = await admin(`https://firebase.googleapis.com/v1beta1/projects/${project}/webApps`);
    if (!apps.apps?.[0]) throw new Error('No configured Firebase web app');
    const config = (await admin(
      `https://firebase.googleapis.com/v1beta1/${apps.apps[0].name}/config`,
    )) as FirebaseOptions;
    const namespace = `inbrowser_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const rulesURL = `${databaseURL}/.settings/rules.json`;
    const original = await admin(rulesURL);
    if (original.rules?.['.read'] !== false || original.rules?.['.write'] !== false)
      throw new Error('Live suite requires explicit default-deny root Rules');
    const reference = JSON.parse(
      (await readFile(new URL('../rules/database.rules.json', import.meta.url), 'utf8')).replaceAll(
        'inbrowserBridge',
        namespace,
      ),
    );
    if (original.rules[namespace]) throw new Error('Test namespace collision');
    const clients: Array<{
      app: ReturnType<typeof initializeApp>;
      auth: ReturnType<typeof getAuth>;
      database: ReturnType<typeof getDatabase>;
      uid: string;
    }> = [];
    const sessions: Array<{ destroy(): void }> = [];
    let bridge: Awaited<ReturnType<typeof startFirebaseRtdbBridge>> | undefined;
    const stateDirectory = await mkdtemp(join(tmpdir(), 'inbrowser-live-'));
    let rulesInstalled = false;
    try {
      await admin(rulesURL, 'PUT', {
        ...original,
        rules: { ...original.rules, [namespace]: reference.rules[namespace] },
      });
      rulesInstalled = true;
      async function identity(role: string) {
        const uid = `${namespace}_${role}`;
        const app = initializeApp({ ...config, databaseURL }, uid);
        const auth = getAuth(app);
        const database = getDatabase(app);
        const client = { app, auth, database, uid };
        clients.push(client);
        await signInWithCustomToken(
          auth,
          jwt({
            iss: credential.client_email,
            sub: credential.client_email,
            aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
            iat: now,
            exp: now + 3600,
            uid,
          }),
        );
        return client;
      }
      const owner = await identity('owner');
      const developer = await identity('developer');
      const reviewer = await identity('reviewer');
      const executor = await identity('executor');
      const base = `${namespace}/executors/demo`;
      await admin(`${databaseURL}/${base}.json`, 'PUT', {
        config: { uid: executor.uid },
        sessions: {
          shared: {
            manifest: {
              ownerUid: owner.uid,
              members: { [developer.uid]: 'developer', [reviewer.uid]: 'reviewer' },
            },
          },
        },
      });
      let abruptFinished = false;
      const tracked = trackingProvider(async (command, options) => {
        if (command === 'abrupt-client-loss') {
          await Bun.sleep(1500);
          abruptFinished = true;
        }
        options?.onOutput?.({ stream: 'stdout', chunk: 'hello\n' });
        return { stdout: 'hello\n', stderr: '', exitCode: 0 };
      });
      bridge = await startFirebaseRtdbBridge({
        ...executor,
        namespace,
        executorId: 'demo',
        provider: tracked.provider,
        policy: { run: true, fs: 'rw' },
        stateDirectory,
      });
      const originalLease = (await get(ref(executor.database, `${base}/runtime`))).val().expiresAt;
      const connect = async (who: typeof developer) => {
        const session = await createRemoteSandbox({
          id: 'shared',
          transport: createFirebaseRtdbBridgeProvider({ ...who, namespace, executorId: 'demo' }),
          requestTimeoutMs: 35_000,
        });
        sessions.push(session);
        return session;
      };
      console.log('Connecting developer');
      const dev = await connect(developer);
      console.log('Connecting reviewer');
      const review = await connect(reviewer);
      // Fixed low-numbered slots pin the RTDB Rules regex dialect regression.
      for (const slot of ['slot-00', 'slot-09']) {
        const id = `probe-${slot}`;
        const envelope = {
          id,
          sessionId: 'shared',
          kind: 'request',
          type: 'host.status',
          sentAt: Date.now(),
          payload: {},
        };
        await set(ref(developer.database, `${base}/sessions/shared/requests/${slot}`), {
          id,
          author: developer.uid,
          generation: bridge.generation,
          deadline: Date.now() + 28000,
          type: envelope.type,
          envelopeJson: JSON.stringify(envelope),
        });
        const end = Date.now() + 5000;
        while (
          !(await get(ref(developer.database, `${base}/sessions/shared/responses/${id}`))).exists()
        ) {
          if (Date.now() > end) throw new Error('Low-numbered mailbox response timed out');
          await Bun.sleep(20);
        }
      }
      await dev.fs.promises.writeFile('/work/live.txt', 'live shared state');
      expect(await review.fs.promises.readFile('/work/live.txt', 'utf8')).toBe('live shared state');
      await expect(review.runtime.run('denied')).rejects.toThrow();
      await expect(review.fs.promises.writeFile('/work/live.txt', 'denied')).rejects.toThrow();
      await Promise.all(Array.from({ length: 4 }, () => dev.runtime.run('once')));
      expect(tracked.calls.length).toBe(4);
      const child = Bun.spawn(
        ['bun', new URL('./helpers/firebase-abrupt-client.ts', import.meta.url).pathname],
        { stdin: 'pipe', stdout: 'ignore', stderr: 'inherit' },
      );
      try {
        child.stdin.write(
          JSON.stringify({
            config: { ...config, databaseURL },
            namespace,
            token: jwt({
              iss: credential.client_email,
              sub: credential.client_email,
              aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
              iat: now,
              exp: now + 3600,
              uid: developer.uid,
            }),
          }),
        );
        child.stdin.end();
        const end = Date.now() + 15000;
        while (!tracked.calls.includes('abrupt-client-loss')) {
          if (Date.now() > end) throw new Error('Abrupt-client request did not start');
          await Bun.sleep(20);
        }
        child.kill('SIGKILL');
        await child.exited;
        while (!abruptFinished) {
          if (Date.now() > end) throw new Error('Disconnected command did not complete');
          await Bun.sleep(20);
        }
        expect(tracked.calls.filter((command) => command === 'abrupt-client-loss').length).toBe(1);
        expect(tracked.disposed.length).toBe(0);
      } finally {
        child.kill();
        await child.exited;
      }
      const leaseDeadline = Date.now() + 25000;
      while (
        (await get(ref(executor.database, `${base}/runtime`))).val()?.expiresAt <= originalLease
      ) {
        if (Date.now() > leaseDeadline) throw new Error('Executor lease failed to refresh');
        await Bun.sleep(250);
      }
      expect((await bridge.status()).sessions).toEqual(['shared']);
      goOffline(developer.database);
      await expect(dev.runtime.run('offline')).rejects.toThrow();
      goOnline(developer.database);
      await Bun.sleep(1000);
      dev.destroy();
      const attached = await connect(developer);
      expect(tracked.created.length).toBe(1);
      expect(await attached.fs.promises.readFile('/work/live.txt', 'utf8')).toBe(
        'live shared state',
      );
      await set(
        ref(owner.database, `${base}/sessions/shared/manifest/members/${developer.uid}`),
        null,
      );
      await expect(attached.runtime.run('revoked')).rejects.toThrow();
      await expect(
        set(ref(reviewer.database, `${base}/sessions/shared/responses/forged`), {
          envelopeJson: '{}',
        }),
      ).rejects.toThrow();
      expect(tracked.calls.length).toBe(5);
      await bridge.stop();
      expect(await admin(`${databaseURL}/${namespace}/executors/demo/runtime.json`)).toBeNull();
      console.log(
        'Live Firebase developer/reviewer, reconnect, concurrent submissions and revocation passed.',
      );
    } catch (error) {
      console.log('Executor diagnostic', await bridge?.status());
      throw error;
    } finally {
      for (const session of sessions) session.destroy();
      await bridge?.stop();
      for (const client of clients) {
        goOffline(client.database);
        await deleteApp(client.app);
      }
      await admin(`${databaseURL}/${namespace}.json`, 'DELETE');
      if (rulesInstalled) {
        // Preserve unrelated edits made while this suite was running.
        const current = await admin(rulesURL);
        delete current.rules[namespace];
        await admin(rulesURL, 'PUT', current);
      }
      for (const client of clients)
        await admin(
          `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:delete`,
          'POST',
          { localId: client.uid },
        ).catch((error) =>
          console.error(`Test identity cleanup required: ${client.uid}: ${String(error)}`),
        );
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  180_000,
);
