import { VERSION, fault, record, unwrap } from './protocol';

export interface FilesystemChange {
  event: 'rename' | 'change';
  filename: string | null;
}

export function filesystemWatch(
  port: MessagePort,
  close: () => Promise<void>,
  lifetime: AbortSignal,
): ReadableStream<FilesystemChange> {
  let ended = false;
  let controller: ReadableStreamDefaultController<FilesystemChange>;
  const detach = () => {
    ended = true;
    lifetime.removeEventListener('abort', abort);
    port.onmessage = null;
    port.close();
  };
  const abort = () => {
    if (ended) return;
    detach();
    controller.error(fault('EPIPE', 'Container closed'));
  };
  return new ReadableStream<FilesystemChange>({
    start(value) {
      controller = value;
      port.onmessage = (message: MessageEvent<unknown>) => {
        if (ended) return;
        const data = message.data;
        try {
          if (!record(data) || data.version !== VERSION)
            throw fault('EPROTO', 'Invalid filesystem watch event');
          if (data.type === 'error') unwrap({ ok: false, error: data.error });
          if (
            data.type !== 'event' ||
            (data.event !== 'rename' && data.event !== 'change') ||
            (data.filename !== null && typeof data.filename !== 'string')
          )
            throw fault('EPROTO', 'Invalid filesystem watch event');
          controller.enqueue({ event: data.event, filename: data.filename });
        } catch (error) {
          detach();
          controller.error(error);
          void close().catch(() => undefined);
        }
      };
      lifetime.addEventListener('abort', abort, { once: true });
      if (lifetime.aborted) abort();
    },
    pull() {
      if (!ended) port.postMessage({ version: VERSION, type: 'next' });
    },
    async cancel() {
      if (ended) return;
      detach();
      await close();
    },
  });
}
