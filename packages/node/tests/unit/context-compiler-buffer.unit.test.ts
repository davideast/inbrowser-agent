import { describe, expect, it } from 'vitest';
import {
  HEADER_BYTES,
  INITIAL_REPLY_BYTES,
  createReplyBuffer,
  describeBytes,
  isReplyBuffer,
  replyTooLarge,
  reserveReply,
  sourceTooLarge,
} from '../../src/context-compiler-buffer';
import { LimitError } from '../../src/errors';

const MiB = 1024 * 1024;

describe('context compiler reply buffer', () => {
  it('starts at one MiB of reply capacity and reserves the policy bound as its maximum', () => {
    const shared = createReplyBuffer(128 * MiB);
    expect(shared.growable).toBe(true);
    expect(shared.byteLength).toBe(HEADER_BYTES + INITIAL_REPLY_BYTES);
    expect(shared.maxByteLength).toBe(HEADER_BYTES + 128 * MiB);
    expect(isReplyBuffer(shared, 128 * MiB)).toBe(true);
    expect(isReplyBuffer(shared, 64 * MiB)).toBe(false);
    expect(isReplyBuffer(new SharedArrayBuffer(16), 8)).toBe(false);
  });

  it('starts at the bound when the bound is below one MiB', () => {
    expect(createReplyBuffer(4096).byteLength).toBe(HEADER_BYTES + 4096);
  });

  it('grows to a whole MiB of buffer, never past the maximum, and leaves existing bytes in place', () => {
    const shared = createReplyBuffer(8 * MiB);
    const early = new Uint8Array(shared, HEADER_BYTES, 4);
    early.set([1, 2, 3, 4]);
    reserveReply(shared, 100);
    expect(shared.byteLength).toBe(HEADER_BYTES + INITIAL_REPLY_BYTES);
    reserveReply(shared, INITIAL_REPLY_BYTES + 1);
    expect(shared.byteLength).toBe(2 * MiB);
    // A view made after growth reaches the grown length; the early bytes survive.
    const grown = new Uint8Array(shared, HEADER_BYTES, INITIAL_REPLY_BYTES + 1);
    expect(grown.length).toBe(INITIAL_REPLY_BYTES + 1);
    expect([...grown.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
    reserveReply(shared, 8 * MiB);
    expect(shared.byteLength).toBe(shared.maxByteLength);
  });

  it('lets a view without a length track the growth', () => {
    const shared = createReplyBuffer(8 * MiB);
    const tracking = new Uint8Array(shared, HEADER_BYTES);
    expect(tracking.length).toBe(INITIAL_REPLY_BYTES);
    reserveReply(shared, 3 * MiB);
    expect(tracking.length).toBe(4 * MiB - HEADER_BYTES);
  });
});

describe('context compiler limit errors', () => {
  it('names the policy value in the message and carries limit and actual', () => {
    const source = sourceTooLarge(32 * MiB, 33 * MiB + 5);
    expect(source).toBeInstanceOf(LimitError);
    expect(source).toMatchObject({
      code: 'E2BIG',
      kind: 'limit',
      message: 'Context compiler source exceeds 32 MiB',
      limit: 32 * MiB,
      actual: 33 * MiB + 5,
    });
    const reply = replyTooLarge(64 * 1024, 70000);
    expect(reply).toBeInstanceOf(LimitError);
    expect(reply).toMatchObject({
      code: 'E2BIG',
      kind: 'limit',
      message: 'Compiled context source exceeds 64 KiB',
      limit: 65536,
      actual: 70000,
    });
  });

  it('describes sizes the way the earlier fixed message did', () => {
    expect(describeBytes(8 * MiB)).toBe('8 MiB');
    expect(describeBytes(64 * 1024)).toBe('64 KiB');
    expect(describeBytes(1000)).toBe('1000 bytes');
  });
});
