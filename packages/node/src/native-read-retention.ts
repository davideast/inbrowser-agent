// Native Blob and body reads settle off-thread in the browser, and a pending guest
// promise alone does not keep a process alive, so a script whose only pending work is
// `await blob.text()` or `await new Response('x').json()` would exit before the read
// settles. Node keeps its loop alive for these reads. Each read here holds the process
// until it settles, as the WebCrypto operations in process.ts do.

/** `retain` holds the process and returns the function that releases it. */
type Retain = () => () => void;

/**
 * Replaces each promise-returning method on `prototype` with one that holds the
 * process until the returned promise settles, unless `skip(this)` is true. Name,
 * length and the settled value or reason are the browser's own.
 */
function retainMethods(
  prototype: object,
  names: readonly string[],
  retain: Retain,
  skip: (receiver: unknown) => boolean = () => false,
) {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const original: unknown = descriptor?.value;
    if (!descriptor || typeof original !== 'function') continue;
    const retained = {
      [name](this: unknown, ...args: unknown[]): unknown {
        if (skip(this)) return Reflect.apply(original, this, args);
        const release = retain();
        let pending: unknown;
        try {
          pending = Reflect.apply(original, this, args);
        } catch (error) {
          release();
          throw error;
        }
        if (!(pending instanceof Promise)) {
          release();
          return pending;
        }
        return pending.finally(release);
      },
    }[name];
    Object.defineProperty(retained, 'length', { value: original.length });
    Object.defineProperty(prototype, name, { ...descriptor, value: retained });
  }
}

/**
 * Blob#stream returns a byte stream that reads the native one. Each pull, which the
 * stream makes only while its queue is below the high-water mark or a reader waits,
 * holds the process until the native read settles; a stream nobody reads holds
 * nothing once its queue is full.
 */
