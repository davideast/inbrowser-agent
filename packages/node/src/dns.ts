import { validatePort } from './net-address';
import {
  invalidArgType,
  invalidArgValue,
  nodeError,
  validateInteger,
  validateNumber,
} from './node-errors';
import { fault, record } from './protocol';

export type DnsResultOrder = 'ipv4first' | 'ipv6first' | 'verbatim';

const VALID_DNS_ORDERS: readonly DnsResultOrder[] = ['verbatim', 'ipv4first', 'ipv6first'];

const DNS_FLAGS = {
  ADDRCONFIG: 32,
  ALL: 16,
  V4MAPPED: 8,
} as const;

const DNS_ERROR_CODES = {
  NODATA: 'ENODATA',
  FORMERR: 'EFORMERR',
  SERVFAIL: 'ESERVFAIL',
  NOTFOUND: 'ENOTFOUND',
  NOTIMP: 'ENOTIMP',
  REFUSED: 'EREFUSED',
  BADQUERY: 'EBADQUERY',
  BADNAME: 'EBADNAME',
  BADFAMILY: 'EBADFAMILY',
  BADRESP: 'EBADRESP',
  CONNREFUSED: 'ECONNREFUSED',
  TIMEOUT: 'ETIMEOUT',
  EOF: 'EOF',
  FILE: 'EFILE',
  NOMEM: 'ENOMEM',
  DESTRUCTION: 'EDESTRUCTION',
  BADSTR: 'EBADSTR',
  BADFLAGS: 'EBADFLAGS',
  NONAME: 'ENONAME',
  BADHINTS: 'EBADHINTS',
  NOTINITIALIZED: 'ENOTINITIALIZED',
  LOADIPHLPAPI: 'ELOADIPHLPAPI',
  ADDRGETNETWORKPARAMS: 'EADDRGETNETWORKPARAMS',
  CANCELLED: 'ECANCELLED',
} as const;

const IANA_DNS_PORT = 53;
const IPV6_BRACKET_RE = /^\[([^[\]]*)\](?::(\d+))?$/;
const ADDR_SPLIT_RE = /^(^.+?)(?::(\d+))?$/;

const VALID_RR_TYPES = new Set([
  'A',
  'AAAA',
  'ANY',
  'CAA',
  'CNAME',
  'MX',
  'NAPTR',
  'NS',
  'PTR',
  'SOA',
  'SRV',
  'TLSA',
  'TXT',
]);

interface ServerEntry {
  family: number;
  ip: string;
  port: number;
}

function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw invalidArgType(name, 'string', value);
  }
}

function validateFunction(
  value: unknown,
  name: string,
): asserts value is (...args: unknown[]) => void {
  if (typeof value !== 'function') {
    throw invalidArgType(name, 'Function', value);
  }
}

function validateDnsOrder(value: unknown, name: string): asserts value is DnsResultOrder {
  if (
    typeof value !== 'string' ||
    (value !== 'verbatim' && value !== 'ipv4first' && value !== 'ipv6first')
  ) {
    throw invalidArgValue(
      name,
      value,
      `must be one of: ${VALID_DNS_ORDERS.map((v) => `'${v}'`).join(', ')}`,
    );
  }
}

