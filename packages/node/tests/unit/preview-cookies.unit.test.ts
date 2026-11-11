import { describe, expect, it } from 'vitest';
import {
  PREVIEW_COOKIE_LIMITS,
  PreviewCookieJar,
  pageCookieHeader,
  parseCookieDate,
  parseSetCookie,
} from '../../src/preview-cookies';

const ORIGIN = 'http://c-1-3000.localhost:6505';
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const same = (path: string) => ({ path, crossSite: false, navigation: false, method: 'GET' });

function jar(origin = ORIGIN) {
  return new PreviewCookieJar(origin);
}

describe('parseSetCookie', () => {
  it('reads the name-value pair and every attribute, case-insensitively', () => {
    expect(
      parseSetCookie(
        ' sid = abc ; Path=/app; DOMAIN=.Example.COM; Max-Age=60; Expires=Wed, 21 Oct 2026 07:28:00 GMT; secure; HttpOnly; SameSite=Strict',
      ),
    ).toEqual({
      name: 'sid',
      value: 'abc',
      path: '/app',
      domain: 'example.com',
      maxAge: 60,
      expires: Date.UTC(2026, 9, 21, 7, 28, 0),
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
    });
  });

  it('treats a pair without "=" as a nameless cookie, as RFC 6265bis does', () => {
    expect(parseSetCookie('token')).toMatchObject({ name: '', value: 'token' });
    expect(parseSetCookie('=')).toBeUndefined();
    expect(parseSetCookie('')).toBeUndefined();
  });

  it('ignores a cookie with control characters or an oversized pair', () => {
    expect(parseSetCookie('a=b\u0001c')).toBeUndefined();
    expect(parseSetCookie('a\u007f=b')).toBeUndefined();
    expect(parseSetCookie('a=' + 'x'.repeat(PREVIEW_COOKIE_LIMITS.pairBytes))).toBeUndefined();
    expect(parseSetCookie('a=' + 'x'.repeat(PREVIEW_COOKIE_LIMITS.pairBytes - 1))).toMatchObject({
      name: 'a',
    });
  });

  it('ignores unusable attribute values', () => {
    const parsed = parseSetCookie(
      'a=b; Max-Age=1e3; Expires=not a date; Path=relative; Domain=; SameSite=bogus; Path=' +
        '/' +
        'x'.repeat(PREVIEW_COOKIE_LIMITS.attributeBytes),
    );
    expect(parsed).toEqual({
      name: 'a',
      value: 'b',
      secure: false,
      httpOnly: false,
      sameSite: 'default',
    });
  });

  it('keeps the last occurrence of a repeated attribute', () => {
    expect(parseSetCookie('a=b; Path=/one; Path=/two')).toMatchObject({ path: '/two' });
  });
});

