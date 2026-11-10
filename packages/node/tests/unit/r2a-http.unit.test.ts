import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { type HttpBuiltinsDeps, createHttpBuiltins } from '../../src/builtins/http';
import { createNetBuiltin } from '../../src/builtins/net';
import { createTlsBuiltin } from '../../src/builtins/tls';
import {
  CAPACITY,
  HEADER_BYTES,
  Syscalls,
  createSyscallResponder,
  fault,
} from '../../src/protocol';

const EXPECTED_METHODS = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'QUERY',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE',
];

function makeTestHttpEnv(httpAgentMode: 'socket' | 'fetch' = 'socket') {
  const channel = new MessageChannel();
  const shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
  let nextPort = 4100;
  const responder = createSyscallResponder(shared, (op, args) => {
    if (op === 'listen') {
      const requested = Number(args[0] ?? 0);
      return requested > 0 ? requested : nextPort++;
    }
    if (op === 'closeServer') {
      return null;
    }
    throw fault('ENOSYS', `Unhandled test syscall ${op}`);
  });
  channel.port1.postMessage = (data: unknown) => {
    responder.handleMessage(data);
  };
  const sys = new Syscalls(channel.port1, shared, 500, CAPACITY);
  const stubProcess = new EventEmitter();
  const net = createNetBuiltin({
    sys,
    process: stubProcess,
    retain: () => {},
    release: () => {},
    events: EventEmitter,
    stream: {},
    setTimeout: () => ({}),
    clearTimeout: () => {},
    setImmediate: () => ({}),
  });
  const tls = createTlsBuiltin({ net });
  const deps: HttpBuiltinsDeps = {
    sys,
    retain: () => {},
    release: () => {},
    httpAgentMode,
    httpOmitHeaders: undefined,
    responseBytes: 1048576,
    process: stubProcess,
    events: EventEmitter,
    stream: {},
    net,
    tls,
    setTimeout: () => ({}),
    clearTimeout: () => {},
    setImmediate: () => ({}),
    clearImmediate: () => {},
    setInterval: () => ({}),
    clearInterval: () => {},
  };
  const { http, https } = createHttpBuiltins(deps);
  return {
    http: http.module,
    httpRuntime: http,
    https,
    net,
    tls,
    dispose() {
      responder.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('Lane R2a HTTP & HTTPS runtime surface', () => {
  it('Slice 1: top-level http constants, accessors, and RFC 7230 validators match Node v22.18.0', () => {
    const env = makeTestHttpEnv('socket');
    try {
      const { http } = env;

      expect(http.METHODS).toEqual(EXPECTED_METHODS);
      // Verified against Node v22.18.0: http.METHODS is a mutable sorted array descriptor.
      expect(Object.isFrozen(http.METHODS)).toBe(false);
      const methodsDesc = Object.getOwnPropertyDescriptor(http, 'METHODS');
      expect(methodsDesc?.writable).toBe(true);
      expect(methodsDesc?.enumerable).toBe(true);
      expect(methodsDesc?.configurable).toBe(true);

      const maxHeaderDesc = Object.getOwnPropertyDescriptor(http, 'maxHeaderSize');
      expect(maxHeaderDesc?.enumerable).toBe(true);
      expect(maxHeaderDesc?.configurable).toBe(true);
      expect(typeof maxHeaderDesc?.get).toBe('function');
      expect(maxHeaderDesc?.set).toBeUndefined();
      expect(Reflect.get(http, 'maxHeaderSize')).toBe(16384);

      const globalAgentDesc = Object.getOwnPropertyDescriptor(http, 'globalAgent');
      expect(globalAgentDesc?.enumerable).toBe(true);
      expect(globalAgentDesc?.configurable).toBe(true);
      expect(typeof globalAgentDesc?.get).toBe('function');
      expect(typeof globalAgentDesc?.set).toBe('function');
      expect(Reflect.get(http, 'globalAgent')).toBeInstanceOf(http.Agent);

      const setMaxIdle = Reflect.get(http, 'setMaxIdleHTTPParsers');
      expect(typeof setMaxIdle).toBe('function');
      if (typeof setMaxIdle === 'function') {
        expect(setMaxIdle(10)).toBeUndefined();
        expect(() => setMaxIdle(0)).toThrowError(
          expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
        );
        expect(() => setMaxIdle(-1)).toThrowError(
          expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
        );
        expect(() => setMaxIdle(1.5)).toThrowError(
          expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
        );
        expect(() => setMaxIdle('10')).toThrowError(
          expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
        );
      }

      const validateName = Reflect.get(http, 'validateHeaderName');
      expect(typeof validateName).toBe('function');
      if (typeof validateName === 'function') {
        expect(validateName('x-valid-token')).toBeUndefined();
        expect(() => validateName('')).toThrowError(
          expect.objectContaining({
            name: 'TypeError',
            code: 'ERR_INVALID_HTTP_TOKEN',
            message: 'Header name must be a valid HTTP token [""]',
          }),
        );
        expect(() => validateName(123, 'Custom label')).toThrowError(
          expect.objectContaining({
            name: 'TypeError',
            code: 'ERR_INVALID_HTTP_TOKEN',
            message: 'Custom label must be a valid HTTP token ["123"]',
          }),
        );
        expect(() => validateName('bad header')).toThrowError(
          expect.objectContaining({
            name: 'TypeError',
            code: 'ERR_INVALID_HTTP_TOKEN',
            message: 'Header name must be a valid HTTP token ["bad header"]',
          }),
        );
      }

      const validateValue = Reflect.get(http, 'validateHeaderValue');
      expect(typeof validateValue).toBe('function');
      if (typeof validateValue === 'function') {
        expect(validateValue('x-test', 'valid value \t\x80')).toBeUndefined();
        expect(() => validateValue('x-test', undefined)).toThrowError(
          expect.objectContaining({
            name: 'TypeError',
            code: 'ERR_HTTP_INVALID_HEADER_VALUE',
            message: 'Invalid value "undefined" for header "x-test"',
          }),
        );
        expect(() => validateValue('x-test', 'line1\r\nline2')).toThrowError(
          expect.objectContaining({
            name: 'TypeError',
            code: 'ERR_INVALID_CHAR',
            message: 'Invalid character in header content ["x-test"]',
          }),
        );
      }
    } finally {
      env.dispose();
    }
  });

  it('Slice 2: http.OutgoingMessage prototype methods, accessors, setHeaders, and addTrailers match Node v22.18.0', () => {
    const env = makeTestHttpEnv('socket');
    try {
      const { http, net } = env;
      const OutgoingMessageCtor = Reflect.get(http, 'OutgoingMessage');
      expect(typeof OutgoingMessageCtor).toBe('function');
      if (typeof OutgoingMessageCtor !== 'function') return;

      const proto = OutgoingMessageCtor.prototype;
      for (const accessorName of [
        'headersSent',
        'socket',
        'connection',
        'writableEnded',
        'writableFinished',
        'writableCorked',
        'writableHighWaterMark',
        'writableLength',
        'writableObjectMode',
      ]) {
        let cur: object | null = proto;
        let desc: PropertyDescriptor | undefined;
        while (cur && !desc) {
          desc = Object.getOwnPropertyDescriptor(cur, accessorName);
          cur = Object.getPrototypeOf(cur);
        }
        expect(typeof desc?.get, `accessor ${accessorName}`).toBe('function');
      }

      const msg = Reflect.construct(OutgoingMessageCtor, []);
      expect(msg.headersSent).toBe(false);
      expect(msg.socket).toBeNull();
      expect(msg.connection).toBeNull();

      msg.setHeader('X-First', 'alpha');
      expect(msg.hasHeader('x-first')).toBe(true);
      expect(msg.getHeader('X-FIRST')).toBe('alpha');
      expect(msg.getHeaderNames()).toEqual(['x-first']);
      expect(msg.getRawHeaderNames()).toEqual(['X-First']);

      msg.appendHeader('x-first', 'beta');
      expect(msg.getHeader('x-first')).toEqual(['alpha', 'beta']);

      const webHeaders = new Headers({ 'X-Web': '1', 'Set-Cookie': 'sid=abc' });
      msg.setHeaders(webHeaders);
      expect(msg.getHeader('x-web')).toBe('1');
      expect(msg.getHeader('set-cookie')).toEqual(['sid=abc']);

      const mapHeaders = new Map<string, unknown>([
        ['X-Map', ['m1', 'm2']],
        ['X-Count', 7],
      ]);
      msg.setHeaders(mapHeaders);
      const snapshot = msg.getHeaders();
      expect(Object.getPrototypeOf(snapshot)).toBeNull();
      expect(snapshot['x-map']).toEqual(['m1', 'm2']);
      expect(snapshot['x-count']).toBe(7);

      expect(() => msg.setHeaders({ invalid: 'plain-object' })).toThrowError(
        expect.objectContaining({
          name: 'TypeError',
          code: 'ERR_INVALID_ARG_TYPE',
        }),
      );

      msg.removeHeader('X-Web');
      expect(msg.hasHeader('x-web')).toBe(false);

      msg.addTrailers({ 'x-checksum': 'deadbeef' });
      msg.addTrailers([['x-second-trailer', 'ok']]);
      expect(() => msg.addTrailers({ 'bad trailer': 'val' })).toThrowError(
        expect.objectContaining({ code: 'ERR_INVALID_HTTP_TOKEN' }),
      );
      expect(() => msg.addTrailers({ 'x-bad': 'val\r\n' })).toThrowError(
        expect.objectContaining({ code: 'ERR_INVALID_CHAR' }),
      );

      const sock = new net.Socket();
      let timeoutSeen = false;
      msg.socket = sock;
      expect(msg.connection).toBe(sock);
      expect(msg.setTimeout(250, () => (timeoutSeen = true))).toBe(msg);
      expect(sock.timeout).toBe(250);
      msg.emit('timeout');
      expect(timeoutSeen).toBe(true);

      msg.flushHeaders();
      expect(msg.headersSent).toBe(true);
      expect(() => msg.setHeader('x-late', '1')).toThrowError(
        expect.objectContaining({ code: 'ERR_HTTP_HEADERS_SENT' }),
      );
    } finally {
      env.dispose();
    }
  });

  it('Slice 3: http.IncomingMessage supports standalone socket construction, prototype accessors, and client response inheritance', async () => {
    const env = makeTestHttpEnv('socket');
    try {
      const { http, net } = env;
      const sock = new net.Socket();
      const im = new http.IncomingMessage(sock);

      expect(im).toBeInstanceOf(http.IncomingMessage);
      expect(im.socket).toBe(sock);
      expect(im.connection).toBe(sock);
      expect(im.aborted).toBe(false);
      expect(im.complete).toBe(false);
      expect(im.httpVersion).toBeNull();
      expect(im.httpVersionMajor).toBeNull();
      expect(im.httpVersionMinor).toBeNull();
      expect(im.method).toBeNull();
      expect(im.url).toBe('');
      expect(im.statusCode).toBeNull();
      expect(im.statusMessage).toBeNull();
      expect(im.rawHeaders).toEqual([]);
      expect(im.rawTrailers).toEqual([]);

      for (const accessorName of [
        'connection',
        'headers',
        'headersDistinct',
        'trailers',
        'trailersDistinct',
      ]) {
        const desc = Object.getOwnPropertyDescriptor(http.IncomingMessage.prototype, accessorName);
        expect(typeof desc?.get, `IncomingMessage.prototype.${accessorName} getter`).toBe(
          'function',
        );
        expect(typeof desc?.set, `IncomingMessage.prototype.${accessorName} setter`).toBe(
          'function',
        );
      }

      const imWithRaw = new http.IncomingMessage(sock);
      imWithRaw.rawHeaders = [
        'X-Multi',
        'one',
        'X-Multi',
        'two',
        'Set-Cookie',
        'a=1',
        'Set-Cookie',
        'b=2',
        'Content-Type',
        'text/plain',
        'Content-Type',
        'text/html',
      ];
      imWithRaw.rawTrailers = ['X-Digest', 'sha256=abc', 'X-Digest', 'sha256=def'];

      expect(imWithRaw.headers).toEqual({
        'x-multi': 'one, two',
        'set-cookie': ['a=1', 'b=2'],
        'content-type': 'text/plain',
      });
      expect(imWithRaw.headersDistinct).toEqual({
        'x-multi': ['one', 'two'],
        'set-cookie': ['a=1', 'b=2'],
        'content-type': ['text/plain', 'text/html'],
      });
      expect(imWithRaw.trailers).toEqual({
        'x-digest': 'sha256=abc, sha256=def',
      });
      expect(imWithRaw.trailersDistinct).toEqual({
        'x-digest': ['sha256=abc', 'sha256=def'],
      });

      let timeoutFired = 0;
      expect(imWithRaw.setTimeout(320, () => timeoutFired++)).toBe(imWithRaw);
      expect(sock.timeout).toBe(320);
      imWithRaw.emit('timeout');
      expect(timeoutFired).toBe(1);

      const { Duplex } = await import('readable-stream/lib/stream.js');
      class CustomAgent extends http.Agent {
        createConnection() {
          const duplex = new Duplex({
            read() {},
            write(_chunk: unknown, _enc: string, done: () => void) {
              done();
              queueMicrotask(() => {
                duplex.push(
                  Buffer.from('HTTP/1.1 200 OK\r\nx-peer: yes\r\ncontent-length: 2\r\n\r\nhi'),
                );
                duplex.push(null);
              });
            },
          });
          return duplex;
        }
      }
      const clientRes = await new Promise<unknown>((resolve, reject) => {
        const req = http.get(
          { host: 'fixture.invalid', agent: new CustomAgent() },
          (res: { resume(): void }) => {
            res.resume();
            resolve(res);
          },
        );
        req.on('error', reject);
      });
      expect(clientRes).toBeInstanceOf(http.IncomingMessage);
    } finally {
      env.dispose();
    }
  });

  it('Slice 4: http.ServerResponse inherits from OutgoingMessage and supports standalone construction & informational methods', async () => {
    const env = makeTestHttpEnv('socket');
    try {
      const { http, net } = env;
      expect(Object.getPrototypeOf(http.ServerResponse.prototype)).toBe(
        http.OutgoingMessage.prototype,
      );

      const sock = new net.Socket();
      const req = new http.IncomingMessage(sock);
      const res = new http.ServerResponse(req);

      expect(res).toBeInstanceOf(http.ServerResponse);
      expect(res).toBeInstanceOf(http.OutgoingMessage);
      expect(res.req).toBe(req);
      expect(res.socket).toBeNull();
      expect(res.connection).toBeNull();
      expect(res.statusCode).toBe(200);
      expect(res.statusMessage).toBeUndefined();
      expect(res.sendDate).toBe(true);
      expect(res.strictContentLength).toBe(false);
      expect(res.finished).toBe(false);
      expect(res.headersSent).toBe(false);
      expect(Object.getOwnPropertyDescriptor(res, 'headersSent')).toBeUndefined();

      res.assignSocket(sock);
      expect(res.socket).toBe(sock);
      expect(res.connection).toBe(sock);
      res.detachSocket(sock);
      expect(res.socket).toBeNull();

      res.setHeaders(new Headers({ 'X-From-Headers': 'yes' }));
      expect(res.getHeader('x-from-headers')).toBe('yes');
      expect(res.getRawHeaderNames()).toEqual(['x-from-headers']);

      expect(() => res.writeEarlyHints(null)).toThrowError(
        expect.objectContaining({
          name: 'TypeError',
          code: 'ERR_INVALID_ARG_TYPE',
        }),
      );

      let earlyCbCalled = false;
      let continueCbCalled = false;
      let processingCbCalled = false;
      res.writeEarlyHints({ link: '</app.css>; rel=preload; as=style' }, () => {
        earlyCbCalled = true;
      });
      res.writeContinue(() => {
        continueCbCalled = true;
      });
      res.writeProcessing(() => {
        processingCbCalled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(earlyCbCalled).toBe(true);
      expect(continueCbCalled).toBe(true);
      expect(processingCbCalled).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it('Slice 5: http.ClientRequest inherits from OutgoingMessage and covers both socket-agent and fetch-mode requests', async () => {
    const socketEnv = makeTestHttpEnv('socket');
    const fetchEnv = makeTestHttpEnv('fetch');
    try {
      const { http } = socketEnv;
      const ClientRequestCtor = Reflect.get(http, 'ClientRequest');
      expect(typeof ClientRequestCtor).toBe('function');
      if (typeof ClientRequestCtor !== 'function') return;

      expect(Object.getPrototypeOf(ClientRequestCtor.prototype)).toBe(
        http.OutgoingMessage.prototype,
      );

      for (const methodName of [
        'abort',
        'cork',
        'destroy',
        'end',
        'flushHeaders',
        'getHeader',
        'getHeaderNames',
        'getHeaders',
        'getRawHeaderNames',
        'hasHeader',
        'removeHeader',
        'setHeader',
        'setNoDelay',
        'setSocketKeepAlive',
        'setTimeout',
        'uncork',
        'write',
      ]) {
        expect(typeof Reflect.get(ClientRequestCtor.prototype, methodName), methodName).toBe(
          'function',
        );
      }

      const { Duplex } = await import('readable-stream/lib/stream.js');
      let noDelayCalls = 0;
      let keepAliveCalls = 0;
      class TestDuplex extends Duplex {
        setNoDelay() {
          noDelayCalls++;
          return this;
        }
        setKeepAlive() {
          keepAliveCalls++;
          return this;
        }
      }
      class CustomAgent extends http.Agent {
        createConnection() {
          const d = new TestDuplex({
            read() {},
            write(_chunk: unknown, _enc: string, done: () => void) {
              done();
            },
          });
          return d;
        }
      }

      const reqFromCall = http.request({
        host: 'fixture.invalid',
        port: 8080,
        path: '/items',
        method: 'POST',
        agent: new CustomAgent(),
      });
      expect(reqFromCall).toBeInstanceOf(ClientRequestCtor);
      expect(reqFromCall).toBeInstanceOf(http.OutgoingMessage);
      expect(Reflect.get(reqFromCall, 'method')).toBe('POST');
      expect(Reflect.get(reqFromCall, 'path')).toBe('/items');
      expect(Reflect.get(reqFromCall, 'host')).toBe('fixture.invalid');
      expect(Reflect.get(reqFromCall, 'protocol')).toBe('http:');
      expect(Reflect.get(reqFromCall, 'maxHeadersCount')).toBeNull();
      expect(Reflect.get(reqFromCall, 'reusedSocket')).toBe(false);
      expect(Reflect.get(reqFromCall, 'aborted')).toBe(false);
      expect(Reflect.get(reqFromCall, 'finished')).toBe(false);

      Reflect.apply(ClientRequestCtor.prototype.setNoDelay, reqFromCall, [true]);
      Reflect.apply(ClientRequestCtor.prototype.setSocketKeepAlive, reqFromCall, [true, 1000]);
      expect(noDelayCalls).toBe(1);
      expect(keepAliveCalls).toBe(1);
      reqFromCall.abort();
      expect(Reflect.get(reqFromCall, 'aborted')).toBe(true);

      const reqFromNew = Reflect.construct(ClientRequestCtor, [
        { host: 'fixture.invalid', agent: new CustomAgent() },
      ]);
      expect(reqFromNew).toBeInstanceOf(ClientRequestCtor);
      expect(reqFromNew).toBeInstanceOf(http.OutgoingMessage);
      reqFromNew.destroy();

      const FetchClientRequestCtor = Reflect.get(fetchEnv.http, 'ClientRequest');
      expect(typeof FetchClientRequestCtor).toBe('function');
      if (typeof FetchClientRequestCtor === 'function') {
        const fetchReq = fetchEnv.http.request('http://127.0.0.1:49999/test');
        fetchReq.on('error', () => {});
        expect(fetchReq).toBeInstanceOf(FetchClientRequestCtor);
        expect(fetchReq).toBeInstanceOf(fetchEnv.http.OutgoingMessage);
        expect(Reflect.get(fetchReq, 'maxHeadersCount')).toBeNull();
        fetchReq.destroy();
      }
    } finally {
      socketEnv.dispose();
      fetchEnv.dispose();
    }
  });

  it('Slice 6: http.Agent, http.Server, and node:https (globalAgent, Agent, Server) match Node v22.18.0 while preserving ENOSYS guards', async () => {
    const socketEnv = makeTestHttpEnv('socket');
    const fetchEnv = makeTestHttpEnv('fetch');
    try {
      for (const env of [socketEnv, fetchEnv]) {
        const agent = new env.http.Agent();
        expect(Reflect.get(agent, 'defaultPort')).toBe(80);
        expect(Reflect.get(agent, 'protocol')).toBe('http:');
        expect(Reflect.get(agent, 'maxSockets')).toBe(Number.POSITIVE_INFINITY);
        expect(Reflect.get(agent, 'maxFreeSockets')).toBe(256);
        expect(Reflect.get(agent, 'maxTotalSockets')).toBe(Number.POSITIVE_INFINITY);
        expect(Object.getPrototypeOf(Reflect.get(agent, 'freeSockets'))).toBeNull();
        expect(Object.getPrototypeOf(Reflect.get(agent, 'sockets'))).toBeNull();
        expect(Object.getPrototypeOf(Reflect.get(agent, 'requests'))).toBeNull();

        const getNameFn = Reflect.get(env.http.Agent.prototype, 'getName');
        const keepSocketAliveFn = Reflect.get(env.http.Agent.prototype, 'keepSocketAlive');
        const reuseSocketFn = Reflect.get(env.http.Agent.prototype, 'reuseSocket');
        expect(typeof getNameFn).toBe('function');
        expect(typeof keepSocketAliveFn).toBe('function');
        expect(typeof reuseSocketFn).toBe('function');
        if (
          typeof getNameFn === 'function' &&
          typeof keepSocketAliveFn === 'function' &&
          typeof reuseSocketFn === 'function'
        ) {
          expect(Reflect.apply(getNameFn, agent, [])).toBe('localhost::');
          expect(
            Reflect.apply(getNameFn, agent, [
              { host: 'example.com', port: 8080, localAddress: '127.0.0.1', family: 4 },
            ]),
          ).toBe('example.com:8080:127.0.0.1:4');
          const sock = new env.net.Socket();
          expect(Reflect.apply(keepSocketAliveFn, agent, [sock])).toBe(true);
          const dummyReq = { reusedSocket: false };
          Reflect.apply(reuseSocketFn, agent, [sock, dummyReq]);
          expect(dummyReq.reusedSocket).toBe(true);
        }
      }

      expect(() => new socketEnv.http.Agent({ keepAlive: true })).toThrowError(
        expect.objectContaining({ code: 'ENOSYS' }),
      );

      const { http, https, net, tls } = socketEnv;
      const listeningDesc = Object.getOwnPropertyDescriptor(http.Server.prototype, 'listening');
      expect(typeof listeningDesc?.get).toBe('function');

      let reqSeen = false;
      const server = http.createServer({}, () => {
        reqSeen = true;
      });
      expect(server).toBeInstanceOf(net.Server);
      expect(server.listening).toBe(false);
      expect(Object.getOwnPropertyDescriptor(server, 'listening')).toBeUndefined();
      expect(Reflect.get(server, 'timeout')).toBe(0);
      expect(Reflect.get(server, 'headersTimeout')).toBe(60000);
      expect(Reflect.get(server, 'keepAliveTimeout')).toBe(5000);
      expect(Reflect.get(server, 'requestTimeout')).toBe(300000);
      expect(Reflect.get(server, 'maxHeadersCount')).toBeNull();
      expect(Reflect.get(server, 'maxRequestsPerSocket')).toBe(0);
      server.emit('request');
      expect(reqSeen).toBe(true);

      let srvTimeout = false;
      const setTimeoutSrv = Reflect.get(server, 'setTimeout');
      expect(typeof setTimeoutSrv).toBe('function');
      if (typeof setTimeoutSrv === 'function') {
        expect(
          Reflect.apply(setTimeoutSrv, server, [
            1500,
            () => {
              srvTimeout = true;
            },
          ]),
        ).toBe(server);
      }
      expect(Reflect.get(server, 'timeout')).toBe(1500);
      server.emit('timeout');
      expect(srvTimeout).toBe(true);

      expect(typeof Reflect.get(server, 'closeAllConnections')).toBe('function');
      expect(typeof Reflect.get(server, 'closeIdleConnections')).toBe('function');
      const asyncDisposeFn = Reflect.get(server, Symbol.asyncDispose);
      expect(typeof asyncDisposeFn).toBe('function');
      if (typeof asyncDisposeFn === 'function') {
        await expect(Reflect.apply(asyncDisposeFn, server, [])).rejects.toMatchObject({
          code: 'ERR_SERVER_NOT_RUNNING',
        });
        server.listen(4321);
        expect(server.listening).toBe(true);
        await expect(Reflect.apply(asyncDisposeFn, server, [])).resolves.toBeUndefined();
        expect(server.listening).toBe(false);
      }

      const httpsGlobalDesc = Object.getOwnPropertyDescriptor(https, 'globalAgent');
      expect(httpsGlobalDesc?.writable).toBe(true);
      expect(httpsGlobalDesc?.enumerable).toBe(true);
      expect(httpsGlobalDesc?.configurable).toBe(true);
      expect('value' in (httpsGlobalDesc ?? {})).toBe(true);

      const httpsGlobalAgent = Reflect.get(https, 'globalAgent');
      expect(httpsGlobalAgent).toBeInstanceOf(https.Agent);
      expect(https.Agent).not.toBe(http.Agent);
      expect(https.Agent).not.toBe(fetchEnv.http.Agent);
      expect(Reflect.get(httpsGlobalAgent, 'defaultPort')).toBe(443);
      expect(Reflect.get(httpsGlobalAgent, 'protocol')).toBe('https:');

      const httpsGetName = Reflect.get(https.Agent.prototype, 'getName');
      expect(typeof httpsGetName).toBe('function');
      if (typeof httpsGetName === 'function') {
        expect(Reflect.apply(httpsGetName, httpsGlobalAgent, [])).toBe(
          'localhost::::::::::::::::::::::',
        );
        expect(
          Reflect.apply(httpsGetName, httpsGlobalAgent, [
            {
              host: 'example.com',
              port: 443,
              servername: 'sni.example.com',
              rejectUnauthorized: false,
            },
          ]),
        ).toBe('example.com:443::::::::false:sni.example.com::::::::::::');
      }

      const HttpsServerCtor = Reflect.get(https, 'Server');
      expect(typeof HttpsServerCtor).toBe('function');
      if (typeof HttpsServerCtor === 'function') {
        const httpsServer = Reflect.construct(HttpsServerCtor, []);
        expect(httpsServer).toBeInstanceOf(tls.Server);
        expect(Reflect.get(httpsServer, 'timeout')).toBe(0);
        expect(Reflect.get(httpsServer, 'headersTimeout')).toBe(60000);
        expect(Reflect.get(httpsServer, 'keepAliveTimeout')).toBe(5000);
        expect(Reflect.get(httpsServer, 'requestTimeout')).toBe(300000);
        expect(Reflect.get(httpsServer, 'maxHeadersCount')).toBeNull();
        expect(typeof Reflect.get(HttpsServerCtor.prototype, 'close')).toBe('function');
        expect(typeof Reflect.get(HttpsServerCtor.prototype, 'closeAllConnections')).toBe(
          'function',
        );
        expect(typeof Reflect.get(HttpsServerCtor.prototype, 'closeIdleConnections')).toBe(
          'function',
        );
        expect(typeof Reflect.get(HttpsServerCtor.prototype, 'setTimeout')).toBe('function');
        expect(typeof Reflect.get(HttpsServerCtor.prototype, 'listen')).toBe('function');
        expect(typeof Reflect.get(HttpsServerCtor.prototype, Symbol.asyncDispose)).toBe('function');
        expect(() => httpsServer.listen(443)).toThrowError(
          expect.objectContaining({ code: 'ENOSYS' }),
        );
      }

      expect(() => https.createServer()).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));
      expect(() => https.get({})).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));
      expect(() => https.request({})).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));
    } finally {
      socketEnv.dispose();
      fetchEnv.dispose();
    }
  });
});