function parseServerList(servers: unknown, isIP: (value: string) => number): ServerEntry[] {
  if (!Array.isArray(servers)) {
    throw invalidArgType('servers', 'Array', servers);
  }
  const parsed: ServerEntry[] = [];
  for (let index = 0; index < servers.length; index++) {
    const serv: unknown = servers[index];
    validateString(serv, `servers[${index}]`);
    const directFamily = isIP(serv);
    if (directFamily !== 0) {
      parsed.push({ family: directFamily, ip: serv, port: IANA_DNS_PORT });
      continue;
    }

    const bracketMatch = IPV6_BRACKET_RE.exec(serv);
    if (bracketMatch) {
      const host = bracketMatch[1]!;
      const fam = isIP(host);
      if (fam !== 0) {
        const rawPort = bracketMatch[2] ? Number.parseInt(bracketMatch[2], 10) : IANA_DNS_PORT;
        const port = rawPort > 0 ? rawPort & 0xffff : IANA_DNS_PORT;
        parsed.push({ family: fam, ip: host, port });
        continue;
      }
    }

    const splitMatch = ADDR_SPLIT_RE.exec(serv);
    if (splitMatch && splitMatch[2] !== undefined) {
      const host = splitMatch[1]!;
      const fam = isIP(host);
      if (fam !== 0) {
        const rawPort = Number.parseInt(splitMatch[2], 10);
        const port = rawPort > 0 ? rawPort & 0xffff : IANA_DNS_PORT;
        parsed.push({ family: fam, ip: host, port });
        continue;
      }
    }

    throw nodeError(TypeError, 'ERR_INVALID_IP_ADDRESS', `Invalid IP address: ${serv}`);
  }
  return parsed;
}

function formatServerList(entries: readonly ServerEntry[]): string[] {
  return entries.map((entry) => {
    if (!entry.port || entry.port === IANA_DNS_PORT) {
      return entry.ip;
    }
    const host = entry.family === 6 ? `[${entry.ip}]` : entry.ip;
    return `${host}:${entry.port}`;
  });
}

function validateResolverOptions(options: unknown): void {
  if (options === undefined || options === null || typeof options !== 'object') {
    return;
  }
  const opts = record(options) ? options : {};
  const timeout = opts.timeout ?? -1;
  validateInteger(timeout, 'options.timeout', -1, 2147483647);
  const tries = opts.tries ?? 4;
  validateInteger(tries, 'options.tries', 1, 2147483647);
}

