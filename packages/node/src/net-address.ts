import { inspect } from 'util/';
import {
  determineSpecificType,
  invalidArgType,
  invalidArgValue,
  nodeError,
  validateInteger,
  validateObject,
} from './node-errors';
import { record } from './value-guards';

const V4_SEG = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const V4_STR = `(?:${V4_SEG}\\.){3}${V4_SEG}`;
const IPV4_REG = new RegExp(`^${V4_STR}$`);

const V6_SEG = '(?:[0-9a-fA-F]{1,4})';
const IPV6_REG = new RegExp(
  '^(?:' +
    `(?:${V6_SEG}:){7}(?:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){6}(?:${V4_STR}|:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){5}(?::${V4_STR}|(?::${V6_SEG}){1,2}|:)|` +
    `(?:${V6_SEG}:){4}(?:(?::${V6_SEG}){0,1}:${V4_STR}|(?::${V6_SEG}){1,3}|:)|` +
    `(?:${V6_SEG}:){3}(?:(?::${V6_SEG}){0,2}:${V4_STR}|(?::${V6_SEG}){1,4}|:)|` +
    `(?:${V6_SEG}:){2}(?:(?::${V6_SEG}){0,3}:${V4_STR}|(?::${V6_SEG}){1,5}|:)|` +
    `(?:${V6_SEG}:){1}(?:(?::${V6_SEG}){0,4}:${V4_STR}|(?::${V6_SEG}){1,6}|:)|` +
    `(?::(?:(?::${V6_SEG}){0,5}:${V4_STR}|(?::${V6_SEG}){1,7}|:))` +
    ')(?:%[0-9a-zA-Z-.:]{1,})?$',
);

export function isIPv4(input: unknown): boolean {
  return typeof input === 'string' && IPV4_REG.test(input);
}

export function isIPv6(input: unknown): boolean {
  return typeof input === 'string' && IPV6_REG.test(input);
}

export function isIP(input: unknown): number {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw invalidArgType(name, 'string', value);
  }
}

export function validatePort(port: unknown, name = 'Port', allowZero = true): number {
  if (
    (typeof port !== 'number' && typeof port !== 'string') ||
    (typeof port === 'string' && port.trim().length === 0) ||
    +port !== +port >>> 0 ||
    +port > 0xffff ||
    (+port === 0 && !allowZero)
  ) {
    throw nodeError(
      RangeError,
      'ERR_SOCKET_BAD_PORT',
      `${name} should be ${allowZero ? '>=' : '>'} 0 and < 65536. Received ${determineSpecificType(port)}.`,
    );
  }
  return +port | 0;
}

function parseIPv4Octets(input: string): [number, number, number, number] | null {
  if (!isIPv4(input)) return null;
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

function parseIPv6Words(input: string): {
  words: [number, number, number, number, number, number, number, number];
  scope: string;
} | null {
  if (!isIPv6(input)) return null;
  const pct = input.indexOf('%');
  const bare = pct === -1 ? input : input.slice(0, pct);
  const rawZone = pct === -1 ? undefined : input.slice(pct + 1);
  let scope = '';
  if (rawZone !== undefined) {
    if (!/^\d+$/.test(rawZone)) return null;
    const scopeNum = Number(rawZone);
    if (!Number.isInteger(scopeNum) || scopeNum < 0 || scopeNum > 0xffffffff) return null;
    if (scopeNum > 0) scope = `%${scopeNum}`;
  }

  let normalized = bare;
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon === -1) return null;
    const octets = parseIPv4Octets(normalized.slice(lastColon + 1));
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  let groups: number[];
  if (normalized.includes('::')) {
    const halves = normalized.split('::');
    if (halves.length !== 2) return null;
    const left = halves[0] === '' ? [] : halves[0]!.split(':');
    const right = halves[1] === '' ? [] : halves[1]!.split(':');
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    groups = [
      ...left.map((h) => Number.parseInt(h, 16)),
      ...new Array<number>(fill).fill(0),
      ...right.map((h) => Number.parseInt(h, 16)),
    ];
  } else {
    const parts = normalized.split(':');
    if (parts.length !== 8) return null;
    groups = parts.map((h) => Number.parseInt(h, 16));
  }

  if (groups.length !== 8 || groups.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) {
    return null;
  }
  return {
    words: [
      groups[0]!,
      groups[1]!,
      groups[2]!,
      groups[3]!,
      groups[4]!,
      groups[5]!,
      groups[6]!,
      groups[7]!,
    ],
    scope,
  };
}

