import { createRemoteSandbox } from '@inbrowser/sandbox/remote';
import { createFirebaseRtdbBridgeProvider } from '@inbrowser/sandbox/remote/firebase/rtdb';
import { deleteApp } from 'firebase/app';
import { useEffect, useRef, useState } from 'react';
import { firebaseClients } from '../firebase-config.js';

type Remote = Awaited<ReturnType<typeof createRemoteSandbox>>;
export function FirebaseBridgeApp() {
  const session = useRef<Remote | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const [config, setConfig] = useState('{"apiKey":"","projectId":"","databaseURL":""}');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [executorId, setExecutorId] = useState('demo');
  const [sessionId, setSessionId] = useState('demo-container-session');
  const [output, setOutput] = useState('');
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const command = 'for i in 1 2 3; do echo container-stream-$i; sleep 1; done';
  const append = (text: string) => {
    if (mounted.current) setOutput((old) => (old + text).slice(-100_000));
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanup.current?.();
    };
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  async function connect() {
    setPending(true);
    await action(async () => {
      cleanup.current?.();
      session.current = null;
      setConnected(false);
      const clients = await firebaseClients(JSON.parse(config), email, password);
      if (!mounted.current) {
        await deleteApp(clients.app);
        return;
      }
      try {
        const sandbox = await createRemoteSandbox({
          id: sessionId,
          transport: createFirebaseRtdbBridgeProvider({ ...clients, executorId }),
          requestTimeoutMs: 35_000,
        });
        if (!mounted.current) {
          sandbox.destroy();
          await deleteApp(clients.app);
          return;
        }
        const unsubscribe = sandbox.on((event) => {
          if (event.type === 'artifact')
            append(
              typeof event.artifact.chunk === 'string'
                ? event.artifact.chunk
                : `\n${JSON.stringify(event.artifact)}\n`,
            );
        });
        session.current = sandbox;
        cleanup.current = () => {
          unsubscribe();
          sandbox.destroy();
          void deleteApp(clients.app);
        };
        setConnected(true);
        append(`\nAttached as ${clients.auth.currentUser?.uid}.\n`);
      } catch (failure) {
        await deleteApp(clients.app);
        throw failure;
      }
    });
    if (mounted.current) setPending(false);
  }
  return (
    <main className="remote-runner" style={{ maxWidth: 900, margin: '2rem auto', padding: 24 }}>
      <h1>Firebase container bridge</h1>
      <p>
        Connect as a developer to activate the container. A reviewer can then attach, read files,
        and observe output. Use a second tab to compare identities.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <label>
          Firebase config JSON
          <textarea
            aria-label="Firebase config JSON"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={3}
            style={{ width: '100%' }}
          />
        </label>
        <label>
          Executor <input value={executorId} onChange={(e) => setExecutorId(e.target.value)} />
        </label>
        <label>
          Session <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
        </label>
        <label>
          Email{' '}
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password{' '}
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? 'Connecting…' : 'Attach / reconnect'}
        </button>
      </form>
      <output>{connected ? 'Attached' : 'Detached'}</output>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          disabled={!connected}
          onClick={() =>
            void action(async () => {
              const result = await session.current!.runtime.run(command);
              append(`\nExit ${result.exitCode}\n`);
            })
          }
        >
          Run command
        </button>
        <button
          type="button"
          disabled={!connected}
          onClick={() =>
            void action(async () => {
              await session.current!.fs.promises.writeFile(
                '/work/hello.txt',
                'Shared through Firebase\n',
              );
              append('File written.\n');
            })
          }
        >
          Write file
        </button>
        <button
          type="button"
          disabled={!connected}
          onClick={() =>
            void action(async () =>
              append(
                String(await session.current!.fs.promises.readFile('/work/hello.txt', 'utf8')),
              ),
            )
          }
        >
          Read file
        </button>
        <button
          type="button"
          disabled={!connected}
          onClick={() => {
            cleanup.current?.();
            cleanup.current = null;
            session.current = null;
            setConnected(false);
          }}
        >
          Detach
        </button>
      </div>
      <p>
        Run and write remain available to demonstrate server-enforced reviewer denials. Detach
        leaves the container running during its reconnect grace period.
      </p>
      {error && (
        <p role="alert" className="remote-error">
          {error}
        </p>
      )}
      <pre className="remote-terminal" aria-label="Container output">
        {output || 'Waiting for output.'}
      </pre>
    </main>
  );
}
