// Pure TypeScript X.509 v3 Certificate (crypto.X509Certificate) and legacy
// Netscape SPKAC (crypto.Certificate) implementation matching Node 22.18.0.
import { Buffer } from 'buffer';
import shaHash from 'sha.js';
import { invalidArgType, stringBytes, typeList, validateString, viewBytes } from './crypto-args';
import {
  type TlvNode,
  bitLengthBigInt,
  bytesEqual,
  decodeSpkiDer,
  oidHex,
  publicFromPrivateData,
  readBitStringBytes,
  readChildren,
  readExactTlv,
  readTlv,
  wrapPem,
} from './crypto-asn1';
import {
  type KeyObject,
  type PublicKeyObject,
  createPublicKey,
  inspectKeyObjectSlot,
  isKeyObject,
} from './crypto-keys';
import {
  type ShaDigestName,
  ecdsaVerifySync,
  ed25519VerifySync,
  rsaVerifySync,
} from './crypto-rsa-sync';
import { canonicalizeIP, isIP } from './net-address';
import { invalidArgValue, validateObject } from './node-errors';

function validateBool(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw invalidArgType(name, 'of type boolean', value);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const RDN_SHORT_NAMES: Record<string, string> = {
  '550403': 'CN',
  '550404': 'SN',
  '550405': 'serialNumber',
  '550406': 'C',
  '550407': 'L',
  '550408': 'ST',
  '550409': 'street',
  '55040a': 'O',
  '55040b': 'OU',
  '55040c': 'title',
  '550411': 'postalCode',
  '55042a': 'GN',
  '2a864886f70d010901': 'emailAddress',
  '0992268993f22c640119': 'DC',
  '0992268993f22c640101': 'UID',
};

const SIG_OID_INFO: Record<
  string,
  { family: 'rsa' | 'ecdsa'; hash: ShaDigestName } | { family: 'rsa-pss' } | { family: 'ed25519' }
> = {
  '2a864886f70d010105': { family: 'rsa', hash: 'sha1' },
  '2a864886f70d01010e': { family: 'rsa', hash: 'sha224' },
  '2a864886f70d01010b': { family: 'rsa', hash: 'sha256' },
  '2a864886f70d01010c': { family: 'rsa', hash: 'sha384' },
  '2a864886f70d01010d': { family: 'rsa', hash: 'sha512' },
  '2a864886f70d01010a': { family: 'rsa-pss' },
  '2a8648ce3d0401': { family: 'ecdsa', hash: 'sha1' },
  '2a8648ce3d040301': { family: 'ecdsa', hash: 'sha224' },
  '2a8648ce3d040302': { family: 'ecdsa', hash: 'sha256' },
  '2a8648ce3d040303': { family: 'ecdsa', hash: 'sha384' },
  '2a8648ce3d040304': { family: 'ecdsa', hash: 'sha512' },
  '2b6570': { family: 'ed25519' },
};

const HASH_OID_MAP: Record<string, ShaDigestName> = {
  '2b0e03021a': 'sha1',
  '608648016503040204': 'sha224',
  '608648016503040201': 'sha256',
  '608648016503040202': 'sha384',
  '608648016503040203': 'sha512',
};

function oidBytesToDotted(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return '';
  const first = bytes[0];
  const arc0 = first < 80 ? Math.floor(first / 40) : 2;
  const arc1 = first < 80 ? first % 40 : first - 80;
  const parts: Array<number | bigint> = [arc0, arc1];
  let acc = 0n;
  for (let i = 1; i < bytes.byteLength; i++) {
    acc = (acc << 7n) | BigInt(bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      parts.push(acc <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(acc) : acc);
      acc = 0n;
    }
  }
  return parts.map(String).join('.');
}

function decodeAsn1String(node: TlvNode): string {
  // BMPString (UCS-2 BE)
  if (node.tag === 0x1e) {
    let out = '';
    for (let i = 0; i + 1 < node.content.byteLength; i += 2) {
      out += String.fromCharCode((node.content[i] << 8) | node.content[i + 1]);
    }
    return out;
  }
  // UTF8String, PrintableString, IA5String, TeletexString
  return new TextDecoder('utf-8', { fatal: false }).decode(node.content);
}

function escapeDnValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

function parseX509Name(nameNode: TlvNode): {
  formatted: string;
  legacy: Record<string, string | string[]>;
  cnList: string[];
  emailList: string[];
} {
  // Safe: Object.create(null) produces an unpolluted legacy dictionary matching Node's X509 toLegacyObject.
  const legacy = Object.create(null) as Record<string, string | string[]>;
  const lines: string[] = [];
  const cnList: string[] = [];
  const emailList: string[] = [];

  for (const rdnSet of readChildren(nameNode.content)) {
    if (rdnSet.tag !== 0x31) continue;
    const atvs = readChildren(rdnSet.content);
    const rdnParts: string[] = [];
    for (const atv of atvs) {
      if (atv.tag !== 0x30) continue;
      const kv = readChildren(atv.content);
      if (kv.length < 2 || kv[0].tag !== 0x06) continue;
      const hex = oidHex(kv[0]);
      const key = RDN_SHORT_NAMES[hex] ?? oidBytesToDotted(kv[0].content);
      const val = decodeAsn1String(kv[1]);
      rdnParts.push(`${key}=${escapeDnValue(val)}`);
      if (key === 'CN') cnList.push(val);
      if (key === 'emailAddress') emailList.push(val);
      const existing = legacy[key];
      if (existing === undefined) {
        legacy[key] = val;
      } else if (Array.isArray(existing)) {
        existing.push(val);
      } else {
        legacy[key] = [existing, val];
      }
    }
    if (rdnParts.length > 0) {
      lines.push(rdnParts.join('+'));
    }
  }
  return { formatted: lines.join('\n'), legacy, cnList, emailList };
}

function parseAsn1Time(node: TlvNode): { formatted: string; date: Date } {
  const raw = new TextDecoder('ascii').decode(node.content);
  let year: number;
  let rest: string;
  if (node.tag === 0x17) {
    // UTCTime: YYMMDDHHMM[SS]Z
    const yy = Number(raw.slice(0, 2));
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
    rest = raw.slice(2);
  } else if (node.tag === 0x18) {
    // GeneralizedTime: YYYYMMDDHHMM[SS[.fff]]Z
    year = Number(raw.slice(0, 4));
    rest = raw.slice(4);
  } else {
    throw pemNoStartLineError();
  }
  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const minute = Number(rest.slice(6, 8));
  const second =
    rest.length >= 10 && /^\d\d/.test(rest.slice(8, 10)) ? Number(rest.slice(8, 10)) : 0;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const monthName = MONTHS[month - 1] ?? 'Jan';
  const dayStr = day < 10 ? ` ${day}` : `${day}`;
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(second).padStart(2, '0');
  return {
    formatted: `${monthName} ${dayStr} ${hh}:${mm}:${ss} ${year} GMT`,
    date,
  };
}

function formatColonFingerprint(alg: 'sha1' | 'sha256' | 'sha512', der: Uint8Array): string {
  const digest = shaHash(alg)
    .update(Buffer.from(der.buffer, der.byteOffset, der.byteLength))
    .digest();
  const parts = new Array<string>(digest.length);
  for (let i = 0; i < digest.length; i++) {
    parts[i] = digest[i].toString(16).toUpperCase().padStart(2, '0');
  }
  return parts.join(':');
}

function formatSanIp(bytes: Uint8Array): { sanLabel: string; canonicalIp: string | undefined } {
  if (bytes.byteLength === 4) {
    const v4 = `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
    return { sanLabel: v4, canonicalIp: canonicalizeIP(v4) };
  }
  if (bytes.byteLength === 16) {
    const groups = new Array<string>(8);
    for (let i = 0; i < 8; i++) {
      const word = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
      groups[i] = word.toString(16).toUpperCase();
    }
    const fullHex = groups.join(':');
    return { sanLabel: fullHex, canonicalIp: canonicalizeIP(fullHex) };
  }
  return { sanLabel: '<invalid>', canonicalIp: undefined };
}

function parseGeneralName(gn: TlvNode): {
  kind: 'dns' | 'email' | 'uri' | 'ip' | 'other';
  formatted: string;
  rawText: string;
  canonicalIp?: string;
} {
  if (gn.tag === 0x82) {
    const s = new TextDecoder('ascii').decode(gn.content);
    return { kind: 'dns', formatted: `DNS:${s}`, rawText: s };
  }
  if (gn.tag === 0x81) {
    const s = new TextDecoder('ascii').decode(gn.content);
    return { kind: 'email', formatted: `email:${s}`, rawText: s };
  }
  if (gn.tag === 0x86) {
    const s = new TextDecoder('ascii').decode(gn.content);
    return { kind: 'uri', formatted: `URI:${s}`, rawText: s };
  }
  if (gn.tag === 0x87) {
    const { sanLabel, canonicalIp } = formatSanIp(gn.content);
    return {
      kind: 'ip',
      formatted: `IP Address:${sanLabel}`,
      rawText: sanLabel,
      canonicalIp,
    };
  }
  return { kind: 'other', formatted: 'othername:<unsupported>', rawText: '' };
}

function pemNoStartLineError(): Error {
  return Object.assign(new Error('error:0480006C:PEM routines::no start line'), {
    code: 'ERR_OSSL_PEM_NO_START_LINE',
  });
}

function unwrapCertInputToDer(input: unknown): Buffer {
  const x509InputTypes = typeList(['string'], ['Buffer', 'TypedArray', 'DataView']);
  let bytes: Uint8Array;
  let asText: string | undefined;
  if (typeof input === 'string') {
    asText = input;
    bytes = Buffer.from(input, 'utf8');
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw invalidArgType('buffer', x509InputTypes, input);
  }

  if (asText === undefined && bytes.byteLength > 0 && bytes[0] !== 0x30) {
    asText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  if (asText !== undefined) {
    const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(asText);
    if (!match) throw pemNoStartLineError();
    const b64 = match[1].replace(/[\r\n\s]+/g, '');
    if (b64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw pemNoStartLineError();
    }
    return Buffer.from(b64, 'base64');
  }
  if (bytes.byteLength === 0) throw pemNoStartLineError();
  return Buffer.from(bytes);
}

function verifyAsn1Signature(
  algSeqContent: Uint8Array,
  payloadBytes: Uint8Array,
  sigBytes: Uint8Array,
  pubKeyObj: KeyObject,
): boolean {
  const algItems = readChildren(algSeqContent);
  if (algItems.length < 1 || algItems[0].tag !== 0x06) return false;
  const algOid = oidHex(algItems[0]);
  const info = SIG_OID_INFO[algOid];
  if (!info) return false;

  const inspected = inspectKeyObjectSlot(pubKeyObj);
  const pub =
    inspected.publicData ??
    (inspected.privateData
      ? publicFromPrivateData(inspected.privateData)
      : inspected.pairedPublicData);
  if (!pub) return false;

  if (info.family === 'ed25519') {
    if (pub.kind !== 'ed25519') return false;
    return ed25519VerifySync(pub.x, payloadBytes, sigBytes);
  }

  if (info.family === 'ecdsa') {
    if (pub.kind !== 'ec') return false;
    const digest = shaHash(info.hash)
      .update(Buffer.from(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength))
      .digest();
    return ecdsaVerifySync(pub.namedCurve, pub.x, pub.y, digest, sigBytes, 'der');
  }

  if (info.family === 'rsa') {
    if (pub.kind !== 'rsa') return false;
    const digest = shaHash(info.hash)
      .update(Buffer.from(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength))
      .digest();
    return rsaVerifySync(pub, info.hash, digest, sigBytes, 1);
  }

  // rsa-pss
  if (pub.kind !== 'rsa' && pub.kind !== 'rsa-pss') return false;
  let hashName: ShaDigestName = 'sha1';
  let saltLen: number | undefined;
  if (algItems.length >= 2 && algItems[1].tag === 0x30) {
    for (const field of readChildren(algItems[1].content)) {
      if (field.tag === 0xa0) {
        const hs = readExactTlv(field.content, 0x30);
        const hc = readChildren(hs.content);
        if (hc.length >= 1 && hc[0].tag === 0x06) {
          const mapped = HASH_OID_MAP[oidHex(hc[0])];
          if (mapped) hashName = mapped;
        }
      } else if (field.tag === 0xa2) {
        const sNode = readExactTlv(field.content, 0x02);
        let acc = 0;
        for (const b of sNode.content) acc = (acc << 8) | b;
        saltLen = acc;
      }
    }
  }
  const digest = shaHash(hashName)
    .update(Buffer.from(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength))
    .digest();
  return rsaVerifySync(pub, hashName, digest, sigBytes, 6, saltLen);
}

interface ParsedX509Data {
  raw: Buffer;
  tbsRaw: Uint8Array;
  sigAlgContent: Uint8Array;
  sigBytes: Uint8Array;
  serialNumber: string;
  issuer: string;
  issuerDer: Uint8Array;
  issuerLegacy: Record<string, string | string[]>;
  subject: string;
  subjectDer: Uint8Array;
  subjectLegacy: Record<string, string | string[]>;
  subjectCnList: string[];
  subjectEmailList: string[];
  validFrom: string;
  validTo: string;
  validFromDate: Date;
  validToDate: Date;
  spkiDer: Buffer;
  ca: boolean;
  subjectAltName: string | undefined;
  dnsAltNames: string[];
  emailAltNames: string[];
  ipAltCanonical: string[];
  infoAccess: string | undefined;
  infoAccessLegacy: Record<string, string[]> | undefined;
  keyUsage: string[] | undefined;
  publicKeyCache?: PublicKeyObject;
}

function parseX509Der(rawDer: Buffer): ParsedX509Data {
  let outer: TlvNode;
  try {
    outer = readExactTlv(rawDer, 0x30);
  } catch {
    throw pemNoStartLineError();
  }
  const topOffsets: Array<{ start: number; node: TlvNode }> = [];
  let cursor = 0;
  const outerHeaderLen = rawDer.byteLength - outer.content.byteLength;
  while (cursor < outer.content.byteLength) {
    const start = outerHeaderLen + cursor;
    const child = readTlv(outer.content, cursor);
    topOffsets.push({ start, node: child });
    cursor = child.next;
  }
  if (
    topOffsets.length !== 3 ||
    topOffsets[0].node.tag !== 0x30 ||
    topOffsets[1].node.tag !== 0x30
  ) {
    throw pemNoStartLineError();
  }
  const tbsEnd = outerHeaderLen + topOffsets[0].node.next;
  const tbsRaw = rawDer.subarray(topOffsets[0].start, tbsEnd);
  const sigAlgContent = topOffsets[1].node.content;
  const sigBytes = readBitStringBytes(topOffsets[2].node);

  // Walk TBSCertificate children while tracking exact raw slices for issuer, subject, and spki.
  const tbsContent = topOffsets[0].node.content;
  const tbsBaseOffset = tbsEnd - tbsContent.byteLength;
  const tbsItems: Array<{ rawSlice: Uint8Array; node: TlvNode }> = [];
  let tCursor = 0;
  while (tCursor < tbsContent.byteLength) {
    const child = readTlv(tbsContent, tCursor);
    const rawSlice = rawDer.subarray(tbsBaseOffset + tCursor, tbsBaseOffset + child.next);
    tbsItems.push({ rawSlice, node: child });
    tCursor = child.next;
  }

  let idx = 0;
  if (idx < tbsItems.length && tbsItems[idx].node.tag === 0xa0) {
    idx++; // Optional [0] EXPLICIT Version
  }
  if (tbsItems.length - idx < 6) throw pemNoStartLineError();

  const serialNode = tbsItems[idx++].node;
  if (serialNode.tag !== 0x02) throw pemNoStartLineError();
  const serialNumber = Buffer.from(
    serialNode.content.buffer,
    serialNode.content.byteOffset,
    serialNode.content.byteLength,
  )
    .toString('hex')
    .toUpperCase();

  idx++; // signature AlgorithmIdentifier inside TBS

  const issuerEntry = tbsItems[idx++];
  const issuerParsed = parseX509Name(issuerEntry.node);

  const validityNode = tbsItems[idx++].node;
  const valKids = readChildren(validityNode.content);
  if (valKids.length < 2) throw pemNoStartLineError();
  const fromParsed = parseAsn1Time(valKids[0]);
  const toParsed = parseAsn1Time(valKids[1]);

  const subjectEntry = tbsItems[idx++];
  const subjectParsed = parseX509Name(subjectEntry.node);

  const spkiEntry = tbsItems[idx++];
  const spkiDer = Buffer.from(spkiEntry.rawSlice);

  let ca = false;
  let subjectAltName: string | undefined;
  const dnsAltNames: string[] = [];
  const emailAltNames: string[] = [];
  const ipAltCanonical: string[] = [];
  let infoAccess: string | undefined;
  let infoAccessLegacy: Record<string, string[]> | undefined;
  let keyUsage: string[] | undefined;

  while (idx < tbsItems.length) {
    const extWrapper = tbsItems[idx++].node;
    if (extWrapper.tag === 0xa3) {
      const extSeq = readExactTlv(extWrapper.content, 0x30);
      for (const extNode of readChildren(extSeq.content)) {
        if (extNode.tag !== 0x30) continue;
        const extFields = readChildren(extNode.content);
        if (extFields.length < 2 || extFields[0].tag !== 0x06) continue;
        const extOid = oidHex(extFields[0]);
        const valNode = extFields[extFields.length - 1];
        if (valNode.tag !== 0x04) continue;

        if (extOid === '551d13') {
          // BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE, pathLenConstraint INTEGER OPTIONAL }
          const bcSeq = readExactTlv(valNode.content, 0x30);
          const bcKids = readChildren(bcSeq.content);
          if (bcKids.length >= 1 && bcKids[0].tag === 0x01 && bcKids[0].content.byteLength >= 1) {
            ca = bcKids[0].content[0] !== 0;
          }
        } else if (extOid === '551d11') {
          // SubjectAltName ::= SEQUENCE OF GeneralName
          const sanSeq = readExactTlv(valNode.content, 0x30);
          const sanEntries: string[] = [];
          for (const gn of readChildren(sanSeq.content)) {
            const parsedGn = parseGeneralName(gn);
            sanEntries.push(parsedGn.formatted);
            if (parsedGn.kind === 'dns') dnsAltNames.push(parsedGn.rawText);
            else if (parsedGn.kind === 'email') emailAltNames.push(parsedGn.rawText);
            else if (parsedGn.kind === 'ip' && parsedGn.canonicalIp !== undefined) {
              ipAltCanonical.push(parsedGn.canonicalIp);
            }
          }
          subjectAltName = sanEntries.join(', ');
        } else if (extOid === '551d25') {
          // ExtKeyUsageSyntax ::= SEQUENCE SIZE (1..MAX) OF KeyPurposeId
          const ekuSeq = readExactTlv(valNode.content, 0x30);
          keyUsage = [];
          for (const kp of readChildren(ekuSeq.content)) {
            if (kp.tag === 0x06) {
              keyUsage.push(oidBytesToDotted(kp.content));
            }
          }
        } else if (extOid === '2b06010505070101') {
          // AuthorityInfoAccessSyntax ::= SEQUENCE SIZE (1..MAX) OF AccessDescription
          const aiaSeq = readExactTlv(valNode.content, 0x30);
          const aiaLines: string[] = [];
          // Safe: Object.create(null) builds an unpolluted dictionary for legacy infoAccess.
          const legacyMap = Object.create(null) as Record<string, string[]>;
          for (const ad of readChildren(aiaSeq.content)) {
            if (ad.tag !== 0x30) continue;
            const adKids = readChildren(ad.content);
            if (adKids.length < 2 || adKids[0].tag !== 0x06) continue;
            const methodHex = oidHex(adKids[0]);
            const methodLabel =
              methodHex === '2b06010505073001'
                ? 'OCSP'
                : methodHex === '2b06010505073002'
                  ? 'CA Issuers'
                  : oidBytesToDotted(adKids[0].content);
            const loc = parseGeneralName(adKids[1]);
            aiaLines.push(`${methodLabel} - ${loc.formatted}`);
            const colonIdx = loc.formatted.indexOf(':');
            const legacyKey =
              colonIdx !== -1
                ? `${methodLabel} - ${loc.formatted.slice(0, colonIdx)}`
                : methodLabel;
            const legacyVal = colonIdx !== -1 ? loc.formatted.slice(colonIdx + 1) : loc.formatted;
            if (!legacyMap[legacyKey]) legacyMap[legacyKey] = [];
            legacyMap[legacyKey].push(legacyVal);
          }
          infoAccess = aiaLines.join('\n');
          infoAccessLegacy = legacyMap;
        }
      }
    }
  }

  return {
    raw: rawDer,
    tbsRaw,
    sigAlgContent,
    sigBytes,
    serialNumber,
    issuer: issuerParsed.formatted,
    issuerDer: issuerEntry.rawSlice,
    issuerLegacy: issuerParsed.legacy,
    subject: subjectParsed.formatted,
    subjectDer: subjectEntry.rawSlice,
    subjectLegacy: subjectParsed.legacy,
    subjectCnList: subjectParsed.cnList,
    subjectEmailList: subjectParsed.emailList,
    validFrom: fromParsed.formatted,
    validTo: toParsed.formatted,
    validFromDate: fromParsed.date,
    validToDate: toParsed.date,
    spkiDer,
    ca,
    subjectAltName,
    dnsAltNames,
    emailAltNames,
    ipAltCanonical,
    infoAccess,
    infoAccessLegacy,
    keyUsage,
  };
}

// --- Host / Email / IP matching per RFC 6125 & OpenSSL X509_check_host ---

interface CheckOptions {
  subject: 'default' | 'always' | 'never';
  wildcards: boolean;
  partialWildcards: boolean;
  multiLabelWildcards: boolean;
  singleLabelSubdomains: boolean;
}

function parseCheckOptions(options: unknown): CheckOptions {
  let subject: 'default' | 'always' | 'never' = 'default';
  let wildcards = true;
  let partialWildcards = true;
  let multiLabelWildcards = false;
  let singleLabelSubdomains = false;

  if (options !== undefined) {
    validateObject(options, 'options');
    if (options.subject !== undefined) {
      if (
        options.subject !== 'default' &&
        options.subject !== 'always' &&
        options.subject !== 'never'
      ) {
        throw invalidArgValue('options.subject', options.subject);
      }
      subject = options.subject;
    }
    if (options.wildcards !== undefined) {
      validateBool(options.wildcards, 'options.wildcards');
      wildcards = options.wildcards;
    }
    if (options.partialWildcards !== undefined) {
      validateBool(options.partialWildcards, 'options.partialWildcards');
      partialWildcards = options.partialWildcards;
    }
    if (options.multiLabelWildcards !== undefined) {
      validateBool(options.multiLabelWildcards, 'options.multiLabelWildcards');
      multiLabelWildcards = options.multiLabelWildcards;
    }
    if (options.singleLabelSubdomains !== undefined) {
      validateBool(options.singleLabelSubdomains, 'options.singleLabelSubdomains');
      singleLabelSubdomains = options.singleLabelSubdomains;
    }
  }
  return { subject, wildcards, partialWildcards, multiLabelWildcards, singleLabelSubdomains };
}

function matchDnsCandidate(name: string, pattern: string, opts: CheckOptions): boolean {
  const cleanHost = name.replace(/\.$/, '').toLowerCase();
  const cleanPat = pattern.replace(/\.$/, '').toLowerCase();
  if (!cleanHost || !cleanPat) return false;
  if (!cleanPat.includes('*')) return cleanHost === cleanPat;
  if (!opts.wildcards) return false;

  const patLabels = cleanPat.split('.');
  const hostLabels = cleanHost.split('.');
  if (!opts.singleLabelSubdomains && patLabels.length < 3) return false;
  if (patLabels[0].startsWith('xn--')) return false;
  if (!opts.partialWildcards && patLabels[0] !== '*') return false;
  if (patLabels.slice(1).some((l) => l.includes('*'))) return false;

  const suffixLabels = patLabels.slice(1);
  if (opts.multiLabelWildcards) {
    if (hostLabels.length < patLabels.length) return false;
    const hostSuffix = hostLabels.slice(hostLabels.length - suffixLabels.length);
    for (let i = 0; i < suffixLabels.length; i++) {
      if (hostSuffix[i] !== suffixLabels[i]) return false;
    }
    if (patLabels[0] === '*') return true;
  } else {
    if (hostLabels.length !== patLabels.length) return false;
    for (let i = 1; i < patLabels.length; i++) {
      if (hostLabels[i] !== patLabels[i]) return false;
    }
  }

  const wildParts = patLabels[0].split('*');
  if (wildParts.length > 2) return false;
  const [prefix, suffix] = wildParts;
  const targetLabel = hostLabels[0];
  return (
    targetLabel.length >= prefix.length + suffix.length &&
    targetLabel.startsWith(prefix) &&
    targetLabel.endsWith(suffix)
  );
}

const x509Slots = new WeakMap<object, ParsedX509Data>();

function requireX509Slot(self: unknown): ParsedX509Data {
  const slot = typeof self === 'object' && self !== null ? x509Slots.get(self) : undefined;
  if (!slot) {
    throw Object.assign(new TypeError('Value of "this" must be of type X509Certificate'), {
      code: 'ERR_INVALID_THIS',
    });
  }
  return slot;
}

const EC_NIST_NAMES: Record<string, string> = {
  prime256v1: 'P-256',
  secp384r1: 'P-384',
  secp521r1: 'P-521',
};

export class X509Certificate {
  constructor(buffer: string | ArrayBufferView) {
    const der = unwrapCertInputToDer(buffer);
    const parsed = parseX509Der(der);
    x509Slots.set(this, parsed);
  }

  get subject(): string {
    return requireX509Slot(this).subject;
  }

  get subjectAltName(): string | undefined {
    return requireX509Slot(this).subjectAltName;
  }

  get issuer(): string {
    return requireX509Slot(this).issuer;
  }

  get issuerCertificate(): undefined {
    requireX509Slot(this);
    return undefined;
  }

  get infoAccess(): string | undefined {
    return requireX509Slot(this).infoAccess;
  }

  get validFrom(): string {
    return requireX509Slot(this).validFrom;
  }

  get validTo(): string {
    return requireX509Slot(this).validTo;
  }

  get validFromDate(): Date {
    return new Date(requireX509Slot(this).validFromDate.getTime());
  }

  get validToDate(): Date {
    return new Date(requireX509Slot(this).validToDate.getTime());
  }

  get fingerprint(): string {
    return formatColonFingerprint('sha1', requireX509Slot(this).raw);
  }

  get fingerprint256(): string {
    return formatColonFingerprint('sha256', requireX509Slot(this).raw);
  }

  get fingerprint512(): string {
    return formatColonFingerprint('sha512', requireX509Slot(this).raw);
  }

  get keyUsage(): string[] | undefined {
    const ku = requireX509Slot(this).keyUsage;
    return ku ? [...ku] : undefined;
  }

  get serialNumber(): string {
    return requireX509Slot(this).serialNumber;
  }

  get raw(): Buffer {
    return Buffer.from(requireX509Slot(this).raw);
  }

  get publicKey(): PublicKeyObject {
    const slot = requireX509Slot(this);
    if (!slot.publicKeyCache) {
      slot.publicKeyCache = createPublicKey({
        key: slot.spkiDer,
        format: 'der',
        type: 'spki',
      });
    }
    return slot.publicKeyCache;
  }

  get ca(): boolean {
    return requireX509Slot(this).ca;
  }

  toString(): string {
    return wrapPem('CERTIFICATE', requireX509Slot(this).raw);
  }

  toJSON(): string {
    return this.toString();
  }

  checkHost(name: string, options?: unknown): string | undefined {
    const slot = requireX509Slot(this);
    validateString(name, 'name');
    const opts = parseCheckOptions(options);
    if (opts.subject !== 'always') {
      for (const dns of slot.dnsAltNames) {
        if (matchDnsCandidate(name, dns, opts)) return dns;
      }
      if (opts.subject === 'never' || slot.dnsAltNames.length > 0) {
        return undefined;
      }
    }
    for (const cn of slot.subjectCnList) {
      if (matchDnsCandidate(name, cn, opts)) return cn;
    }
    return undefined;
  }

  checkEmail(email: string, options?: unknown): string | undefined {
    const slot = requireX509Slot(this);
    validateString(email, 'email');
    const opts = parseCheckOptions(options);
    const atIdx = email.indexOf('@');
    if (atIdx <= 0 || atIdx === email.length - 1) return undefined;
    const localPart = email.slice(0, atIdx);
    const domainPart = email.slice(atIdx + 1).toLowerCase();
    const matchesEmail = (candidate: string): boolean => {
      const cAt = candidate.indexOf('@');
      if (cAt <= 0) return false;
      return (
        candidate.slice(0, cAt) === localPart &&
        candidate.slice(cAt + 1).toLowerCase() === domainPart
      );
    };
    if (opts.subject !== 'always') {
      for (const em of slot.emailAltNames) {
        if (matchesEmail(em)) return em;
      }
      if (opts.subject === 'never' || slot.emailAltNames.length > 0) {
        return undefined;
      }
    }
    for (const em of slot.subjectEmailList) {
      if (matchesEmail(em)) return em;
    }
    return undefined;
  }

  checkIP(ip: string, options?: unknown): string | undefined {
    const slot = requireX509Slot(this);
    validateString(ip, 'ip');
    parseCheckOptions(options);
    if (isIP(ip) === 0) return undefined;
    const target = canonicalizeIP(ip);
    for (const cand of slot.ipAltCanonical) {
      if (cand === target) return ip;
    }
    return undefined;
  }

  checkIssued(otherCert: unknown): boolean {
    const slot = requireX509Slot(this);
    const issuerSlot =
      typeof otherCert === 'object' && otherCert !== null ? x509Slots.get(otherCert) : undefined;
    if (!issuerSlot) {
      throw invalidArgType('otherCert', 'X509Certificate', otherCert);
    }
    if (!bytesEqual(slot.issuerDer, issuerSlot.subjectDer)) return false;
    if (!bytesEqual(slot.raw, issuerSlot.raw) && !issuerSlot.ca) return false;
    return true;
  }

  checkPrivateKey(privateKey: unknown): boolean {
    const slot = requireX509Slot(this);
    if (!isKeyObject(privateKey)) {
      throw invalidArgType('privateKey', 'KeyObject', privateKey);
    }
    const inspected = inspectKeyObjectSlot(privateKey);
    if (inspected.kind !== 'private') {
      throw Object.assign(
        new TypeError(`Invalid key object type ${inspected.kind}, expected private.`),
        { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' },
      );
    }
    try {
      const derivedPub = createPublicKey(privateKey);
      if (!slot.publicKeyCache) {
        slot.publicKeyCache = createPublicKey({ key: slot.spkiDer, format: 'der', type: 'spki' });
      }
      return derivedPub.equals(slot.publicKeyCache);
    } catch {
      return false;
    }
  }

  verify(publicKey: unknown): boolean {
    const slot = requireX509Slot(this);
    if (!isKeyObject(publicKey)) {
      throw invalidArgType('publicKey', 'KeyObject', publicKey);
    }
    const inspected = inspectKeyObjectSlot(publicKey);
    if (inspected.kind !== 'public') {
      throw Object.assign(
        new TypeError(`Invalid key object type ${inspected.kind}, expected public.`),
        { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' },
      );
    }
    return verifyAsn1Signature(slot.sigAlgContent, slot.tbsRaw, slot.sigBytes, publicKey);
  }

  toLegacyObject(): Record<string, unknown> {
    const slot = requireX509Slot(this);
    const out: Record<string, unknown> = {};
    // Safe: Object.create(null) creates null-prototype subject/issuer dictionaries matching Node 22.
    out.subject = Object.assign(Object.create(null) as object, slot.subjectLegacy);
    out.issuer = Object.assign(Object.create(null) as object, slot.issuerLegacy);
    if (slot.subjectAltName !== undefined) {
      out.subjectaltname = slot.subjectAltName;
    }
    if (slot.infoAccessLegacy !== undefined) {
      const iaCopy = Object.create(null) as Record<string, string[]>;
      for (const [k, v] of Object.entries(slot.infoAccessLegacy)) {
        iaCopy[k] = [...v];
      }
      out.infoAccess = iaCopy;
    }
    out.ca = slot.ca;
    try {
      const parsedSpki = decodeSpkiDer(slot.spkiDer);
      if (parsedSpki.kind === 'rsa' || parsedSpki.kind === 'rsa-pss') {
        out.modulus = parsedSpki.n.toString(16).toUpperCase();
        out.bits = bitLengthBigInt(parsedSpki.n);
        out.exponent = `0x${parsedSpki.e.toString(16)}`;
        const outerSpki = readExactTlv(slot.spkiDer, 0x30);
        const kids = readChildren(outerSpki.content);
        out.pubkey = Buffer.from(readBitStringBytes(kids[1]));
      } else if (parsedSpki.kind === 'ec') {
        const outerSpki = readExactTlv(slot.spkiDer, 0x30);
        const kids = readChildren(outerSpki.content);
        const pt = readBitStringBytes(kids[1]);
        out.bits = (pt.byteLength - 1) * 4;
        out.pubkey = Buffer.from(pt);
        out.asn1Curve = parsedSpki.namedCurve;
        const nist = EC_NIST_NAMES[parsedSpki.namedCurve];
        if (nist) out.nistCurve = nist;
      }
    } catch {
      // Unsupported SPKI algorithms still emit standard envelope metadata.
    }
    out.valid_from = slot.validFrom;
    out.valid_to = slot.validTo;
    out.fingerprint = formatColonFingerprint('sha1', slot.raw);
    out.fingerprint256 = formatColonFingerprint('sha256', slot.raw);
    out.fingerprint512 = formatColonFingerprint('sha512', slot.raw);
    if (slot.keyUsage !== undefined) {
      out.ext_key_usage = [...slot.keyUsage];
    }
    out.serialNumber = slot.serialNumber;
    out.raw = Buffer.from(slot.raw);
    return out;
  }
}

Object.defineProperty(X509Certificate, 'name', { value: 'X509Certificate', configurable: true });

// --- Legacy SPKAC Certificate (crypto.Certificate) ---

const spkacAllowedTypes = typeList(['string'], ['ArrayBuffer', 'Buffer', 'TypedArray', 'DataView']);

function getSpkacBytes(spkac: unknown, encoding?: unknown): Uint8Array {
  if (typeof spkac === 'string') {
    return stringBytes(spkac, encoding);
  }
  const view = viewBytes(spkac);
  if (view !== undefined) return view;
  throw invalidArgType('spkac', spkacAllowedTypes, spkac);
}

interface ParsedSpkac {
  pacRaw: Uint8Array;
  spkiRaw: Buffer;
  challenge: Buffer;
  sigAlgContent: Uint8Array;
  sigBytes: Uint8Array;
}

function parseSpkacInput(rawInput: Uint8Array): ParsedSpkac | null {
  const ascii = new TextDecoder('ascii').decode(rawInput).replace(/[\r\n\s]+/g, '');
  if (ascii.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ascii)) return null;
  const der = Buffer.from(ascii, 'base64');
  try {
    const outer = readExactTlv(der, 0x30);
    const outerHdrLen = der.byteLength - outer.content.byteLength;
    const pacNode = readTlv(outer.content, 0);
    if (pacNode.tag !== 0x30) return null;
    const algNode = readTlv(outer.content, pacNode.next);
    if (algNode.tag !== 0x30) return null;
    const sigNode = readTlv(outer.content, algNode.next);
    if (sigNode.next !== outer.content.byteLength) return null;
    const sigBytes = readBitStringBytes(sigNode);

    const pacRaw = der.subarray(outerHdrLen, outerHdrLen + pacNode.next);
    const pacBase = outerHdrLen + pacNode.next - pacNode.content.byteLength;
    const spkiNode = readTlv(pacNode.content, 0);
    if (spkiNode.tag !== 0x30) return null;
    const chalNode = readTlv(pacNode.content, spkiNode.next);
    if (chalNode.tag !== 0x16 || chalNode.next !== pacNode.content.byteLength) return null;

    const spkiRaw = Buffer.from(der.subarray(pacBase, pacBase + spkiNode.next));
    const challenge = Buffer.from(chalNode.content);
    return {
      pacRaw,
      spkiRaw,
      challenge,
      sigAlgContent: algNode.content,
      sigBytes,
    };
  } catch {
    return null;
  }
}

function verifySpkac(spkac: unknown, encoding?: unknown): boolean {
  const bytes = getSpkacBytes(spkac, encoding);
  const parsed = parseSpkacInput(bytes);
  if (!parsed) return false;
  try {
    const pubKey = createPublicKey({ key: parsed.spkiRaw, format: 'der', type: 'spki' });
    return verifyAsn1Signature(parsed.sigAlgContent, parsed.pacRaw, parsed.sigBytes, pubKey);
  } catch {
    return false;
  }
}

function exportPublicKey(spkac: unknown, encoding?: unknown): Buffer {
  const bytes = getSpkacBytes(spkac, encoding);
  const parsed = parseSpkacInput(bytes);
  if (!parsed) return Buffer.alloc(0);
  try {
    createPublicKey({ key: parsed.spkiRaw, format: 'der', type: 'spki' });
    return Buffer.from(wrapPem('PUBLIC KEY', parsed.spkiRaw), 'utf8');
  } catch {
    return Buffer.alloc(0);
  }
}

function exportChallenge(spkac: unknown, encoding?: unknown): Buffer {
  const bytes = getSpkacBytes(spkac, encoding);
  const parsed = parseSpkacInput(bytes);
  if (!parsed) return Buffer.alloc(0);
  return parsed.challenge;
}

export interface CertificateInstance {
  verifySpkac(spkac: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding): boolean;
  exportPublicKey(spkac: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding): Buffer;
  exportChallenge(spkac: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding): Buffer;
}

export interface CertificateConstructor {
  new (): CertificateInstance;
  (): CertificateInstance;
  prototype: CertificateInstance;
  verifySpkac(spkac: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding): boolean;
  exportPublicKey(spkac: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding): Buffer;
  exportChallenge(spkac: string | ArrayBuffer | ArrayBufferView, encoding?: BufferEncoding): Buffer;
}

const CertificateFn = function Certificate(this: unknown) {
  if (!(this instanceof CertificateFn)) {
    // Invariant: CertificateFn is a callable constructor function.
    return new (CertificateFn as unknown as new () => CertificateInstance)();
  }
};

Object.defineProperties(CertificateFn.prototype, {
  verifySpkac: { writable: true, configurable: true, value: verifySpkac },
  exportPublicKey: { writable: true, configurable: true, value: exportPublicKey },
  exportChallenge: { writable: true, configurable: true, value: exportChallenge },
});

Object.defineProperties(CertificateFn, {
  exportChallenge: { writable: true, configurable: true, enumerable: true, value: exportChallenge },
  exportPublicKey: { writable: true, configurable: true, enumerable: true, value: exportPublicKey },
  verifySpkac: { writable: true, configurable: true, enumerable: true, value: verifySpkac },
});

// Invariant: static and prototype methods defined above match CertificateConstructor.
export const Certificate = CertificateFn as unknown as CertificateConstructor;