function formatIPv6Words(
  words: readonly [number, number, number, number, number, number, number, number],
): string {
  let bestBase = -1;
  let bestLen = 0;
  let curBase = -1;
  let curLen = 0;

  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (curBase === -1) {
        curBase = i;
        curLen = 1;
      } else {
        curLen++;
      }
    } else if (curBase !== -1) {
      if (curLen >= 2 && (bestBase === -1 || curLen > bestLen)) {
        bestBase = curBase;
        bestLen = curLen;
      }
      curBase = -1;
      curLen = 0;
    }
  }
  if (curBase !== -1 && curLen >= 2 && (bestBase === -1 || curLen > bestLen)) {
    bestBase = curBase;
    bestLen = curLen;
  }

  let out = '';
  for (let i = 0; i < 8; i++) {
    if (bestBase !== -1 && i >= bestBase && i < bestBase + bestLen) {
      if (i === bestBase) out += ':';
      continue;
    }
    if (i > 0) out += ':';
    if (i === 6 && bestBase === 0 && (bestLen === 6 || (bestLen === 5 && words[5] === 0xffff))) {
      const w6 = words[6]!;
      const w7 = words[7]!;
      out += `${(w6 >>> 8) & 0xff}.${w6 & 0xff}.${(w7 >>> 8) & 0xff}.${w7 & 0xff}`;
      break;
    }
    out += words[i]!.toString(16);
  }
  if (bestBase !== -1 && bestBase + bestLen === 8) out += ':';
  return out;
}

export function canonicalizeIP(ip: string): string {
  const v4 = parseIPv4Octets(ip);
  if (v4) return `${v4[0]}.${v4[1]}.${v4[2]}.${v4[3]}`;
  const v6 = parseIPv6Words(ip);
  if (v6) return `${formatIPv6Words(v6.words)}${v6.scope}`;
  return '';
}

const IPV4_MAPPED_PREFIX = 0xffffn << 32n;
const IPV4_MAPPED_MASK_96 = ((1n << 96n) - 1n) << 32n;

function ipv4OctetsToMapped128(octets: readonly [number, number, number, number]): bigint {
  const v4 =
    (BigInt(octets[0]) << 24n) |
    (BigInt(octets[1]) << 16n) |
    (BigInt(octets[2]) << 8n) |
    BigInt(octets[3]);
  return IPV4_MAPPED_PREFIX | v4;
}

function ipv6WordsTo128(
  words: readonly [number, number, number, number, number, number, number, number],
): bigint {
  let acc = 0n;
  for (const w of words) {
    acc = (acc << 16n) | BigInt(w);
  }
  return acc;
}

function isIpv4Mapped128(val: bigint): boolean {
  return (val & IPV4_MAPPED_MASK_96) === IPV4_MAPPED_PREFIX;
}

const kSocketAddressBrand = Symbol('kSocketAddressBrand');
const kCustomInspect = Symbol.for('nodejs.util.inspect.custom');

export interface SocketAddressInit {
  address?: string;
  family?: 'ipv4' | 'ipv6';
  port?: number;
  flowlabel?: number;
}

export class SocketAddress {
  readonly #address: string;
  readonly #port: number;
  readonly #family: 'ipv4' | 'ipv6';
  readonly #flowlabel: number;
  readonly #canonical128: bigint;
  readonly [kSocketAddressBrand] = true;

  static isSocketAddress(value: unknown): value is SocketAddress {
    return record(value) && Reflect.get(value, kSocketAddressBrand) === true;
  }

  constructor(options: unknown = {}) {
    validateObject(options, 'options');
    const rawFamily = options.family ?? 'ipv4';
    const lowered =
      typeof rawFamily === 'string'
        ? rawFamily.toLowerCase()
        : record(rawFamily) && typeof rawFamily.toLowerCase === 'function'
          ? String(rawFamily.toLowerCase())
          : rawFamily;

    if (lowered !== 'ipv4' && lowered !== 'ipv6') {
      throw invalidArgValue('options.family', options.family);
    }
    const family: 'ipv4' | 'ipv6' = lowered;
    const rawAddress = options.address ?? (family === 'ipv4' ? '127.0.0.1' : '::');
    const rawPort = options.port ?? 0;
    const rawFlowlabel = options.flowlabel ?? 0;

    validateString(rawAddress, 'options.address');
    const port = validatePort(rawPort, 'options.port');
    validateInteger(rawFlowlabel, 'options.flowlabel', 0, 0xffffffff);
    const flowlabel = Number(rawFlowlabel) >>> 0;

    if (family === 'ipv4') {
      const octets = parseIPv4Octets(rawAddress);
      if (!octets) {
        throw nodeError(Error, 'ERR_INVALID_ADDRESS', 'Invalid socket address');
      }
      this.#address = `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`;
      this.#canonical128 = ipv4OctetsToMapped128(octets);
    } else {
      const parsed = parseIPv6Words(rawAddress);
      if (!parsed) {
        throw nodeError(Error, 'ERR_INVALID_ADDRESS', 'Invalid socket address');
      }
      this.#address = `${formatIPv6Words(parsed.words)}${parsed.scope}`;
      this.#canonical128 = ipv6WordsTo128(parsed.words);
    }

    this.#family = family;
    this.#port = port;
    this.#flowlabel = family === 'ipv6' ? flowlabel : 0;
  }