function retainBlobStream(retain: Retain) {
  const descriptor = Object.getOwnPropertyDescriptor(Blob.prototype, 'stream');
  const original: unknown = descriptor?.value;
  if (!descriptor || typeof original !== 'function') return;
  const stream = {
    stream(this: Blob): ReadableStream<Uint8Array<ArrayBuffer>> {
      // Invariant: the browser's Blob#stream returns a ReadableStream of Uint8Arrays
      // over ArrayBuffers and throws a TypeError for a receiver that is not a Blob.
      const source = Reflect.apply(original, this, []) as ReadableStream<Uint8Array<ArrayBuffer>>;
      const reader = source.getReader();
      return new ReadableStream({
        type: 'bytes',
        async pull(controller) {
          const release = retain();
          try {
            const { value, done } = await reader.read();
            if (done) {
              controller.close();
              // A pending BYOB request must be answered with zero bytes after close.
              controller.byobRequest?.respond(0);
            } else controller.enqueue(value);
          } finally {
            release();
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    },
  }.stream;
  Object.defineProperty(stream, 'length', { value: original.length });
  Object.defineProperty(Blob.prototype, 'stream', { ...descriptor, value: stream });
}

/** Reads a stream body to the end in guest JavaScript, as undici's fullyReadBody does. */
async function readStreamBody(stream: ReadableStream<unknown>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // undici's message for the same TypeError.
    if (!(value instanceof Uint8Array)) throw new TypeError('Received non-Uint8Array chunk');
    chunks.push(value);
    length += value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type Body = { readonly body: ReadableStream<unknown> | null; readonly bodyUsed: boolean };

/**
 * Response and Request body reads. A body made from a string, Blob, buffer, FormData
 * or URLSearchParams is read natively, and the read holds the process until it
 * settles. A body made from a ReadableStream progresses only as its source supplies
 * data, so holding the process would keep a never-filled stream alive, unlike Node;
 * and the browser consumes such a body across tasks, so leaving it unheld would end a
 * process whose stream already holds its data. Node (undici) reads these bodies in
 * JavaScript, so arrayBuffer, bytes, text, json and blob do the same here, holding
 * nothing; a used or locked body, and formData, still take the browser's own path.
 * Recognizing a stream body needs the constructor argument, so the two globals become
 * construct proxies of the browser's classes: prototype, statics, instanceof and
 * subclassing are the browser's, and `constructor` on the prototype names the proxy
 * so `response.constructor === Response` holds. A Request init's `body` is read once
 * more after construction to decide.
 */
function retainBodyReads(retain: Retain) {
  const streamBodied = new WeakSet<object>();
  const isStream = (value: unknown) => value instanceof ReadableStream;
  const classes = [
    // new Response(body, init)
    [Response, (args: unknown[]) => isStream(args[0])],
    // new Request(input, init): init.body, else the body of a Request input
    [
      Request,
      (args: unknown[]) => {
        const init = args[1];
        const body =
          typeof init === 'object' && init !== null ? (init as { body?: unknown }).body : undefined;
        if (body !== undefined && body !== null) return isStream(body);
        return typeof args[0] === 'object' && args[0] !== null && streamBodied.has(args[0]);
      },
    ],
  ] as const;
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  for (const [Class, fromStream] of classes) {
    const proxy = new Proxy(Class, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget) as object;
        if (fromStream(args)) streamBodied.add(instance);
        return instance;
      },
    });
    const global = Object.getOwnPropertyDescriptor(globalThis, Class.name);
    if (!global) continue;
    Object.defineProperty(globalThis, Class.name, { ...global, value: proxy });
    const ctorDescriptor = Object.getOwnPropertyDescriptor(Class.prototype, 'constructor');
    if (ctorDescriptor)
      Object.defineProperty(Class.prototype, 'constructor', { ...ctorDescriptor, value: proxy });
    // A clone tees the same source.
    const clone = Object.getOwnPropertyDescriptor(Class.prototype, 'clone');
    const originalClone: unknown = clone?.value;
    if (clone && typeof originalClone === 'function') {
      const trackedClone = {
        clone(this: object) {
          const copy = Reflect.apply(originalClone, this, []) as object;
          if (streamBodied.has(this)) streamBodied.add(copy);
          return copy;
        },
      }.clone;
      Object.defineProperty(Class.prototype, 'clone', { ...clone, value: trackedClone });
    }
    // The MIME type a native blob() would give, from the same Content-Type value.
    const mimeType = async (body: { headers: Headers }) => {
      const type = body.headers.get('content-type');
      if (type === null) return '';
      return (await new Response(null, { headers: { 'content-type': type } }).blob()).type;
    };
    const readers: Record<string, (bytes: Uint8Array<ArrayBuffer>, body: object) => unknown> = {
      arrayBuffer: (bytes) => bytes.buffer,
      bytes: (bytes) => bytes,
      text: (bytes) => decode(bytes),
      json: (bytes) => JSON.parse(decode(bytes)),
      blob: async (bytes, body) =>
        new Blob([bytes], { type: await mimeType(body as { headers: Headers }) }),
    };
    const isStreamBodied = (receiver: unknown) =>
      typeof receiver === 'object' && receiver !== null && streamBodied.has(receiver);
    retainMethods(
      Class.prototype,
      ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'],
      retain,
      isStreamBodied,
    );
    for (const [name, finish] of Object.entries(readers)) {
      const descriptor = Object.getOwnPropertyDescriptor(Class.prototype, name);
      const native: unknown = descriptor?.value;
      if (!descriptor || typeof native !== 'function') continue;
      const read = {
        [name](this: unknown, ...args: unknown[]): unknown {
          // Invariant: a stream-bodied receiver is a Response or Request instance.
          const body = this as Body;
          if (!isStreamBodied(this) || body.bodyUsed || !body.body || body.body.locked)
            return Reflect.apply(native, this, args);
          const stream = body.body;
          return (async () => finish(await readStreamBody(stream), body))();
        },
      }[name];
      Object.defineProperty(read, 'length', { value: native.length });
      Object.defineProperty(Class.prototype, name, { ...descriptor, value: read });
    }
  }
}

/** Holds the process across Blob (and File) and Response/Request body reads. */
export function retainNativeReads(retain: Retain) {
  retainMethods(Blob.prototype, ['arrayBuffer', 'bytes', 'text'], retain);
  retainBlobStream(retain);
  retainBodyReads(retain);
}
