import { describe, expect, it } from 'vitest';
import { HeadInjector } from '../../src/preview-inject';

const SCRIPT = '<script src="/preview-socket.js"></script>';
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (parts: Uint8Array[]) =>
  parts.map((part) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(part)).join('');

describe('HeadInjector', () => {
  it('injects directly after the head start tag', () => {
    const injector = new HeadInjector(SCRIPT);
    expect(text(injector.write(bytes('<!doctype html><html><head><title>x</title>')))).toBe(
      '<!doctype html><html><head>' + SCRIPT + '<title>x</title>',
    );
    expect(text(injector.end())).toBe('');
  });

  it('accepts attributes and any letter case on the head tag', () => {
    const injector = new HeadInjector(SCRIPT);
    expect(text(injector.write(bytes('<HTML><HEAD data-a="1">rest')))).toBe(
      '<HTML><HEAD data-a="1">' + SCRIPT + 'rest',
    );
  });

  it('holds an undecided prefix across writes until the head tag completes', () => {
    const injector = new HeadInjector(SCRIPT);
    expect(injector.write(bytes('<!doctype html>\n<html lang="en">\n<he'))).toEqual([]);
    expect(injector.held).toBe(36);
    expect(text(injector.write(bytes('ad><meta charset="utf-8">')))).toBe(
      '<!doctype html>\n<html lang="en">\n<head>' + SCRIPT + '<meta charset="utf-8">',
    );
    expect(injector.held).toBe(0);
  });

  it('skips comments, including ones containing ">", before the head tag', () => {
    const injector = new HeadInjector(SCRIPT);
    expect(injector.write(bytes('<!-- a > b '))).toEqual([]);
    expect(text(injector.write(bytes('--><html><head>x')))).toBe(
      '<!-- a > b --><html><head>' + SCRIPT + 'x',
    );
  });

  it('falls back to after the doctype as soon as body content rules a head tag out', () => {
    const injector = new HeadInjector(SCRIPT);
    expect(text(injector.write(bytes('<!doctype html><p>one</p>')))).toBe(
      '<!doctype html>' + SCRIPT + '<p>one</p>',
    );
  });

  it('falls back to the start when there is neither a doctype nor a head tag', () => {
    const injector = new HeadInjector(SCRIPT);
    expect(text(injector.write(bytes('<p>hello')))).toBe(SCRIPT + '<p>hello');
    const header = new HeadInjector(SCRIPT);
    expect(header.write(bytes('<hea'))).toEqual([]);
    expect(text(header.write(bytes('der>x</header>')))).toBe(SCRIPT + '<header>x</header>');
    const plain = new HeadInjector(SCRIPT);
    expect(text(plain.write(bytes('just text')))).toBe(SCRIPT + 'just text');
  });

  it('still finds a head tag later in the bytes it has already been given', () => {
    const injector = new HeadInjector(SCRIPT);
    expect(text(injector.write(bytes('<p>early</p><head>late')))).toBe(
      '<p>early</p><head>' + SCRIPT + 'late',
    );
  });

  it('flushes an undecided prefix at the end of the stream', () => {
    const injector = new HeadInjector(SCRIPT);
    expect(injector.write(bytes('<!doctype html>'))).toEqual([]);
    expect(text(injector.end())).toBe('<!doctype html>' + SCRIPT);
    const empty = new HeadInjector(SCRIPT);
    expect(text(empty.end())).toBe(SCRIPT);
  });

  it('stops holding at its bound and falls back', () => {
    const injector = new HeadInjector(SCRIPT, 1024);
    expect(injector.write(bytes(' '.repeat(1000)))).toEqual([]);
    expect(injector.held).toBe(1000);
    expect(text(injector.write(bytes(' '.repeat(100))))).toBe(SCRIPT + ' '.repeat(1100));
    expect(injector.held).toBe(0);
  });

  it('passes later writes through untouched once decided', () => {
    const injector = new HeadInjector(SCRIPT);
    injector.write(bytes('<head>'));
    const later = bytes('<head>again');
    const output = injector.write(later);
    expect(output).toHaveLength(1);
    expect(output[0]).toBe(later);
    expect(injector.end()).toEqual([]);
  });

  it('preserves non-ASCII bytes exactly, including a split multi-byte character', () => {
    const injector = new HeadInjector(SCRIPT);
    const document = bytes('<html><head><title>é漢字</title>');
    const split = document.length - 12;
    const output = [
      ...injector.write(document.subarray(0, split)),
      ...injector.write(document.subarray(split)),
    ];
    const joined = new Uint8Array(output.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of output) {
      joined.set(part, offset);
      offset += part.length;
    }
    expect(new TextDecoder().decode(joined)).toBe('<html><head>' + SCRIPT + '<title>é漢字</title>');
  });

  it('keeps a UTF-8 byte order mark in front of a start-of-document fallback', () => {
    const injector = new HeadInjector(SCRIPT);
    const output = injector.write(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('<p>x')]));
    expect(Array.from(output[0].subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(text(output).replace('﻿', '')).toBe(SCRIPT + '<p>x');
  });
});