export function createDns(isIP: (value: string) => number) {
  let defaultOrder: DnsResultOrder = 'verbatim';
  let sharedDefaultServers: ServerEntry[] = [{ family: 4, ip: '127.0.0.1', port: IANA_DNS_PORT }];

  function getDefaultResultOrder(): DnsResultOrder {
    return defaultOrder;
  }

  function setDefaultResultOrder(value: unknown): void {
    validateDnsOrder(value, 'dnsOrder');
    defaultOrder = value;
  }

  function validateLookup(hostname: unknown, options: unknown = {}) {
    validateString(hostname, 'hostname');
    const settings = typeof options === 'number' ? { family: options } : options;
    if (!record(settings)) {
      throw invalidArgType('options', ['integer', 'object'], options);
    }
    let family = settings.family ?? 0;
    if (family === 'IPv4') family = 4;
    else if (family === 'IPv6') family = 6;
    if (family !== 0 && family !== 4 && family !== 6) {
      throw invalidArgValue('options.family', settings.family);
    }
    for (const name of ['all', 'verbatim'] as const) {
      if (settings[name] !== undefined && typeof settings[name] !== 'boolean') {
        throw invalidArgType(`options.${name}`, 'boolean', settings[name]);
      }
    }
    if (settings.hints !== undefined) {
      validateNumber(settings.hints, 'options.hints');
      const mask = DNS_FLAGS.ADDRCONFIG | DNS_FLAGS.ALL | DNS_FLAGS.V4MAPPED;
      const hints = Number(settings.hints) >>> 0;
      if ((hints & ~mask) !== 0) {
        throw invalidArgValue('hints', hints);
      }
    }
    let order: DnsResultOrder = defaultOrder;
    if (settings.verbatim !== undefined) {
      order = settings.verbatim ? 'verbatim' : 'ipv4first';
    }
    if (settings.order !== undefined) {
      validateDnsOrder(settings.order, 'options.order');
      order = settings.order;
    }
    return { hostname, family, all: Boolean(settings.all), order };
  }

  function executeLookup({
    hostname,
    family,
    all,
    order,
  }: ReturnType<typeof validateLookup>):
    | { address: string; family: number }
    | Array<{ address: string; family: number }> {
    const literalFamily = isIP(hostname);
    let address = hostname;
    let resolvedFamily = literalFamily;
    if (!literalFamily) {
      if (hostname !== 'localhost') {
        throw fault('ENOSYS', 'External hostname lookup is not implemented');
      }
      if (family === 6) {
        resolvedFamily = 6;
      } else if (family === 4) {
        resolvedFamily = 4;
      } else {
        resolvedFamily = order === 'ipv6first' ? 6 : 4;
      }
      address = resolvedFamily === 6 ? '::1' : '127.0.0.1';
    }
    const result = { address, family: resolvedFamily };
    return all ? [result] : result;
  }

  function resolveRecordSync(rrtype: string, hostname: string, ttl: boolean): unknown {
    if (rrtype === 'A') {
      if (hostname === 'localhost') {
        return ttl ? [{ address: '127.0.0.1', ttl: 0 }] : ['127.0.0.1'];
      }
      if (isIP(hostname) === 4) {
        return ttl ? [{ address: hostname, ttl: 0 }] : [hostname];
      }
      throw fault('ENOSYS', `DNS ${rrtype} resolution for external hostnames is not implemented`);
    }
    if (rrtype === 'AAAA') {
      if (hostname === 'localhost') {
        return ttl ? [{ address: '::1', ttl: 0 }] : ['::1'];
      }
      if (isIP(hostname) === 6) {
        return ttl ? [{ address: hostname, ttl: 0 }] : [hostname];
      }
      throw fault('ENOSYS', `DNS ${rrtype} resolution for external hostnames is not implemented`);
    }
    throw fault('ENOSYS', `Raw DNS ${rrtype} queries are not implemented`);
  }

  class ResolverBase {
    #servers: ServerEntry[] | null;

    constructor(options?: unknown, useSharedDefault = false) {
      validateResolverOptions(options);
      this.#servers = useSharedDefault
        ? null
        : [{ family: 4, ip: '127.0.0.1', port: IANA_DNS_PORT }];
    }

    cancel(): void {}

    getServers(): string[] {
      return formatServerList(this.#servers ?? sharedDefaultServers);
    }

    setServers(servers: unknown): void {
      const next = parseServerList(servers, isIP);
      if (this.#servers === null) {
        sharedDefaultServers = next;
      } else {
        this.#servers = next;
      }
    }

    setLocalAddress(ipv4: unknown, ipv6?: unknown): void {
      validateString(ipv4, 'ipv4');
      if (ipv6 !== undefined) {
        validateString(ipv6, 'ipv6');
      }
    }
  }

  function makeCallbackQuery(rrtype: string, supportsOptions = false) {
    return function query(
      name: unknown,
      optionsOrCallback: unknown,
      maybeCallback?: unknown,
    ): void {
      let options: unknown;
      let cb: unknown;
      if (supportsOptions && maybeCallback !== undefined) {
        options = optionsOrCallback;
        cb = maybeCallback;
      } else {
        cb = optionsOrCallback;
      }
      validateString(name, 'name');
      validateFunction(cb, 'callback');
      const ttl = Boolean(record(options) && options.ttl);
      queueMicrotask(() => {
        try {
          const result = resolveRecordSync(rrtype, name, ttl);
          cb(null, result);
        } catch (err) {
          cb(err);
        }
      });
    };
  }

  const cbResolve4 = makeCallbackQuery('A', true);
  const cbResolve6 = makeCallbackQuery('AAAA', true);
  const cbResolveAny = makeCallbackQuery('ANY');
  const cbResolveCaa = makeCallbackQuery('CAA');
  const cbResolveCname = makeCallbackQuery('CNAME');
  const cbResolveMx = makeCallbackQuery('MX');
  const cbResolveNaptr = makeCallbackQuery('NAPTR');
  const cbResolveNs = makeCallbackQuery('NS');
  const cbResolvePtr = makeCallbackQuery('PTR');
  const cbResolveSoa = makeCallbackQuery('SOA');
  const cbResolveSrv = makeCallbackQuery('SRV');
  const cbResolveTlsa = makeCallbackQuery('TLSA');
  const cbResolveTxt = makeCallbackQuery('TXT');
  const cbReverse = makeCallbackQuery('PTR');

  class Resolver extends ResolverBase {
    resolve(hostname: unknown, rrtypeOrCallback: unknown, maybeCallback?: unknown): void {
      let rrtype: string;
      let cb: unknown;
      if (typeof rrtypeOrCallback === 'string') {
        rrtype = rrtypeOrCallback;
        cb = maybeCallback;
      } else if (typeof rrtypeOrCallback === 'function') {
        rrtype = 'A';
        cb = rrtypeOrCallback;
      } else {
        throw invalidArgType('rrtype', 'string', rrtypeOrCallback);
      }
      if (!VALID_RR_TYPES.has(rrtype)) {
        throw invalidArgValue('rrtype', rrtype);
      }
      validateString(hostname, 'name');
      validateFunction(cb, 'callback');
      queueMicrotask(() => {
        try {
          const result = resolveRecordSync(rrtype, hostname, false);
          cb(null, result);
        } catch (err) {
          cb(err);
        }
      });
    }
    resolve4(name: unknown, optionsOrCallback: unknown, maybeCallback?: unknown): void {
      cbResolve4(name, optionsOrCallback, maybeCallback);
    }
    resolve6(name: unknown, optionsOrCallback: unknown, maybeCallback?: unknown): void {
      cbResolve6(name, optionsOrCallback, maybeCallback);
    }
    resolveAny(name: unknown, callback: unknown): void {
      cbResolveAny(name, callback);
    }
    resolveCaa(name: unknown, callback: unknown): void {
      cbResolveCaa(name, callback);
    }
    resolveCname(name: unknown, callback: unknown): void {
      cbResolveCname(name, callback);
    }
    resolveMx(name: unknown, callback: unknown): void {
      cbResolveMx(name, callback);
    }
    resolveNaptr(name: unknown, callback: unknown): void {
      cbResolveNaptr(name, callback);
    }
    resolveNs(name: unknown, callback: unknown): void {
      cbResolveNs(name, callback);
    }
    resolvePtr(name: unknown, callback: unknown): void {
      cbResolvePtr(name, callback);
    }
    resolveSoa(name: unknown, callback: unknown): void {
      cbResolveSoa(name, callback);
    }
    resolveSrv(name: unknown, callback: unknown): void {
      cbResolveSrv(name, callback);
    }
    resolveTlsa(name: unknown, callback: unknown): void {
      cbResolveTlsa(name, callback);
    }
    resolveTxt(name: unknown, callback: unknown): void {
      cbResolveTxt(name, callback);
    }
    reverse(ip: unknown, callback: unknown): void {
      cbReverse(ip, callback);
    }
  }

  function makePromiseQuery(rrtype: string, supportsOptions = false) {
    return function query(name: unknown, options?: unknown): Promise<unknown> {
      validateString(name, 'name');
      const ttl = Boolean(supportsOptions && record(options) && options.ttl);
      return new Promise((resolve, reject) => {
        queueMicrotask(() => {
          try {
            resolve(resolveRecordSync(rrtype, name, ttl));
          } catch (err) {
            reject(err);
          }
        });
      });
    };
  }

  const prResolve4 = makePromiseQuery('A', true);
  const prResolve6 = makePromiseQuery('AAAA', true);
  const prResolveAny = makePromiseQuery('ANY');
  const prResolveCaa = makePromiseQuery('CAA');
  const prResolveCname = makePromiseQuery('CNAME');
  const prResolveMx = makePromiseQuery('MX');
  const prResolveNaptr = makePromiseQuery('NAPTR');
  const prResolveNs = makePromiseQuery('NS');
  const prResolvePtr = makePromiseQuery('PTR');
  const prResolveSoa = makePromiseQuery('SOA');
  const prResolveSrv = makePromiseQuery('SRV');
  const prResolveTlsa = makePromiseQuery('TLSA');
  const prResolveTxt = makePromiseQuery('TXT');
  const prReverse = makePromiseQuery('PTR');

  class PromisesResolver extends ResolverBase {
    resolve(hostname: unknown, rrtype?: unknown): Promise<unknown> {
      let resolvedType = 'A';
      if (rrtype !== undefined) {
        validateString(rrtype, 'rrtype');
        if (!VALID_RR_TYPES.has(rrtype)) {
          throw invalidArgValue('rrtype', rrtype);
        }
        resolvedType = rrtype;
      }
      validateString(hostname, 'name');
      return new Promise((resolve, reject) => {
        queueMicrotask(() => {
          try {
            resolve(resolveRecordSync(resolvedType, hostname, false));
          } catch (err) {
            reject(err);
          }
        });
      });
    }
    resolve4(name: unknown, options?: unknown): Promise<unknown> {
      return prResolve4(name, options);
    }
    resolve6(name: unknown, options?: unknown): Promise<unknown> {
      return prResolve6(name, options);
    }
    resolveAny(name: unknown): Promise<unknown> {
      return prResolveAny(name);
    }
    resolveCaa(name: unknown): Promise<unknown> {
      return prResolveCaa(name);
    }
    resolveCname(name: unknown): Promise<unknown> {
      return prResolveCname(name);
    }
    resolveMx(name: unknown): Promise<unknown> {
      return prResolveMx(name);
    }
    resolveNaptr(name: unknown): Promise<unknown> {
      return prResolveNaptr(name);
    }
    resolveNs(name: unknown): Promise<unknown> {
      return prResolveNs(name);
    }
    resolvePtr(name: unknown): Promise<unknown> {
      return prResolvePtr(name);
    }
    resolveSoa(name: unknown): Promise<unknown> {
      return prResolveSoa(name);
    }
    resolveSrv(name: unknown): Promise<unknown> {
      return prResolveSrv(name);
    }
    resolveTlsa(name: unknown): Promise<unknown> {
      return prResolveTlsa(name);
    }
    resolveTxt(name: unknown): Promise<unknown> {
      return prResolveTxt(name);
    }
    reverse(ip: unknown): Promise<unknown> {
      return prReverse(ip);
    }
  }
  Object.defineProperty(PromisesResolver, 'name', { value: 'Resolver' });

  const defaultCbResolver = new Resolver(undefined, true);
  const defaultPromisesResolver = new PromisesResolver(undefined, true);

  function setDefaultServers(servers: unknown): void {
    sharedDefaultServers = parseServerList(servers, isIP);
  }

  function getDefaultServers(): string[] {
    return formatServerList(sharedDefaultServers);
  }

  function lookupCallback(hostname: unknown, options: unknown, callback?: unknown): void {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'function' ? undefined : options;
    validateFunction(done, 'callback');
    const request = validateLookup(hostname, settings);
    queueMicrotask(() => {
      let result: ReturnType<typeof executeLookup>;
      try {
        result = executeLookup(request);
      } catch (error) {
        done(error);
        return;
      }
      if (Array.isArray(result)) done(null, result);
      else done(null, result.address, result.family);
    });
  }

  function lookupPromise(hostname: unknown, options?: unknown): Promise<unknown> {
    const request = validateLookup(hostname, options);
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          resolve(executeLookup(request));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function lookupServiceCallback(...args: unknown[]): void {
    if (args.length !== 3) {
      throw nodeError(
        TypeError,
        'ERR_MISSING_ARGS',
        'The "address", "port", and "callback" arguments must be specified',
      );
    }
    const [address, port, callback] = args;
    if (typeof address !== 'string' || isIP(address) === 0) {
      throw invalidArgValue('address', address);
    }
    validatePort(port);
    validateFunction(callback, 'callback');
    queueMicrotask(() => {
      callback(fault('ENOSYS', 'Reverse service lookup is not implemented'));
    });
  }

  function lookupServicePromise(...args: unknown[]): Promise<never> {
    if (args.length !== 2) {
      throw nodeError(
        TypeError,
        'ERR_MISSING_ARGS',
        'The "address" and "port" arguments must be specified',
      );
    }
    const [address, port] = args;
    if (typeof address !== 'string' || isIP(address) === 0) {
      throw invalidArgValue('address', address);
    }
    validatePort(port);
    return new Promise((_resolve, reject) => {
      queueMicrotask(() => {
        reject(fault('ENOSYS', 'Reverse service lookup is not implemented'));
      });
    });
  }

  const promisesModule = {
    lookup: lookupPromise,
    lookupService: lookupServicePromise,
    Resolver: PromisesResolver,
    getDefaultResultOrder,
    setDefaultResultOrder,
    setServers: setDefaultServers,
    ...DNS_FLAGS,
    ...DNS_ERROR_CODES,
    getServers: getDefaultServers,
    resolve: defaultPromisesResolver.resolve.bind(defaultPromisesResolver),
    resolve4: defaultPromisesResolver.resolve4.bind(defaultPromisesResolver),
    resolve6: defaultPromisesResolver.resolve6.bind(defaultPromisesResolver),
    resolveAny: defaultPromisesResolver.resolveAny.bind(defaultPromisesResolver),
    resolveCaa: defaultPromisesResolver.resolveCaa.bind(defaultPromisesResolver),
    resolveCname: defaultPromisesResolver.resolveCname.bind(defaultPromisesResolver),
    resolveMx: defaultPromisesResolver.resolveMx.bind(defaultPromisesResolver),
    resolveNaptr: defaultPromisesResolver.resolveNaptr.bind(defaultPromisesResolver),
    resolveNs: defaultPromisesResolver.resolveNs.bind(defaultPromisesResolver),
    resolvePtr: defaultPromisesResolver.resolvePtr.bind(defaultPromisesResolver),
    resolveSoa: defaultPromisesResolver.resolveSoa.bind(defaultPromisesResolver),
    resolveSrv: defaultPromisesResolver.resolveSrv.bind(defaultPromisesResolver),
    resolveTlsa: defaultPromisesResolver.resolveTlsa.bind(defaultPromisesResolver),
    resolveTxt: defaultPromisesResolver.resolveTxt.bind(defaultPromisesResolver),
    reverse: defaultPromisesResolver.reverse.bind(defaultPromisesResolver),
  };

  return {
    lookup: lookupCallback,
    lookupService: lookupServiceCallback,
    Resolver,
    getDefaultResultOrder,
    setDefaultResultOrder,
    setServers: setDefaultServers,
    ...DNS_FLAGS,
    ...DNS_ERROR_CODES,
    getServers: getDefaultServers,
    resolve: defaultCbResolver.resolve.bind(defaultCbResolver),
    resolve4: defaultCbResolver.resolve4.bind(defaultCbResolver),
    resolve6: defaultCbResolver.resolve6.bind(defaultCbResolver),
    resolveAny: defaultCbResolver.resolveAny.bind(defaultCbResolver),
    resolveCaa: defaultCbResolver.resolveCaa.bind(defaultCbResolver),
    resolveCname: defaultCbResolver.resolveCname.bind(defaultCbResolver),
    resolveMx: defaultCbResolver.resolveMx.bind(defaultCbResolver),
    resolveNaptr: defaultCbResolver.resolveNaptr.bind(defaultCbResolver),
    resolveNs: defaultCbResolver.resolveNs.bind(defaultCbResolver),
    resolvePtr: defaultCbResolver.resolvePtr.bind(defaultCbResolver),
    resolveSoa: defaultCbResolver.resolveSoa.bind(defaultCbResolver),
    resolveSrv: defaultCbResolver.resolveSrv.bind(defaultCbResolver),
    resolveTlsa: defaultCbResolver.resolveTlsa.bind(defaultCbResolver),
    resolveTxt: defaultCbResolver.resolveTxt.bind(defaultCbResolver),
    reverse: defaultCbResolver.reverse.bind(defaultCbResolver),
    get promises() {
      return promisesModule;
    },
  };
}