  get address(): string {
    return this.#address;
  }

  get port(): number {
    return this.#port;
  }

  get family(): 'ipv4' | 'ipv6' {
    return this.#family;
  }

  get flowlabel(): number {
    return this.#flowlabel;
  }

  /** Internal helper for BlockList comparisons. */
  get _canonical128(): bigint {
    return this.#canonical128;
  }

  toJSON(): { address: string; port: number; family: 'ipv4' | 'ipv6'; flowlabel: number } {
    return {
      address: this.#address,
      port: this.#port,
      family: this.#family,
      flowlabel: this.#flowlabel,
    };
  }

  [kCustomInspect](depth: number, options: Record<string, unknown>): unknown {
    if (depth < 0) return this;
    const nextDepth: number | null | undefined =
      options && typeof options.depth === 'number'
        ? options.depth - 1
        : options?.depth === null
          ? null
          : undefined;
    return `SocketAddress ${inspect(this.toJSON(), { ...options, depth: nextDepth })}`;
  }

  static parse(input: unknown): SocketAddress | undefined {
    validateString(input, 'input');
    try {
      const parsedUrl = new URL(`http://${input}`);
      if (
        parsedUrl.username !== '' ||
        parsedUrl.password !== '' ||
        parsedUrl.pathname !== '/' ||
        parsedUrl.search !== '' ||
        parsedUrl.hash !== ''
      ) {
        return undefined;
      }
      const host = parsedUrl.hostname;
      const port = parsedUrl.port === '' ? 0 : Number(parsedUrl.port) | 0;
      if (host.startsWith('[') && host.endsWith(']')) {
        return new SocketAddress({
          address: host.slice(1, -1),
          port,
          family: 'ipv6',
        });
      }
      return new SocketAddress({ address: host, port, family: 'ipv4' });
    } catch {
      return undefined;
    }
  }
}

interface BlockRule {
  label: string;
  match: (val128: bigint) => boolean;
}

function subnetMask128(prefixBits: number): bigint {
  if (prefixBits <= 0) return 0n;
  if (prefixBits >= 128) return (1n << 128n) - 1n;
  const shift = BigInt(128 - prefixBits);
  return ((1n << BigInt(prefixBits)) - 1n) << shift;
}

function resolveSocketAddressArg(input: unknown, argName: string, family: unknown): SocketAddress {
  if (SocketAddress.isSocketAddress(input)) return input;
  validateString(input, argName);
  validateString(family, 'family');
  return new SocketAddress({
    address: input,
    // Invariant: SocketAddress constructor validates `family` and throws ERR_INVALID_ARG_VALUE if invalid.
    family: family as 'ipv4' | 'ipv6',
  });
}

const kBlockListBrand = Symbol('kBlockListBrand');
const RULE_ADDRESS_RE = /^Address:\s+IPv(4|6)\s+(\S+)$/i;
const RULE_RANGE_RE = /^Range:\s+IPv(4|6)\s+(\S+)-(\S+)$/i;
const RULE_SUBNET_RE = /^Subnet:\s+IPv(4|6)\s+(\S+)\/(\d+)$/i;

export class BlockList {
  #rules: BlockRule[] = [];
  readonly [kBlockListBrand] = true;

  static isBlockList(value: unknown): value is BlockList {
    return record(value) && Reflect.get(value, kBlockListBrand) === true;
  }

