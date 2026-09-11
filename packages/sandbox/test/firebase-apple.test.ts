import { expect, test } from 'bun:test';
import { createAppleContainerProvider } from '../src/remote/apple-container/index.js';

const live = process.env.INBROWSER_APPLE_TEST === '1' ? test : test.skip;
live(
  'Apple rooted filesystem, actual process cancellation and disposal',
  async () => {
    const provider = createAppleContainerProvider({
      image: process.env.REMOTE_CONTAINER_IMAGE ?? 'inbrowser-firebase:latest',
      rootedFileSystem: true,
      namePrefix: 'inbrowser-rtdb-test',
    });
    await provider.ensureReady();
    const session = await provider.createSession({ id: crypto.randomUUID(), root: '/work' });
    try {
      await session.writeFile('/work/nested/hello.txt', new TextEncoder().encode('hello'));
      expect(new TextDecoder().decode(await session.readFile('/work/nested/hello.txt'))).toBe(
        'hello',
      );
      expect((await session.run('echo writable > nested/from-shell')).exitCode).toBe(0);
      expect(
        (await session.run('echo outside > /tmp/outside; ln /tmp/outside /work/hardlink')).exitCode,
      ).not.toBe(0);
      await session.run('ln -s /etc /work/escape');
      await expect(session.readFile('/work/escape/passwd')).rejects.toThrow();
      await expect(session.writeFile('/work/escape/passwd', new Uint8Array())).rejects.toThrow();
      await expect(session.readFile('/etc/passwd')).rejects.toThrow();
      const controller = new AbortController();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const command = session.run('echo started; sleep 3; echo survived > /work/after-cancel', {
        signal: controller.signal,
        onOutput(output) {
          if (output.chunk.includes('started')) started();
        },
      });
      const settled = command.then(
        () => 'completed',
        (error) => String(error),
      );
      await ready;
      controller.abort();
      expect(await settled).toContain('cancelled');
      await Bun.sleep(3200);
      expect((await session.run('test ! -e /work/after-cancel')).exitCode).toBe(0);
    } finally {
      await session.dispose();
    }
  },
  60_000,
);

test('failed container cancellation is not reported as confirmed cancellation', async () => {
  const controller = new AbortController();
  const provider = createAppleContainerProvider({
    image: 'test',
    rootedFileSystem: true,
    commandRunner: {
      async run(args) {
        const script = args.join(' ');
        if (script.includes('setsid sh -c')) controller.abort();
        return {
          stdout: '',
          stderr: '',
          exitCode: script.includes('os.killpg') ? 1 : 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    },
  });
  const session = await provider.createSession({ id: 'cancellation-failure', root: '/work' });
  try {
    await expect(session.run('command', { signal: controller.signal })).rejects.toThrow(
      'not confirmed',
    );
  } finally {
    await session.dispose();
  }
});
