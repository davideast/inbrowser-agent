import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import path from 'path-browserify';
import { fileURLToPath } from './file-url';
import { type Syscalls, VERSION, fault, record } from './protocol';

export function createWatch(
  sys: Syscalls,
  port: MessagePort,
  cwd: () => string,
  retain: () => void,
  release: () => void,
  capture?: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
) {
  const deliveries = new Map<number, (message: unknown) => unknown>();
  let nextId = 0;
  port.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (
      !record(message) ||
      message.version !== VERSION ||
      message.type !== 'watch' ||
      typeof message.id !== 'number'
    )
      return;
    deliveries.get(message.id)?.(message);
  });
  port.start();
  return (filename: unknown, options: unknown = {}, listener?: unknown) => {
    if (typeof options === 'function') {
      listener = options;
      options = {};
    }
    if (typeof options === 'string') options = { encoding: options };
    if (filename instanceof URL) filename = fileURLToPath(filename);
    if (
      typeof filename !== 'string' ||
      !record(options) ||
      (listener !== undefined && typeof listener !== 'function')
    )
      throw fault('EINVAL', 'Invalid watcher arguments');
    if (Object.keys(options).some((key) => !['persistent', 'recursive', 'encoding'].includes(key)))
      throw fault('ENOSYS', 'Unsupported watcher option');
    if (
      (options.persistent !== undefined && typeof options.persistent !== 'boolean') ||
      (options.recursive !== undefined && typeof options.recursive !== 'boolean')
    )
      throw fault('EINVAL', 'Watcher flags must be boolean');
    const encoding = options.encoding ?? 'utf8';
    if (encoding !== 'utf8' && encoding !== 'buffer')
      throw fault('ENOSYS', 'Unsupported watcher filename encoding');
    const id = ++nextId;
    let closed = false;
    let referenced = options.persistent !== false;
    const watcher = Object.assign(new EventEmitter(), {
      close() {
        if (closed) return;
        closed = true;
        deliveries.delete(id);
        try {
          sys.call('unwatch', [id]);
        } finally {
          if (referenced) {
            referenced = false;
            release();
          }
          queueMicrotask(() => watcher.emit('close'));
        }
      },
      ref() {
        if (!closed && !referenced) {
          referenced = true;
          retain();
        }
        return watcher;
      },
      unref() {
        if (!closed && referenced) {
          referenced = false;
          release();
        }
        return watcher;
      },
    });
    if (typeof listener === 'function')
      watcher.on('change', (event, name) => listener.call(watcher, event, name));
    sys.call('watch', [id, path.resolve(cwd(), filename), options.recursive ?? false, encoding]);
    const deliver = (message: unknown) => {
      if (!record(message)) return;
      if (message.event === 'error' && record(message.error)) {
        watcher.close();
        watcher.emit('error', fault(String(message.error.code), String(message.error.message)));
      } else if (
        (message.event === 'rename' || message.event === 'change') &&
        (typeof message.filename === 'string' ||
          message.filename === null ||
          message.filename instanceof Uint8Array)
      ) {
        watcher.emit(
          'change',
          message.event,
          message.filename instanceof Uint8Array ? Buffer.from(message.filename) : message.filename,
        );
      }
    };
    deliveries.set(id, capture ? capture(deliver) : deliver);
    if (referenced) retain();
    return watcher;
  };
}