describe('parseCookieDate (RFC 6265 section 5.1.1)', () => {
  it('reads the formats servers send', () => {
    const expected = Date.UTC(2026, 9, 21, 7, 28, 0);
    expect(parseCookieDate('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(expected);
    expect(parseCookieDate('Wednesday, 21-Oct-26 07:28:00 GMT')).toBe(expected);
    expect(parseCookieDate('Wed Oct 21 07:28:00 2026')).toBe(expected);
    expect(parseCookieDate('Thu, 01 Jan 1970 00:00:00 GMT')).toBe(0);
    expect(parseCookieDate('21 Oct 69 07:28:00')).toBe(Date.UTC(2069, 9, 21, 7, 28, 0));
    expect(parseCookieDate('21 Oct 70 07:28:00')).toBe(Date.UTC(1970, 9, 21, 7, 28, 0));
  });

  it('rejects incomplete or impossible dates', () => {
    expect(parseCookieDate('21 Oct 2026')).toBeUndefined();
    expect(parseCookieDate('31 Feb 2026 00:00:00')).toBeUndefined();
    expect(parseCookieDate('21 Oct 1600 00:00:00')).toBeUndefined();
    expect(parseCookieDate('21 Oct 2026 24:00:00')).toBeUndefined();
  });
});

describe('PreviewCookieJar', () => {
  it('stores a cookie and sends it on a later request, mirroring only script-visible ones', () => {
    const cookies = jar();
    const mirror = cookies.store(['sid=abc; HttpOnly; Path=/', 'theme=dark; Path=/'], '/login', T0);
    expect(mirror).toEqual([
      { op: 'set', name: 'theme', value: 'dark', path: '/', expires: null, sameSite: 'lax' },
    ]);
    expect(cookies.header(same('/dashboard'), T0)).toBe('sid=abc; theme=dark');
  });

  it('defaults the path to the request directory and path-matches (section 5.1.4)', () => {
    const cookies = jar();
    cookies.store(['a=1'], '/docs/guide/page', T0);
    cookies.store(['b=2'], '/top', T0);
    expect(cookies.header(same('/docs/guide'), T0)).toBe('a=1; b=2');
    expect(cookies.header(same('/docs/guide/x'), T0)).toBe('a=1; b=2');
    expect(cookies.header(same('/docs/guidebook'), T0)).toBe('b=2');
    expect(cookies.header(same('/docs'), T0)).toBe('b=2');
    cookies.store(['c=3; Path=/docs/'], '/', T0);
    expect(cookies.header(same('/docs/'), T0)).toBe('c=3; b=2');
    expect(cookies.header(same('/docs'), T0)).toBe('b=2');
  });

  it('orders longer paths first, then earlier creation, and keeps creation on replace', () => {
    const cookies = jar();
    cookies.store(['first=1'], '/', T0);
    cookies.store(['second=2'], '/', T0 + 1);
    cookies.store(['deep=3; Path=/a'], '/', T0 + 2);
    cookies.store(['first=updated'], '/', T0 + 3);
    expect(cookies.header(same('/a/b'), T0 + 4)).toBe('deep=3; first=updated; second=2');
  });

  it('keeps cookies with the same name and different paths apart', () => {
    const cookies = jar();
    cookies.store(['n=root; Path=/', 'n=area; Path=/area'], '/', T0);
    expect(cookies.header(same('/area/x'), T0)).toBe('n=area; n=root');
    expect(cookies.header(same('/other'), T0)).toBe('n=root');
  });

  it('expires by Max-Age before Expires, and deletes on a past date or non-positive Max-Age', () => {
    const cookies = jar();
    const future = 'Wed, 21 Oct 2099 07:28:00 GMT';
    expect(cookies.store(['m=1; Max-Age=2; Expires=' + future], '/', T0)).toEqual([
      { op: 'set', name: 'm', value: '1', path: '/', expires: T0 + 2000, sameSite: 'lax' },
    ]);
    cookies.store(['e=1; Expires=' + future], '/', T0);
    expect(cookies.header(same('/'), T0 + 1999)).toBe('m=1; e=1');
    expect(cookies.header(same('/'), T0 + 2000)).toBe('e=1');
    expect(cookies.store(['e=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], '/', T0)).toEqual([
      { op: 'delete', name: 'e', path: '/' },
    ]);
    cookies.store(['z=1'], '/', T0);
    expect(cookies.store(['z=1; Max-Age=0'], '/', T0)).toEqual([
      { op: 'delete', name: 'z', path: '/' },
    ]);
    expect(cookies.store(['y=1; Max-Age=-5'], '/', T0)).toEqual([]);
    expect(cookies.header(same('/'), T0 + 2000)).toBeUndefined();
  });

  it('does not mirror a deletion of an HttpOnly cookie, and deletes the mirror when one becomes HttpOnly', () => {
    const cookies = jar();
    cookies.store(['h=1; HttpOnly'], '/', T0);
    expect(cookies.store(['h=; Max-Age=0'], '/', T0)).toEqual([]);
    cookies.store(['v=1'], '/', T0);
    expect(cookies.store(['v=2; HttpOnly'], '/', T0)).toEqual([
      { op: 'delete', name: 'v', path: '/' },
    ]);
    expect(cookies.header(same('/'), T0)).toBe('v=2');
  });

  it('accepts a Domain only when the preview host domain-matches it, and keeps the cookie host-only', () => {
    const cookies = jar();
    cookies.store(['own=1; Domain=c-1-3000.localhost'], '/', T0);
    cookies.store(['parent=1; Domain=.localhost'], '/', T0);
    cookies.store(['foreign=1; Domain=example.com'], '/', T0);
    cookies.store(['suffix=1; Domain=1-3000.localhost'], '/', T0);
    expect(cookies.header(same('/'), T0)).toBe('own=1; parent=1');
    expect(jar('http://127.0.0.1:6505').store(['ip=1; Domain=0.0.1'], '/', T0)).toEqual([]);
  });

  it('accepts Secure on a potentially trustworthy origin only (localhost counts)', () => {
    const local = jar();
    local.store(['s=1; Secure'], '/', T0);
    expect(local.header(same('/'), T0)).toBe('s=1');
    const plain = jar('http://preview.example.test');
    plain.store(['s=1; Secure', 'p=1'], '/', T0);
    expect(plain.header(same('/'), T0)).toBe('p=1');
    const secure = jar('https://c-1-3000.preview.example.com');
    secure.store(['s=1; Secure'], '/', T0);
    expect(secure.header(same('/'), T0)).toBe('s=1');
  });

  it('enforces the __Secure- and __Host- prefixes', () => {
    const cookies = jar();
    cookies.store(
      [
        '__Secure-a=1',
        '__Secure-b=1; Secure',
        '__Host-c=1; Secure; Path=/',
        '__Host-d=1; Secure; Path=/x',
        '__Host-e=1; Secure; Path=/; Domain=c-1-3000.localhost',
        '__Host-f=1; Path=/',
      ],
      '/',
      T0,
    );
    expect(cookies.header(same('/x'), T0)).toBe('__Secure-b=1; __Host-c=1');
  });

  it('rejects SameSite=None without Secure, and applies SameSite to cross-site requests', () => {
    const cookies = jar();
    cookies.store(
      [
        'insecure-none=1; SameSite=None',
        'none=1; SameSite=None; Secure',
        'lax=1; SameSite=Lax',
        'default=1',
        'strict=1; SameSite=Strict',
      ],
      '/',
      T0,
    );
    const all = 'none=1; lax=1; default=1; strict=1';
    expect(cookies.header(same('/'), T0)).toBe(all);
    expect(
      cookies.header({ path: '/', crossSite: true, navigation: true, method: 'GET' }, T0),
    ).toBe('none=1; lax=1; default=1');
    expect(
      cookies.header({ path: '/', crossSite: true, navigation: true, method: 'POST' }, T0),
    ).toBe('none=1');
    expect(
      cookies.header({ path: '/', crossSite: true, navigation: false, method: 'GET' }, T0),
    ).toBe('none=1');
  });

  it('mirrors SameSite as the Cookie Store API names it', () => {
    const cookies = jar();
    expect(
      cookies.store(['a=1; SameSite=Strict', 'b=1; SameSite=None; Secure', 'c=1'], '/', T0),
    ).toEqual([
      { op: 'set', name: 'a', value: '1', path: '/', expires: null, sameSite: 'strict' },
      { op: 'set', name: 'b', value: '1', path: '/', expires: null, sameSite: 'none' },
      { op: 'set', name: 'c', value: '1', path: '/', expires: null, sameSite: 'lax' },
    ]);
  });

  it('does not mirror a nameless cookie but sends it', () => {
    const cookies = jar();
    expect(cookies.store(['bare'], '/', T0)).toEqual([]);
    expect(cookies.header(same('/'), T0)).toBe('bare');
  });

  it('evicts the least recently used cookie past the count limit', () => {
    const cookies = jar();
    cookies.store(['c0=1'], '/', T0);
    for (let index = 1; index < PREVIEW_COOKIE_LIMITS.cookies; index++)
      cookies.store([`c${index}=1; Path=/other`], '/', T0 + index);
    // A request to "/" reads, and so refreshes, c0 only: c1 is now least recently used.
    expect(cookies.header(same('/'), T0 + 1000)).toBe('c0=1');
    cookies.store(['new=1'], '/', T0 + 1001);
    const kept = cookies.header(same('/other'), T0 + 1002)!.split('; ');
    expect(kept).toHaveLength(PREVIEW_COOKIE_LIMITS.cookies);
    expect(kept).toContain('c0=1');
    expect(kept).toContain('new=1');
    expect(kept).toContain('c2=1');
    expect(kept).not.toContain('c1=1');
  });

  it('merges cookies page script wrote, letting the jar win for names it holds', () => {
    const cookies = jar();
    cookies.store(['sid=server; HttpOnly', 'theme=dark'], '/', T0);
    expect(
      cookies.cookieHeader(same('/'), 'theme=light; client=1; sid=forged; =odd; bare', T0),
    ).toBe('sid=server; theme=dark; client=1; bare');
    expect(cookies.cookieHeader(same('/'), undefined, T0)).toBe('sid=server; theme=dark');
    expect(jar().cookieHeader(same('/'), 'client=1', T0)).toBe('client=1');
    expect(jar().cookieHeader(same('/'), '', T0)).toBeUndefined();
  });

  it('bounds what it takes from page script', () => {
    const page = Array.from({ length: 400 }, (_, index) => `p${index}=${'v'.repeat(40)}`).join(
      '; ',
    );
    const header = jar().cookieHeader(same('/'), page, T0)!;
    expect(new TextEncoder().encode(header).length).toBeLessThanOrEqual(
      PREVIEW_COOKIE_LIMITS.pageHeaderBytes,
    );
    expect(header.startsWith('p0=')).toBe(true);
  });
});

describe('pageCookieHeader', () => {
  // Items as Chromium's cookieStore.getAll() returns them (CookieListItem).
  const items = [
    { name: 'pstrict', value: '1', path: '/', sameSite: 'strict' },
    { name: 'plax', value: '1', path: '/', sameSite: 'lax' },
    { name: 'pnone', value: '1', path: '/', sameSite: 'none', secure: true },
  ];
  const context = (crossSite: boolean, navigation: boolean, method = 'GET', path = '/x') => ({
    path,
    crossSite,
    navigation,
    method,
  });

  it('path-matches each item against the request path', () => {
    const scoped = [
      { name: 'root', value: '1', path: '/', sameSite: 'lax' },
      { name: 'area', value: '1', path: '/area', sameSite: 'lax' },
      { name: 'nopath', value: '1', sameSite: 'lax' },
    ];
    expect(pageCookieHeader(scoped, context(false, false, 'GET', '/echo'))).toBe(
      'root=1; nopath=1',
    );
    expect(pageCookieHeader(scoped, context(false, false, 'GET', '/areas'))).toBe(
      'root=1; nopath=1',
    );
    expect(pageCookieHeader(scoped, context(false, false, 'GET', '/area/echo'))).toBe(
      'root=1; area=1; nopath=1',
    );
  });

  it('sends every page cookie on a same-site request', () => {
    expect(pageCookieHeader(items, context(false, false))).toBe('pstrict=1; plax=1; pnone=1');
    expect(pageCookieHeader(items, context(false, true, 'POST'))).toBe(
      'pstrict=1; plax=1; pnone=1',
    );
  });

  it('applies SameSite to a cross-site request as the jar does', () => {
    expect(pageCookieHeader(items, context(true, true))).toBe('plax=1; pnone=1');
    expect(pageCookieHeader(items, context(true, true, 'POST'))).toBe('pnone=1');
    expect(pageCookieHeader(items, context(true, false))).toBe('pnone=1');
    expect(pageCookieHeader([items[0]], context(true, true))).toBeUndefined();
  });

  it('treats an item without a known SameSite as Strict, and skips malformed items', () => {
    const odd: unknown[] = [
      { name: 'unknown', value: '1' },
      { name: 'bogus', value: '1', sameSite: 'sometimes' },
      { name: 'numeric', value: 2, sameSite: 'none' },
      'not-an-item',
      null,
      { name: '', value: 'bare', sameSite: 'none' },
      { name: 'ctl', value: 'a\u0001b', sameSite: 'none' },
    ];
    expect(pageCookieHeader(odd, context(false, false))).toBe('unknown=1; bogus=1; bare');
    expect(pageCookieHeader(odd, context(true, true))).toBe('bare');
  });
});
