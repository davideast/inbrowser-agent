import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { createDnsBuiltins } from '../../src/builtins/dns';
import { createHttp2Builtin } from '../../src/builtins/http2';
import { createNetBuiltin } from '../../src/builtins/net';
import { createConstantsBuiltin, createOsBuiltin } from '../../src/builtins/os';
import { createTlsBuiltin } from '../../src/builtins/tls';
import {
  BlockList,
  SocketAddress,
  canonicalizeIP,
  isIP,
  isIPv4,
  isIPv6,
} from '../../src/net-address';
import { CAPACITY, HEADER_BYTES, Syscalls } from '../../src/protocol';
import {
  checkServerIdentity,
  convertALPNProtocols,
  getCACertificates,
  getCiphers,
} from '../../src/tls-identity';

function createTestSyscalls(): Syscalls {
  const shared = new SharedArrayBuffer(HEADER_BYTES + CAPACITY);
  const { port1, port2 } = new MessageChannel();
  port1.close();
  port2.close();
  return new Syscalls(port1, shared, 500, CAPACITY);
}

describe('Lane R1a pure constants and network helpers', () => {
  it('merges os, fs, and crypto constants into a distinct frozen object with null-prototype groups', () => {
    const stubProcess = Object.assign(new EventEmitter(), {
      platform: 'linux',
      arch: 'x64',
      env: {},
    });
    const osBuiltin = createOsBuiltin({
      process: stubProcess,
      advisoryFreeMemory: () => 4096,
    });
    expect(Object.getPrototypeOf(osBuiltin.constants)).toBe(null);
    expect(Object.getPrototypeOf(osBuiltin.constants.errno)).toBe(null);
    expect(Object.getPrototypeOf(osBuiltin.constants.signals)).toBe(null);
    expect(Object.getPrototypeOf(osBuiltin.constants.dlopen)).toBe(null);
    expect(Object.getPrototypeOf(osBuiltin.constants.priority)).toBe(null);
    expect(osBuiltin.constants.UV_UDP_REUSEADDR).toBe(4);
    expect(osBuiltin.constants.errno.ENOSYS).toBe(38);
    expect(osBuiltin.constants.signals.SIGKILL).toBe(9);

    const fsConstants = { O_RDONLY: 0, O_CREAT: 64 };
    const cryptoConstants = { POINT_CONVERSION_COMPRESSED: 2 };
    const merged = createConstantsBuiltin({
      osConstants: osBuiltin.constants,
      fsConstants,
      cryptoConstants,
    });
    expect(merged).not.toBe(fsConstants);
    expect(Object.isFrozen(merged)).toBe(true);
    expect(merged).toMatchObject({
      O_RDONLY: 0,
      O_CREAT: 64,
      POINT_CONVERSION_COMPRESSED: 2,
      ENOSYS: 38,
      SIGKILL: 9,
      RTLD_NOW: 2,
      PRIORITY_HIGHEST: -20,
    });
  });

  it('packs and unpacks RFC 7540 HTTP/2 SETTINGS frames and validates ranges', () => {
    const http2 = createHttp2Builtin();
    expect(Object.keys(http2.constants).length).toBe(240);
    const defaults = http2.getDefaultSettings();
    expect(defaults).toEqual({
      headerTableSize: 4096,
      enablePush: true,
      initialWindowSize: 65535,
      maxFrameSize: 16384,
      maxConcurrentStreams: 4294967295,
      maxHeaderListSize: 65535,
      maxHeaderSize: 65535,
      enableConnectProtocol: false,
    });

    const packed = http2.getPackedSettings({
      headerTableSize: 8192,
      enablePush: false,
      customSettings: { 4660: 99 },
    });
    expect(packed.byteLength).toBe(18);
    expect(http2.getUnpackedSettings(packed)).toEqual({
      headerTableSize: 8192,
      enablePush: false,
      customSettings: { 4660: 99 },
    });
    expect(() => http2.getUnpackedSettings(Buffer.alloc(5))).toThrowError(
      expect.objectContaining({ code: 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH' }),
    );
    expect(() => http2.getPackedSettings({ maxFrameSize: 16383 })).toThrowError(
      expect.objectContaining({ code: 'ERR_HTTP2_INVALID_SETTING_VALUE' }),
    );
    expect(() => http2.getPackedSettings({ enablePush: 'yes' })).toThrowError(
      expect.objectContaining({ code: 'ERR_HTTP2_INVALID_SETTING_VALUE' }),
    );
    expect(() => http2.performServerHandshake()).toThrowError(
      expect.objectContaining({ code: 'ENOSYS' }),
    );
  });

  it('handles IPv4/IPv6 canonicalization, SocketAddress parsing, and BlockList JSON round-trips', () => {
    expect(isIP(null)).toBe(0);
    expect(isIPv4('192.168.0.1')).toBe(true);
    expect(isIPv4('01.0.0.1')).toBe(false);
    expect(isIPv6('fe80::1%eth0')).toBe(true);
    expect(isIPv6('fe80::1%')).toBe(false);
    expect(canonicalizeIP('2001:0db8:0000:0000:0001:0000:0000:0001')).toBe('2001:db8::1:0:0:1');
    expect(canonicalizeIP('::ffff:127.0.0.1')).toBe('::ffff:127.0.0.1');

    const parsed = SocketAddress.parse('[2001:0db8::1]:443');
    expect(parsed?.toJSON()).toEqual({
      address: '2001:db8::1',
      port: 443,
      family: 'ipv6',
      flowlabel: 0,
    });
    expect(SocketAddress.isSocketAddress(parsed)).toBe(true);
    expect(SocketAddress.isSocketAddress({})).toBe(false);

    const list = new BlockList();
    list.addAddress('192.0.2.1');
    list.addRange('198.51.100.1', '198.51.100.10');
    list.addSubnet('2001:db8::', 32, 'ipv6');
    expect(BlockList.isBlockList(list)).toBe(true);

    const restored = new BlockList();
    restored.fromJSON(JSON.stringify(list.toJSON()));
    expect(restored.rules).toEqual(list.rules);
    expect(restored.check('::ffff:192.0.2.1', 'ipv6')).toBe(true);
    expect(restored.check('198.51.100.5')).toBe(true);
    expect(restored.check('2001:db8:abcd::1', 'ipv6')).toBe(true);
    expect(() => restored.fromJSON(['Bogus: 1.2.3.4'])).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }),
    );
  });

  it('validates DNS result order, Resolver server lists, and TLS identity verification', async () => {
    const sys = createTestSyscalls();
    const stubProcess = Object.assign(new EventEmitter(), { env: {} });
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
    expect(net.Stream).toBe(net.Socket);
    let connected = 0;
    const srv = net.createServer(undefined, () => {
      connected += 1;
    });
    srv.emit('connection');
    expect(connected).toBe(1);

    const { dns, 'dns/promises': dnsPromises } = createDnsBuiltins(net.isIP);
    expect(dns.promises).toBe(dnsPromises);
    expect(dns.getDefaultResultOrder()).toBe('verbatim');
    dnsPromises.setDefaultResultOrder('ipv6first');
    expect(dns.getDefaultResultOrder()).toBe('ipv6first');
    await expect(dnsPromises.lookup('localhost')).resolves.toEqual({
      address: '::1',
      family: 6,
    });
    dns.setDefaultResultOrder('verbatim');

    const resolver = new dnsPromises.Resolver();
    resolver.setServers(['127.0.0.1:5353', '[::1]:5353', '8.8.8.8:53']);
    expect(resolver.getServers()).toEqual(['127.0.0.1:5353', '[::1]:5353', '8.8.8.8']);
    expect(() => resolver.setServers(['not-an-ip'])).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_IP_ADDRESS' }),
    );
    expect(() => resolver.setServers(['127.0.0.1:-1'])).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_IP_ADDRESS' }),
    );

    const tls = createTlsBuiltin({ net });
    expect(Object.isFrozen(tls.rootCertificates)).toBe(true);
    expect(getCACertificates('default')).toBe(tls.rootCertificates);
    expect(getCiphers().length).toBe(62);

    const out: { ALPNProtocols?: Buffer } = {};
    convertALPNProtocols(['h2'], out);
    expect(out.ALPNProtocols).toEqual(Buffer.from([2, 104, 50]));

    expect(
      checkServerIdentity('api.example.com', {
        subject: { CN: 'ignored.example.com' },
        subjectaltname: 'DNS:*.example.com',
      }),
    ).toBeUndefined();
    const mismatch = checkServerIdentity('a.b.example.com', {
      subject: {},
      subjectaltname: 'DNS:*.example.com',
    });
    expect(mismatch).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });
});