  addAddress(address: unknown, family: unknown = 'ipv4'): void {
    const sa = resolveSocketAddressArg(address, 'address', family);
    const target = sa._canonical128;
    const tag = sa.family === 'ipv4' ? 'IPv4' : 'IPv6';
    this.#rules.unshift({
      label: `Address: ${tag} ${sa.address}`,
      match: (v) => v === target,
    });
  }

  addRange(start: unknown, end: unknown, family: unknown = 'ipv4'): void {
    const startSa = resolveSocketAddressArg(start, 'start', family);
    const endSa = resolveSocketAddressArg(end, 'end', family);
    const startCompat =
      startSa.family === endSa.family ||
      (startSa.family === 'ipv4' && isIpv4Mapped128(endSa._canonical128)) ||
      (endSa.family === 'ipv4' && isIpv4Mapped128(startSa._canonical128));
    if (!startCompat || startSa._canonical128 > endSa._canonical128) {
      throw invalidArgValue('start', startSa, 'must come before end');
    }
    const lo = startSa._canonical128;
    const hi = endSa._canonical128;
    const tag = startSa.family === 'ipv4' ? 'IPv4' : 'IPv6';
    this.#rules.unshift({
      label: `Range: ${tag} ${startSa.address}-${endSa.address}`,
      match: (v) => v >= lo && v <= hi,
    });
  }

  addSubnet(network: unknown, prefix: unknown, family: unknown = 'ipv4'): void {
    const netSa = resolveSocketAddressArg(network, 'network', family);
    const maxPrefix = netSa.family === 'ipv4' ? 32 : 128;
    validateInteger(prefix, 'prefix', 0, maxPrefix);
    const prefixNum = Number(prefix);
    const effectivePrefix = netSa.family === 'ipv4' ? 96 + prefixNum : prefixNum;
    const mask = subnetMask128(effectivePrefix);
    const maskedNet = netSa._canonical128 & mask;
    const tag = netSa.family === 'ipv4' ? 'IPv4' : 'IPv6';
    this.#rules.unshift({
      label: `Subnet: ${tag} ${netSa.address}/${prefixNum}`,
      match: (v) => (v & mask) === maskedNet,
    });
  }

  check(address: unknown, family: unknown = 'ipv4'): boolean {
    let sa: SocketAddress;
    if (SocketAddress.isSocketAddress(address)) {
      sa = address;
    } else {
      validateString(address, 'address');
      validateString(family, 'family');
      try {
        sa = new SocketAddress({
          address,
          // Invariant: SocketAddress validates `family` and throws if invalid; check() catches invalid addresses.
          family: family as 'ipv4' | 'ipv6',
        });
      } catch (err) {
        if (record(err) && err.code === 'ERR_INVALID_ARG_VALUE') throw err;
        return false;
      }
    }
    const val = sa._canonical128;
    return this.#rules.some((rule) => rule.match(val));
  }

  get rules(): string[] {
    return this.#rules.map((r) => r.label);
  }

  toJSON(): string[] {
    return this.rules;
  }

  fromJSON(value: unknown): void {
    let items: unknown;
    if (typeof value === 'string') {
      try {
        items = JSON.parse(value);
      } catch {
        throw invalidArgValue('value', value);
      }
    } else {
      items = value;
    }
    if (!Array.isArray(items)) {
      throw invalidArgType('value', ['string', 'Array'], value);
    }
    for (let i = 0; i < items.length; i++) {
      if (typeof items[i] !== 'string') {
        throw invalidArgType(`value[${i}]`, 'string', items[i]);
      }
    }
    // Replay from oldest to newest so `this.rules` preserves the serialized order.
    for (let i = items.length - 1; i >= 0; i--) {
      const raw = String(items[i]).trim();
      const addrMatch = RULE_ADDRESS_RE.exec(raw);
      if (addrMatch) {
        const fam = addrMatch[1] === '4' ? 'ipv4' : 'ipv6';
        this.addAddress(addrMatch[2], fam);
        continue;
      }
      const rangeMatch = RULE_RANGE_RE.exec(raw);
      if (rangeMatch) {
        const fam = rangeMatch[1] === '4' ? 'ipv4' : 'ipv6';
        this.addRange(rangeMatch[2], rangeMatch[3], fam);
        continue;
      }
      const subMatch = RULE_SUBNET_RE.exec(raw);
      if (subMatch) {
        const fam = subMatch[1] === '4' ? 'ipv4' : 'ipv6';
        this.addSubnet(subMatch[2], Number(subMatch[3]), fam);
        continue;
      }
      throw invalidArgValue('value', raw);
    }
  }

  [kCustomInspect](depth: number, options: Record<string, unknown>): unknown {
    if (depth < 0) return this;
    const nextDepth: number | null | undefined =
      options && typeof options.depth === 'number'
        ? options.depth - 1
        : options?.depth === null
          ? null
          : undefined;
    return `BlockList ${inspect({ rules: this.rules }, { ...options, depth: nextDepth })}`;
  }
}
