import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { copyBytesFrom } from '../../src/buffer-extras';
import { createBufferBuiltin } from '../../src/builtins/buffer';
import { createCryptoBuiltin } from '../../src/builtins/crypto';

function callUntyped(fn: unknown, ...args: unknown[]): unknown {
  if (typeof fn !== 'function') {
    throw new TypeError('Expected callable function');
  }
  return Reflect.apply(fn, undefined, args);
}

function makeCrypto() {
  return createCryptoBuiltin({
    retain: () => () => {},
    setImmediate: (cb) => {
      queueMicrotask(cb);
      return {};
    },
    schedule: (cb) => queueMicrotask(cb),
    process: new EventEmitter(),
    stream: {},
  });
}

describe('Lane R2b — node:buffer & node:crypto runtime parity', () => {
  describe('Slice 1: node:buffer surface, descriptors, SlowBuffer, copyBytesFrom, transcode, Blob/File/atob/btoa/resolveObjectURL', () => {
    it('exports all 14 Node 22.18.0 buffer keys with matching property descriptors', () => {
      const bufMod = createBufferBuiltin({
        process: new EventEmitter(),
        retain: () => () => {},
      });

      expect(Object.keys(bufMod)).toEqual([
        'Buffer',
        'SlowBuffer',
        'transcode',
        'isUtf8',
        'isAscii',
        'kMaxLength',
        'kStringMaxLength',
        'btoa',
        'atob',
        'constants',
        'INSPECT_MAX_BYTES',
        'Blob',
        'resolveObjectURL',
        'File',
      ]);

      expect(bufMod.Blob).toBe(globalThis.Blob);
      expect(bufMod.File).toBe(globalThis.File);
      expect(Reflect.get(bufMod.Buffer, 'copyBytesFrom')).toBe(copyBytesFrom);

      const inspectDesc = Object.getOwnPropertyDescriptor(bufMod, 'INSPECT_MAX_BYTES');
      expect(inspectDesc).toBeDefined();
      expect(inspectDesc?.enumerable).toBe(true);
      expect(inspectDesc?.configurable).toBe(true);
      expect(typeof inspectDesc?.get).toBe('function');
      expect(typeof inspectDesc?.set).toBe('function');

      const constantsDesc = Object.getOwnPropertyDescriptor(bufMod, 'constants');
      expect(constantsDesc).toMatchObject({
        enumerable: true,
        configurable: false,
        writable: false,
      });
    });

    it('validates INSPECT_MAX_BYTES getter and setter like Node 22.18.0', () => {
      const bufMod = createBufferBuiltin();
      expect(bufMod.INSPECT_MAX_BYTES).toBe(50);
      bufMod.INSPECT_MAX_BYTES = 128;
      expect(bufMod.INSPECT_MAX_BYTES).toBe(128);
      bufMod.INSPECT_MAX_BYTES = 0;
      expect(bufMod.INSPECT_MAX_BYTES).toBe(0);
      bufMod.INSPECT_MAX_BYTES = 50;

      expect(() => {
        Reflect.set(bufMod, 'INSPECT_MAX_BYTES', '50');
      }).toThrowError(expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }));

      for (const bad of [-1, -0.5, Number.NaN]) {
        expect(() => {
          bufMod.INSPECT_MAX_BYTES = bad;
        }).toThrowError(expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }));
      }
    });

    it('implements SlowBuffer constructor/callable semantics and prototype chain', () => {
      const bufMod = createBufferBuiltin();
      const { Buffer: Buf, SlowBuffer } = bufMod;

      const sb1 = SlowBuffer(8);
      const sb2 = new SlowBuffer(4);
      expect(Buf.isBuffer(sb1)).toBe(true);
      expect(Buf.isBuffer(sb2)).toBe(true);
      expect(sb1.length).toBe(8);
      expect(sb2.length).toBe(4);
      expect(sb1 instanceof Buf).toBe(true);
      expect(sb1 instanceof SlowBuffer).toBe(false);
      expect(Object.getPrototypeOf(SlowBuffer.prototype)).toBe(Uint8Array.prototype);
      expect(Object.getPrototypeOf(SlowBuffer)).toBe(Uint8Array);

      expect(() => callUntyped(SlowBuffer, '8')).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
      );
      expect(() => SlowBuffer(-1)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
      expect(() => SlowBuffer(Number.NaN)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
    });

    it('implements Buffer.copyBytesFrom across TypedArray views and validates arguments', () => {
      const { Buffer: Buf } = createBufferBuiltin();
      const u16 = new Uint16Array([0x0102, 0x0304, 0x0506]);
      const full = Buf.copyBytesFrom(u16);
      expect(Buf.isBuffer(full)).toBe(true);
      expect(full).toEqual(Buf.from(new Uint8Array(u16.buffer)));

      // Mutating original view does not mutate copied Buffer
      u16[0] = 0xffff;
      expect(full[0]).not.toBe(0xff);

      const u16b = new Uint16Array([0x1122, 0x3344, 0x5566, 0x7788]);
      const sliced = Buf.copyBytesFrom(u16b, 1, 2);
      expect(sliced).toEqual(Buf.from(new Uint8Array(u16b.buffer, 2, 4)));

      expect(Buf.copyBytesFrom(u16b, 4)).toEqual(Buf.alloc(0));
      expect(Buf.copyBytesFrom(u16b, 10)).toEqual(Buf.alloc(0));
      expect(Buf.copyBytesFrom(u16b, 2, 99)).toEqual(Buf.from(new Uint8Array(u16b.buffer, 4, 4)));

      for (const badView of [
        new ArrayBuffer(4),
        new DataView(new ArrayBuffer(4)),
        [1, 2],
        'ab',
        null,
      ]) {
        expect(() => callUntyped(Buf.copyBytesFrom, badView)).toThrowError(
          expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
        );
      }
      expect(() => Buf.copyBytesFrom(u16b, -1)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
      expect(() => Buf.copyBytesFrom(u16b, 0, -1)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
      expect(() => Buf.copyBytesFrom(u16b, 1.5)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
      expect(() => callUntyped(Buf.copyBytesFrom, u16b, '0')).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
      );
    });

    it('implements btoa and atob with Node ERR_MISSING_ARGS and InvalidCharacterError semantics', () => {
      const { btoa, atob } = createBufferBuiltin();
      expect(btoa('hello world')).toBe('aGVsbG8gd29ybGQ=');
      expect(atob('aGVsbG8gd29ybGQ=')).toBe('hello world');
      expect(callUntyped(btoa, 123)).toBe('MTIz');

      expect(() => callUntyped(btoa)).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_MISSING_ARGS' }),
      );
      expect(() => callUntyped(atob)).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_MISSING_ARGS' }),
      );
      expect(() => btoa('😀')).toThrowError(
        expect.objectContaining({ name: 'InvalidCharacterError' }),
      );
      expect(() => atob('%%%')).toThrowError(
        expect.objectContaining({ name: 'InvalidCharacterError' }),
      );
    });

    it('implements transcode across all supported encodings and ICU error codes', () => {
      const { Buffer: Buf, transcode } = createBufferBuiltin();

      expect(transcode(Buf.from('héllo € 😀', 'utf8'), 'utf8', 'ascii').toString('ascii')).toBe(
        'h?llo ? ?',
      );
      expect(transcode(Buf.from('héllo € 😀', 'utf8'), 'utf-8', 'latin1').toString('latin1')).toBe(
        'héllo ? ?',
      );
      expect(transcode(Buf.from('héllo 😀', 'utf16le'), 'utf16le', 'utf8').toString('utf8')).toBe(
        'héllo 😀',
      );
      expect(transcode(Buf.from('héllo', 'utf8'), 'utf8', 'ucs2')).toEqual(
        Buf.from('héllo', 'utf16le'),
      );
      expect(transcode(Buf.from([0x80, 0xff]), 'ascii', 'utf8')).toEqual(
        Buf.from('\ufffd\ufffd', 'utf8'),
      );
      expect(transcode(Buf.from([0x41, 0x00, 0x42]), 'utf16le', 'utf8').toString('utf8')).toBe('A');
      expect(callUntyped(transcode, Buf.alloc(0), 'unknown-enc', 'utf8')).toEqual(Buf.alloc(0));

      expect(() => transcode(Buf.from([0x00, 0xd8]), 'utf16le', 'utf8')).toThrowError(
        expect.objectContaining({ code: 'U_INVALID_CHAR_FOUND' }),
      );
      expect(() => callUntyped(transcode, Buf.from('a'), 'nope', 'utf8')).toThrowError(
        expect.objectContaining({ code: 'U_ILLEGAL_ARGUMENT_ERROR' }),
      );
      expect(() =>
        callUntyped(transcode, new DataView(new ArrayBuffer(2)), 'utf8', 'ascii'),
      ).toThrowError(expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }));
    });

    it('resolves Blob instances registered with URL.createObjectURL until revoked', async () => {
      const { Blob: BufBlob, File: BufFile, resolveObjectURL } = createBufferBuiltin();
      expect(resolveObjectURL('not-a-url')).toBeUndefined();
      expect(resolveObjectURL('blob:https://example.test/unknown-object-id')).toBeUndefined();
      expect(callUntyped(resolveObjectURL, undefined)).toBeUndefined();

      const blob = new BufBlob(['hello blob'], { type: 'text/plain' });
      expect(await blob.bytes()).toEqual(new TextEncoder().encode('hello blob'));

      const file = new BufFile(['file-body'], 'greeting.txt', {
        type: 'text/plain',
        lastModified: 1700000000000,
      });
      expect(file.name).toBe('greeting.txt');
      expect(file.lastModified).toBe(1700000000000);

      const url = URL.createObjectURL(blob);
      const resolved1 = resolveObjectURL(url);
      const resolved2 = resolveObjectURL(url);
      expect(resolved1).toBeInstanceOf(BufBlob);
      expect(resolved1).not.toBe(blob);
      expect(resolved1).not.toBe(resolved2);
      expect(resolved1?.size).toBe(10);
      expect(resolved1?.type).toBe('text/plain');
      expect(await resolved1?.text()).toBe('hello blob');

      URL.revokeObjectURL(url);
      expect(resolveObjectURL(url)).toBeUndefined();
    });
  });

  describe('Slice 2: crypto descriptors, Hash Transform + copy(), random aliases, and randomInt', () => {
    it('exposes Node 22.18.0 accessor descriptors on webcrypto, subtle, getRandomValues, defaultCipherList, and prng/pseudoRandomBytes/rng', () => {
      const crypto = makeCrypto();

      for (const prop of ['webcrypto', 'subtle', 'getRandomValues'] as const) {
        const desc = Object.getOwnPropertyDescriptor(crypto, prop);
        expect(desc).toBeDefined();
        expect('value' in (desc ?? {})).toBe(false);
        expect(typeof desc?.get).toBe('function');
        expect(desc?.set).toBeUndefined();
        expect(desc?.enumerable).toBe(true);
        expect(desc?.configurable).toBe(false);
      }

      expect(crypto.webcrypto).toBe(globalThis.crypto);
      expect(crypto.subtle).toBe(globalThis.crypto.subtle);
      const arr = new Uint8Array(8);
      expect(crypto.getRandomValues(arr)).toBe(arr);

      const cipherListDesc = Object.getOwnPropertyDescriptor(crypto.constants, 'defaultCipherList');
      expect(cipherListDesc).toBeDefined();
      expect('value' in (cipherListDesc ?? {})).toBe(false);
      expect(typeof cipherListDesc?.get).toBe('function');
      expect(typeof cipherListDesc?.set).toBe('function');
      expect(cipherListDesc?.enumerable).toBe(true);
      expect(cipherListDesc?.configurable).toBe(true);
      expect(typeof crypto.constants.defaultCipherList).toBe('string');

      for (const alias of ['prng', 'pseudoRandomBytes', 'rng'] as const) {
        const desc = Object.getOwnPropertyDescriptor(crypto, alias);
        expect(desc).toBeDefined();
        expect('value' in (desc ?? {})).toBe(false);
        expect(typeof desc?.get).toBe('function');
        expect(typeof desc?.set).toBe('function');
        expect(desc?.enumerable).toBe(false);
        expect(desc?.configurable).toBe(true);
        const fn = Reflect.get(crypto, alias);
        expect(typeof fn).toBe('function');
        const buf = callUntyped(fn, 12);
        expect(Buffer.isBuffer(buf)).toBe(true);
        if (Buffer.isBuffer(buf)) {
          expect(buf.length).toBe(12);
        }
      }
    });

    it('exports Hash constructor, callable without new, Transform streaming, and O(1) hash.copy()', async () => {
      const crypto = makeCrypto();
      const { Hash: HashCtor } = crypto;
      expect(typeof HashCtor).toBe('function');

      const h1 = crypto.createHash('sha256');
      expect(h1 instanceof HashCtor).toBe(true);
      h1.update('hel');
      const h2 = h1.copy();
      h1.update('lo');
      h2.update('p!');

      expect(h1.digest('hex')).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
      expect(h2.digest('hex')).toBe(
        '8defd04eafd7c2be4ce734984c00a4205e33936fcb059e16a026b86d07c6a145',
      );

      expect(() => h1.copy()).toThrowError(
        expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }),
      );
      expect(() => h1.digest('hex')).toThrowError(
        expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }),
      );
      expect(() => h1.update('x')).toThrowError(
        expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }),
      );

      // Test sha512 copy across multi-block boundary (> 128 bytes)
      const bigPrefix = 'x'.repeat(200);
      const s512a = HashCtor('sha512');
      s512a.update(bigPrefix);
      const s512b = s512a.copy();
      s512a.update('-tailA');
      s512b.update('-tailB');
      expect(s512a.digest('hex')).toBe(
        crypto
          .createHash('sha512')
          .update(bigPrefix + '-tailA')
          .digest('hex'),
      );
      expect(s512b.digest('hex')).toBe(
        crypto
          .createHash('sha512')
          .update(bigPrefix + '-tailB')
          .digest('hex'),
      );

      // Stream write/end/read
      const streamHash = crypto.createHash('sha256');
      streamHash.setEncoding('hex');
      streamHash.write('abc');
      streamHash.end('def');
      expect(streamHash.read()).toBe(crypto.createHash('sha256').update('abcdef').digest('hex'));
    });

    it('implements sync and async crypto.randomInt with unbiased bounds and Node error codes', async () => {
      const crypto = makeCrypto();
      const { randomInt } = crypto;
      expect(typeof randomInt).toBe('function');

      for (let i = 0; i < 50; i++) {
        const v1 = callUntyped(randomInt, 7);
        expect(typeof v1).toBe('number');
        expect(v1).toBeGreaterThanOrEqual(0);
        expect(v1).toBeLessThan(7);

        const v2 = callUntyped(randomInt, -10, -5);
        expect(v2).toBeGreaterThanOrEqual(-10);
        expect(v2).toBeLessThan(-5);
      }

      expect(callUntyped(randomInt, 42, 43)).toBe(42);

      const asyncSingleArg = await new Promise<[unknown, unknown]>((resolve) => {
        callUntyped(randomInt, 10, (err: unknown, n: unknown) => resolve([err, n]));
      });
      expect(asyncSingleArg[0]).toBeUndefined();
      expect(typeof asyncSingleArg[1]).toBe('number');
      expect(asyncSingleArg[1]).toBeGreaterThanOrEqual(0);
      expect(asyncSingleArg[1]).toBeLessThan(10);

      const asyncTwoArgs = await new Promise<[unknown, unknown]>((resolve) => {
        callUntyped(randomInt, 100, 101, (err: unknown, n: unknown) => resolve([err, n]));
      });
      expect(asyncTwoArgs).toEqual([undefined, 100]);

      expect(() => callUntyped(randomInt, 5, 5)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
      expect(() => callUntyped(randomInt, 10, 5)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
      expect(() => callUntyped(randomInt, 0, 2 ** 48)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
      expect(() => callUntyped(randomInt, '5')).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
      );
      expect(() => callUntyped(randomInt, 1.5)).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
      );
      expect(() => callUntyped(randomInt, 1, 5, 'not-a-fn')).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
      );
    });
  });

  describe('Slice 3: crypto checkPrime, checkPrimeSync, generatePrime, and generatePrimeSync', () => {
    it('validates and checks primality across BigInt, ArrayBuffer, and TypedArray inputs', async () => {
      const crypto = makeCrypto();
      const { checkPrimeSync, checkPrime } = crypto;
      expect(typeof checkPrimeSync).toBe('function');
      expect(typeof checkPrime).toBe('function');

      expect(
        [0n, 1n, 2n, 3n, 4n, 15n, 17n, 561n, 65537n].map((n) => callUntyped(checkPrimeSync, n)),
      ).toEqual([
        false,
        false,
        true,
        true,
        false,
        false,
        true,
        false, // 561 = Carmichael number 3 * 11 * 17
        true,
      ]);

      // Mersenne prime 2^127 - 1 and composite (2^64 - 1)
      expect(callUntyped(checkPrimeSync, (1n << 127n) - 1n, { checks: 8 })).toBe(true);
      expect(callUntyped(checkPrimeSync, (1n << 64n) - 1n)).toBe(false);

      // ArrayBuffer and Buffer big-endian inputs (0x0101 = 257 is prime)
      const ab257 = Uint8Array.of(1, 1).buffer;
      expect(callUntyped(checkPrimeSync, ab257)).toBe(true);
      expect(callUntyped(checkPrimeSync, Buffer.from([1, 0]))).toBe(false);

      const asyncRes = await new Promise<[unknown, unknown]>((resolve) => {
        callUntyped(checkPrime, 104729n, (err: unknown, ok: unknown) => resolve([err, ok]));
      });
      expect(asyncRes).toEqual([undefined, true]);

      expect(() => callUntyped(checkPrimeSync, -5n)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
      expect(() => callUntyped(checkPrimeSync, 17)).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
      );
      expect(() => callUntyped(checkPrimeSync, 17n, { checks: -1 })).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
    });

    it('generates standard, safe, and add/rem-constrained primes in sync and async modes', async () => {
      const crypto = makeCrypto();
      const { generatePrimeSync, generatePrime, checkPrimeSync } = crypto;
      expect(typeof generatePrimeSync).toBe('function');
      expect(typeof generatePrime).toBe('function');

      const pBuf = callUntyped(generatePrimeSync, 64);
      expect(pBuf).toBeInstanceOf(ArrayBuffer);
      expect((pBuf as ArrayBuffer).byteLength).toBe(8);
      expect(callUntyped(checkPrimeSync, pBuf)).toBe(true);

      const pSafe = callUntyped(generatePrimeSync, 48, { bigint: true, safe: true }) as bigint;
      expect(typeof pSafe).toBe('bigint');
      expect(callUntyped(checkPrimeSync, pSafe)).toBe(true);
      expect(callUntyped(checkPrimeSync, (pSafe - 1n) / 2n)).toBe(true);

      const pMod = callUntyped(generatePrimeSync, 64, {
        bigint: true,
        add: 12n,
        rem: 5n,
      }) as bigint;
      expect(pMod % 12n).toBe(5n);
      expect(callUntyped(checkPrimeSync, pMod)).toBe(true);

      expect(callUntyped(generatePrimeSync, 2, { bigint: true })).toBe(3n);
      expect(callUntyped(generatePrimeSync, 3, { bigint: true, safe: true })).toBe(7n);

      const asyncPrime = await new Promise<[unknown, unknown]>((resolve) => {
        callUntyped(generatePrime, 64, { bigint: true }, (err: unknown, p: unknown) =>
          resolve([err, p]),
        );
      });
      expect(asyncPrime[0]).toBeUndefined();
      expect(typeof asyncPrime[1]).toBe('bigint');
      expect(callUntyped(checkPrimeSync, asyncPrime[1])).toBe(true);

      expect(() => callUntyped(generatePrimeSync, 0)).toThrowError(
        expect.objectContaining({ name: 'RangeError', code: 'ERR_OUT_OF_RANGE' }),
      );
      expect(() => callUntyped(generatePrimeSync, '64')).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' }),
      );
      expect(() => callUntyped(generatePrimeSync, 1)).toThrowError(/bits too small/);
      expect(() => callUntyped(generatePrimeSync, 4, { safe: true })).toThrowError(
        /bits too small/,
      );
    });
  });

  describe('Slice 4: streaming Sign/Verify (createSign/createVerify) and RSA publicEncrypt/privateDecrypt/privateEncrypt/publicDecrypt', () => {
    it('supports streaming Sign and Verify across RSA PKCS#1 v1.5, RSA-PSS, and ECDSA (DER & IEEE-P1363), plus Writable piping', async () => {
      const crypto = makeCrypto();
      const { Sign: SignCtor, Verify: VerifyCtor, createSign, createVerify } = crypto;

      expect(typeof SignCtor).toBe('function');
      expect(typeof VerifyCtor).toBe('function');
      expect(typeof createSign).toBe('function');
      expect(typeof createVerify).toBe('function');

      const rsaPair = await new Promise<{ publicKey: unknown; privateKey: unknown }>(
        (resolve, reject) => {
          crypto.generateKeyPair(
            'rsa',
            { modulusLength: 2048 },
            (err: Error | null, pub: unknown, priv: unknown) => {
              if (err) reject(err);
              else resolve({ publicKey: pub, privateKey: priv });
            },
          );
        },
      );

      // RSA PKCS#1 v1.5 streaming sign & verify
      const signer = callUntyped(createSign, 'RSA-SHA256') as {
        update(d: string): unknown;
        sign(k: unknown, enc?: string): string | Buffer;
      };
      expect(signer instanceof SignCtor).toBe(true);
      signer.update('hello ');
      signer.update('streaming world');
      const sigHex = signer.sign(rsaPair.privateKey, 'hex') as string;
      expect(typeof sigHex).toBe('string');

      const verifier = callUntyped(createVerify, 'SHA256') as {
        update(d: string): unknown;
        verify(k: unknown, s: unknown, enc?: string): boolean;
      };
      expect(verifier instanceof VerifyCtor).toBe(true);
      verifier.update('hello streaming ');
      verifier.update('world');
      expect(verifier.verify(rsaPair.publicKey, sigHex, 'hex')).toBe(true);

      const tamperedVerifier = callUntyped(createVerify, 'SHA256') as typeof verifier;
      tamperedVerifier.update('hello tampered world');
      expect(tamperedVerifier.verify(rsaPair.publicKey, sigHex, 'hex')).toBe(false);

      // RSA-PSS streaming sign & verify (with SALTLEN_AUTO)
      const pssSigner = callUntyped(SignCtor, 'sha384') as typeof signer;
      pssSigner.update('pss-payload');
      const pssSig = pssSigner.sign({
        key: rsaPair.privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      }) as Buffer;
      expect(Buffer.isBuffer(pssSig)).toBe(true);

      const pssVerifier = callUntyped(VerifyCtor, 'sha384') as typeof verifier;
      pssVerifier.update('pss-payload');
      expect(
        pssVerifier.verify(
          { key: rsaPair.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
          pssSig,
        ),
      ).toBe(true);

      // ECDSA P-256 DER and IEEE-P1363 streaming sign & verify + Writable .write/.end
      const ecPair = await new Promise<{ publicKey: unknown; privateKey: unknown }>(
        (resolve, reject) => {
          crypto.generateKeyPair(
            'ec',
            { namedCurve: 'P-256' },
            (err: Error | null, pub: unknown, priv: unknown) => {
              if (err) reject(err);
              else resolve({ publicKey: pub, privateKey: priv });
            },
          );
        },
      );

      const ecSignDer = callUntyped(createSign, 'SHA256') as {
        write(chunk: string): boolean;
        end(chunk: string): void;
        sign(k: unknown): Buffer;
      };
      ecSignDer.write('ec-stream-');
      ecSignDer.end('body');
      const ecDerSig = ecSignDer.sign(ecPair.privateKey);

      const ecVerifyDer = callUntyped(createVerify, 'SHA256') as typeof verifier;
      ecVerifyDer.update('ec-stream-body');
      expect(ecVerifyDer.verify(ecPair.publicKey, ecDerSig)).toBe(true);

      const ecSignP1363 = callUntyped(createSign, 'SHA256') as typeof signer;
      ecSignP1363.update('p1363-msg');
      const p1363Sig = ecSignP1363.sign({
        key: ecPair.privateKey,
        dsaEncoding: 'ieee-p1363',
      }) as Buffer;
      expect(p1363Sig.length).toBe(64);

      const ecVerifyP1363 = callUntyped(createVerify, 'SHA256') as typeof verifier;
      ecVerifyP1363.update('p1363-msg');
      expect(
        ecVerifyP1363.verify({ key: ecPair.publicKey, dsaEncoding: 'ieee-p1363' }, p1363Sig),
      ).toBe(true);

      // Preserves ENOSYS on one-shot sync crypto.sign/crypto.verify without callback
      expect(() =>
        callUntyped(crypto.sign, null, Buffer.from('a'), rsaPair.privateKey),
      ).toThrowError(expect.objectContaining({ code: 'ENOSYS' }));
    });

    it('implements RSA publicEncrypt, privateDecrypt, privateEncrypt, and publicDecrypt across OAEP, PKCS1, and NO_PADDING', async () => {
      const crypto = makeCrypto();
      const { publicEncrypt, privateDecrypt, privateEncrypt, publicDecrypt } = crypto;

      expect(typeof publicEncrypt).toBe('function');
      expect(typeof privateDecrypt).toBe('function');
      expect(typeof privateEncrypt).toBe('function');
      expect(typeof publicDecrypt).toBe('function');

      const rsaPair = await new Promise<{ publicKey: unknown; privateKey: unknown }>(
        (resolve, reject) => {
          crypto.generateKeyPair(
            'rsa',
            { modulusLength: 2048 },
            (err: Error | null, pub: unknown, priv: unknown) => {
              if (err) reject(err);
              else resolve({ publicKey: pub, privateKey: priv });
            },
          );
        },
      );

      // Default OAEP (SHA-1)
      const ctOaep = callUntyped(
        publicEncrypt,
        rsaPair.publicKey,
        Buffer.from('hello-oaep'),
      ) as Buffer;
      expect(Buffer.isBuffer(ctOaep)).toBe(true);
      expect(ctOaep.length).toBe(256);
      const ptOaep = callUntyped(privateDecrypt, rsaPair.privateKey, ctOaep) as Buffer;
      expect(ptOaep.toString('utf8')).toBe('hello-oaep');

      // OAEP with SHA-256 and oaepLabel
      const ctOaep256 = callUntyped(
        publicEncrypt,
        { key: rsaPair.publicKey, oaepHash: 'sha256', oaepLabel: Buffer.from('ctx-label') },
        Buffer.from('oaep-sha256-msg'),
      ) as Buffer;
      const ptOaep256 = callUntyped(
        privateDecrypt,
        { key: rsaPair.privateKey, oaepHash: 'sha256', oaepLabel: Buffer.from('ctx-label') },
        ctOaep256,
      ) as Buffer;
      expect(ptOaep256.toString('utf8')).toBe('oaep-sha256-msg');

      // Wrong oaepLabel fails OAEP decryption
      expect(() =>
        callUntyped(
          privateDecrypt,
          { key: rsaPair.privateKey, oaepHash: 'sha256', oaepLabel: Buffer.from('wrong-label') },
          ctOaep256,
        ),
      ).toThrow();

      // privateEncrypt & publicDecrypt (PKCS#1 v1.5 type-1 padding)
      const sealed = callUntyped(
        privateEncrypt,
        rsaPair.privateKey,
        Buffer.from('signed-envelope'),
      ) as Buffer;
      const opened = callUntyped(publicDecrypt, rsaPair.publicKey, sealed) as Buffer;
      expect(opened.toString('utf8')).toBe('signed-envelope');

      // RSA_NO_PADDING round-trip
      const rawBlock = Buffer.alloc(256);
      rawBlock[0] = 0x00;
      rawBlock[1] = 0x42;
      rawBlock[255] = 0x99;
      const ctRaw = callUntyped(
        publicEncrypt,
        { key: rsaPair.publicKey, padding: crypto.constants.RSA_NO_PADDING },
        rawBlock,
      ) as Buffer;
      const ptRaw = callUntyped(
        privateDecrypt,
        { key: rsaPair.privateKey, padding: crypto.constants.RSA_NO_PADDING },
        ctRaw,
      ) as Buffer;
      expect(ptRaw).toEqual(rawBlock);

      // Node 22.18.0 CVE-2023-46809 mitigation: RSA_PKCS1_PADDING rejected for privateDecrypt
      expect(() =>
        callUntyped(
          privateDecrypt,
          { key: rsaPair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.alloc(256),
        ),
      ).toThrowError(expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' }));
    });
  });

  describe('Slice 5: DiffieHellman, DiffieHellmanGroup, stateless diffieHellman, ECDH, and getCurves', () => {
    it('implements DiffieHellman, DiffieHellmanGroup, MODP groups, verifyError, and stateless diffieHellman across x25519, ec, and dh KeyObjects', async () => {
      const crypto = makeCrypto();
      const {
        DiffieHellman,
        DiffieHellmanGroup,
        createDiffieHellman,
        createDiffieHellmanGroup,
        getDiffieHellman,
        diffieHellman,
      } = crypto;

      expect(typeof DiffieHellman).toBe('function');
      expect(typeof DiffieHellmanGroup).toBe('function');
      expect(typeof createDiffieHellman).toBe('function');
      expect(typeof createDiffieHellmanGroup).toBe('function');
      expect(typeof getDiffieHellman).toBe('function');
      expect(typeof diffieHellman).toBe('function');

      // Standard RFC 3526 modp14 group exchange
      const aliceGroup = callUntyped(getDiffieHellman, 'modp14') as {
        generateKeys(enc?: string): Buffer | string;
        computeSecret(other: Buffer | string, inEnc?: string, outEnc?: string): Buffer | string;
        getPrime(): Buffer;
        getGenerator(): Buffer;
        getPublicKey(enc?: string): Buffer | string;
        getPrivateKey(enc?: string): Buffer | string;
      };
      const bobGroup = callUntyped(createDiffieHellmanGroup, 'modp14') as typeof aliceGroup;
      expect(aliceGroup instanceof DiffieHellmanGroup).toBe(true);
      expect('setPublicKey' in aliceGroup).toBe(false);
      expect('setPrivateKey' in aliceGroup).toBe(false);
      expect(aliceGroup.getPrime().length).toBe(256);
      expect(aliceGroup.getGenerator()).toEqual(Buffer.from([0x02]));

      const alicePub = aliceGroup.generateKeys() as Buffer;
      const bobPubHex = bobGroup.generateKeys('hex') as string;
      const sharedA = aliceGroup.computeSecret(bobPubHex, 'hex') as Buffer;
      const sharedB = bobGroup.computeSecret(alicePub) as Buffer;
      expect(sharedA).toEqual(sharedB);
      expect(sharedA.length).toBe(256);

      // Custom DiffieHellman with setPublicKey/setPrivateKey and verifyError
      const customA = callUntyped(
        createDiffieHellman,
        aliceGroup.getPrime(),
        aliceGroup.getGenerator(),
      ) as {
        generateKeys(): Buffer;
        computeSecret(other: Buffer): Buffer;
        setPrivateKey(k: Buffer): void;
        setPublicKey(k: Buffer): void;
        getPublicKey(): Buffer;
        getPrivateKey(): Buffer;
        verifyError: number;
      };
      expect(customA instanceof DiffieHellman).toBe(true);
      expect(customA.verifyError).toBe(0);
      customA.setPrivateKey(aliceGroup.getPrivateKey() as Buffer);
      customA.setPublicKey(alicePub);
      expect(customA.computeSecret(Buffer.from(bobPubHex, 'hex'))).toEqual(sharedA);

      const compositeDh = callUntyped(createDiffieHellman, Buffer.alloc(64, 0x10)) as {
        verifyError: number;
      };
      expect((compositeDh.verifyError & Number(crypto.constants.DH_CHECK_P_NOT_PRIME)) !== 0).toBe(
        true,
      );

      // Stateless crypto.diffieHellman over X25519 and EC KeyObjects
      const x1 = await new Promise<{ publicKey: unknown; privateKey: unknown }>((res, rej) =>
        crypto.generateKeyPair('x25519', (e: Error | null, pub: unknown, priv: unknown) =>
          e ? rej(e) : res({ publicKey: pub, privateKey: priv }),
        ),
      );
      const x2 = await new Promise<{ publicKey: unknown; privateKey: unknown }>((res, rej) =>
        crypto.generateKeyPair('x25519', (e: Error | null, pub: unknown, priv: unknown) =>
          e ? rej(e) : res({ publicKey: pub, privateKey: priv }),
        ),
      );
      const xShared1 = callUntyped(diffieHellman, {
        privateKey: x1.privateKey,
        publicKey: x2.publicKey,
      }) as Buffer;
      const xShared2 = callUntyped(diffieHellman, {
        privateKey: x2.privateKey,
        publicKey: x1.publicKey,
      }) as Buffer;
      expect(xShared1).toEqual(xShared2);
      expect(xShared1.length).toBe(32);

      const ec1 = await new Promise<{ publicKey: unknown; privateKey: unknown }>((res, rej) =>
        crypto.generateKeyPair(
          'ec',
          { namedCurve: 'prime256v1' },
          (e: Error | null, pub: unknown, priv: unknown) =>
            e ? rej(e) : res({ publicKey: pub, privateKey: priv }),
        ),
      );
      const ec2 = await new Promise<{ publicKey: unknown; privateKey: unknown }>((res, rej) =>
        crypto.generateKeyPair(
          'ec',
          { namedCurve: 'prime256v1' },
          (e: Error | null, pub: unknown, priv: unknown) =>
            e ? rej(e) : res({ publicKey: pub, privateKey: priv }),
        ),
      );
      const ecShared1 = callUntyped(diffieHellman, {
        privateKey: ec1.privateKey,
        publicKey: ec2.publicKey,
      }) as Buffer;
      const ecShared2 = callUntyped(diffieHellman, {
        privateKey: ec2.privateKey,
        publicKey: ec1.publicKey,
      }) as Buffer;
      expect(ecShared1).toEqual(ecShared2);
      expect(ecShared1.length).toBe(32);

      expect(() =>
        callUntyped(diffieHellman, { privateKey: x1.privateKey, publicKey: ec2.publicKey }),
      ).toThrowError(expect.objectContaining({ code: 'ERR_CRYPTO_INCOMPATIBLE_KEY' }));
    });

    it('implements ECDH, createECDH, ECDH.convertKey, and getCurves across prime256v1, secp384r1, secp521r1, and secp256k1', () => {
      const crypto = makeCrypto();
      const { ECDH, createECDH, getCurves } = crypto;

      expect(typeof ECDH).toBe('function');
      expect(typeof ECDH.convertKey).toBe('function');
      expect(typeof createECDH).toBe('function');
      expect(typeof getCurves).toBe('function');

      const curves = getCurves();
      expect(curves).toEqual(['prime256v1', 'secp256k1', 'secp384r1', 'secp521r1']);

      for (const curve of curves) {
        const a = callUntyped(createECDH, curve) as {
          generateKeys(enc?: string, format?: string): Buffer | string;
          computeSecret(other: Buffer | string, inEnc?: string, outEnc?: string): Buffer | string;
          getPublicKey(enc?: string, format?: string): Buffer | string;
          getPrivateKey(enc?: string): Buffer | string;
          setPrivateKey(k: Buffer | string, enc?: string): void;
        };
        const b = callUntyped(ECDH, curve) as typeof a;
        expect(a instanceof ECDH).toBe(true);
        const pubAUncomp = a.generateKeys() as Buffer;
        const pubBCompHex = b.generateKeys('hex', 'compressed') as string;
        const secA = a.computeSecret(pubBCompHex, 'hex') as Buffer;
        const secB = b.computeSecret(pubAUncomp) as Buffer;
        expect(secA).toEqual(secB);

        const convertedComp = ECDH.convertKey(
          pubAUncomp,
          curve,
          undefined,
          undefined,
          'compressed',
        ) as Buffer;
        const convertedBack = ECDH.convertKey(
          convertedComp,
          curve,
          undefined,
          undefined,
          'uncompressed',
        ) as Buffer;
        expect(convertedBack).toEqual(pubAUncomp);
      }

      expect(() => callUntyped(createECDH, 'P-256')).toThrowError(
        expect.objectContaining({ name: 'TypeError', code: 'ERR_CRYPTO_INVALID_CURVE' }),
      );
    });
  });

  describe('Slice 6: X509Certificate and legacy SPKAC Certificate', () => {
    it('parses DER/PEM X509Certificate v3 fields, extensions, fingerprints, identity checks, key checks, verify, and toLegacyObject', async () => {
      const crypto = makeCrypto();
      const X509Certificate = Reflect.get(crypto, 'X509Certificate') as new (
        buf: Buffer | string,
      ) => {
        subject: string;
        issuer: string;
        subjectAltName: string | undefined;
        infoAccess: string | undefined;
        validFrom: string;
        validTo: string;
        validFromDate: Date;
        validToDate: Date;
        serialNumber: string;
        fingerprint: string;
        fingerprint256: string;
        fingerprint512: string;
        ca: boolean;
        keyUsage: string[] | undefined;
        issuerCertificate: unknown;
        publicKey: { equals(other: unknown): boolean };
        raw: Buffer;
        toString(): string;
        toJSON(): string;
        toLegacyObject(): Record<string, unknown>;
        checkHost(name: string, options?: unknown): string | undefined;
        checkEmail(email: string, options?: unknown): string | undefined;
        checkIP(ip: string, options?: unknown): string | undefined;
        checkIssued(otherCert: unknown): boolean;
        checkPrivateKey(privateKey: unknown): boolean;
        verify(publicKey: unknown): boolean;
      };

      expect(typeof X509Certificate).toBe('function');

      const tlv = (tag: number, body: Buffer): Buffer => {
        const len = body.length;
        const hdr =
          len < 0x80
            ? [tag, len]
            : len <= 0xff
              ? [tag, 0x81, len]
              : [tag, 0x82, (len >> 8) & 0xff, len & 0xff];
        return Buffer.concat([Buffer.from(hdr), body]);
      };
      const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
      const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
      const oid = (hex: string) => tlv(0x06, Buffer.from(hex, 'hex'));
      const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
      const prn = (s: string) => tlv(0x13, Buffer.from(s, 'ascii'));
      const utc = (s: string) => tlv(0x17, Buffer.from(s, 'ascii'));
      const bitstr = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), b]));
      const octstr = (b: Buffer) => tlv(0x04, b);
      const intBuf = (b: Buffer) =>
        tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);

      const ecPair = await new Promise<{
        publicKey: { export(o: unknown): Buffer };
        privateKey: unknown;
      }>((res, rej) =>
        crypto.generateKeyPair(
          'ec',
          { namedCurve: 'prime256v1' },
          (e: Error | null, pub: unknown, priv: unknown) =>
            e
              ? rej(e)
              : res({
                  publicKey: pub as { export(o: unknown): Buffer },
                  privateKey: priv,
                }),
        ),
      );
      const spki = ecPair.publicKey.export({ type: 'spki', format: 'der' });

      const rdn = (oidHex: string, valNode: Buffer) => set(seq(oid(oidHex), valNode));
      const name = seq(
        rdn('550406', prn('US')),
        rdn('55040a', utf8('Example, Org')),
        rdn('550403', utf8('*.example.com')),
      );
      const extBc = seq(
        oid('551d13'),
        tlv(0x01, Buffer.from([0xff])),
        octstr(seq(tlv(0x01, Buffer.from([0xff])))),
      );
      const sanBody = seq(
        tlv(0x82, Buffer.from('*.example.com', 'ascii')),
        tlv(0x82, Buffer.from('example.com', 'ascii')),
        tlv(0x81, Buffer.from('ops@example.com', 'ascii')),
        tlv(0x87, Buffer.from([127, 0, 0, 1])),
        tlv(0x87, Buffer.from('00000000000000000000000000000001', 'hex')),
        tlv(0x86, Buffer.from('https://example.com/id', 'ascii')),
      );
      const extSan = seq(oid('551d11'), octstr(sanBody));
      const extEku = seq(
        oid('551d25'),
        octstr(seq(oid('2b06010505070301'), oid('2b06010505070302'))),
      );
      const extAia = seq(
        oid('2b06010505070101'),
        octstr(
          seq(
            seq(
              oid('2b06010505073001'),
              tlv(0x86, Buffer.from('http://ocsp.example.com', 'ascii')),
            ),
            seq(
              oid('2b06010505073002'),
              tlv(0x86, Buffer.from('http://ca.example.com/cert.crt', 'ascii')),
            ),
          ),
        ),
      );
      const sigAlg = seq(oid('2a8648ce3d040302'));
      const tbs = seq(
        tlv(0xa0, intBuf(Buffer.from([2]))),
        intBuf(Buffer.from('01ab03', 'hex')),
        sigAlg,
        name,
        seq(utc('250102030405Z'), utc('351215141516Z')),
        name,
        spki,
        tlv(0xa3, seq(extBc, extSan, extEku, extAia)),
      );
      const createSign = Reflect.get(crypto, 'createSign') as (alg: string) => {
        update(b: Buffer): { sign(k: unknown): Buffer };
      };
      const sig = createSign('SHA256').update(tbs).sign(ecPair.privateKey);
      const certDer = seq(tbs, sigAlg, bitstr(sig));

      const cert = new X509Certificate(certDer);
      expect(cert.subject).toBe('C=US\nO=Example\\, Org\nCN=*.example.com');
      expect(cert.issuer).toBe('C=US\nO=Example\\, Org\nCN=*.example.com');
      expect(cert.subjectAltName).toBe(
        'DNS:*.example.com, DNS:example.com, email:ops@example.com, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, URI:https://example.com/id',
      );
      expect(cert.infoAccess).toBe(
        'OCSP - URI:http://ocsp.example.com\nCA Issuers - URI:http://ca.example.com/cert.crt',
      );
      expect(cert.validFrom).toBe('Jan  2 03:04:05 2025 GMT');
      expect(cert.validTo).toBe('Dec 15 14:15:16 2035 GMT');
      expect(cert.validFromDate.toISOString()).toBe('2025-01-02T03:04:05.000Z');
      expect(cert.validToDate.toISOString()).toBe('2035-12-15T14:15:16.000Z');
      expect(cert.serialNumber).toBe('01AB03');
      expect(cert.fingerprint.length).toBe(59);
      expect(cert.fingerprint256.length).toBe(95);
      expect(cert.fingerprint512.length).toBe(191);
      expect(cert.ca).toBe(true);
      expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']);
      expect(cert.issuerCertificate).toBeUndefined();
      expect(cert.publicKey.equals(ecPair.publicKey)).toBe(true);
      expect(cert.raw.equals(certDer)).toBe(true);
      expect(cert.toJSON()).toBe(cert.toString());
      expect(cert.toString().startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);

      // PEM constructor round-trip
      const certFromPem = new X509Certificate(cert.toString());
      expect(certFromPem.fingerprint256).toBe(cert.fingerprint256);

      // Identity & key verification checks
      expect(cert.checkHost('api.example.com')).toBe('*.example.com');
      expect(cert.checkHost('example.com')).toBe('example.com');
      expect(cert.checkHost('other.org')).toBeUndefined();
      expect(cert.checkEmail('ops@example.com')).toBe('ops@example.com');
      expect(cert.checkEmail('nope@example.com')).toBeUndefined();
      expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1');
      expect(cert.checkIP('::1')).toBe('::1');
      expect(cert.checkIP('10.0.0.1')).toBeUndefined();
      expect(cert.checkIssued(certFromPem)).toBe(true);
      expect(cert.checkPrivateKey(ecPair.privateKey)).toBe(true);
      expect(cert.verify(ecPair.publicKey)).toBe(true);

      const legacy = cert.toLegacyObject();
      expect(Object.getPrototypeOf(legacy)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(legacy.subject)).toBeNull();
      expect(legacy.serialNumber).toBe('01AB03');
      expect(legacy.ca).toBe(true);
      expect(legacy.subject).toEqual({ C: 'US', O: 'Example, Org', CN: '*.example.com' });
    });

    it('implements legacy SPKAC Certificate static and prototype methods (verifySpkac, exportPublicKey, exportChallenge)', async () => {
      const crypto = makeCrypto();
      const { Certificate } = crypto;

      expect(typeof Certificate).toBe('function');
      expect(typeof Certificate.verifySpkac).toBe('function');
      expect(typeof Certificate.exportPublicKey).toBe('function');
      expect(typeof Certificate.exportChallenge).toBe('function');

      const tlv = (tag: number, body: Buffer): Buffer => {
        const len = body.length;
        const hdr =
          len < 0x80
            ? [tag, len]
            : len <= 0xff
              ? [tag, 0x81, len]
              : [tag, 0x82, (len >> 8) & 0xff, len & 0xff];
        return Buffer.concat([Buffer.from(hdr), body]);
      };
      const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
      const oid = (hex: string) => tlv(0x06, Buffer.from(hex, 'hex'));
      const ia5 = (s: string) => tlv(0x16, Buffer.from(s, 'ascii'));
      const bitstr = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), b]));

      const ecPair = await new Promise<{
        publicKey: { export(o: unknown): Buffer };
        privateKey: unknown;
      }>((res, rej) =>
        crypto.generateKeyPair(
          'ec',
          { namedCurve: 'prime256v1' },
          (e: Error | null, pub: unknown, priv: unknown) =>
            e
              ? rej(e)
              : res({
                  publicKey: pub as { export(o: unknown): Buffer },
                  privateKey: priv,
                }),
        ),
      );
      const spki = ecPair.publicKey.export({ type: 'spki', format: 'der' });
      const spkacInner = seq(spki, ia5('spkac-secret-challenge'));
      const createSign = Reflect.get(crypto, 'createSign') as (alg: string) => {
        update(b: Buffer): { sign(k: unknown): Buffer };
      };
      const sig = createSign('SHA256').update(spkacInner).sign(ecPair.privateKey);
      const sigAlg = seq(oid('2a8648ce3d040302'));
      const spkacDer = seq(spkacInner, sigAlg, bitstr(sig));
      const spkacB64Buf = Buffer.from(spkacDer.toString('base64'), 'ascii');

      expect(Certificate.verifySpkac(spkacB64Buf)).toBe(true);
      expect(Certificate.exportChallenge(spkacB64Buf).toString('utf8')).toBe(
        'spkac-secret-challenge',
      );
      const exportedPem = Certificate.exportPublicKey(spkacB64Buf).toString('utf8');
      expect(exportedPem.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true);
      expect(crypto.createPublicKey(exportedPem).equals(ecPair.publicKey)).toBe(true);

      const inst = callUntyped(Certificate) as InstanceType<typeof Certificate>;
      expect(inst.verifySpkac(spkacB64Buf)).toBe(true);
      expect(inst.verifySpkac(Buffer.from('invalid-spkac'))).toBe(false);
      expect(inst.exportChallenge(Buffer.from('invalid-spkac'))).toEqual(Buffer.alloc(0));
    });
  });
});
