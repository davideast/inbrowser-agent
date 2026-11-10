// The runtime cookie jar of one per-origin preview (design §7.2 "Cookie layer",
// decision 4). A worker-built Response cannot carry Set-Cookie and a fetch event
// never shows Cookie (design §3.6), so the browser's own jar never sees a guest
// cookie. This jar is the source of truth instead: the host keeps one per
// container and preview origin, applies every guest Set-Cookie to it, and adds
// the matching Cookie header to every request that preview sends the guest.
//
// Pure: no DOM, Worker or memfs, so the Node unit tier covers it. It follows
// RFC 6265 (section 5) with the RFC 6265bis changes browsers ship:
//   - parsing (5.2): nameless cookies, control characters, 4096-byte pair and
//     1024-byte attribute bounds, Max-Age over Expires, the cookie-date algorithm;
//   - storage (5.3): Domain must domain-match the preview host and the cookie
//     stays host-only (the jar serves one origin); Secure only from a
//     potentially trustworthy origin, which includes http://localhost and
//     *.localhost as in Chromium; __Secure- and __Host- prefixes; SameSite=None
//     requires Secure; a missing SameSite is Lax ("Lax by default");
//   - retrieval (5.4): path-match, expiry, longest path first then earliest
//     creation, last-access refresh; SameSite against the request's context.
// Not modelled: the public suffix list (a Domain naming a suffix of the preview
// host is accepted, and still host-only), Partitioned, and the Lax+POST grace.

export const PREVIEW_COOKIE_LIMITS = Object.freeze({
  /** Cookies per preview origin; the least recently used is evicted beyond it (Chromium: 180). */
  cookies: 180,
  /** Name plus value, in bytes; a longer cookie is ignored (RFC 6265bis). */
  pairBytes: 4096,
  /** One attribute value, in bytes; a longer attribute is ignored (RFC 6265bis). */
  attributeBytes: 1024,
  /** Bytes taken from cookies page script wrote (through the Cookie Store mirror). */
  pageHeaderBytes: 8192,
});

export type CookieSameSite = 'strict' | 'lax' | 'none' | 'default';

export interface ParsedCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
}

/** One change to replay into the page-visible store (Cookie Store API). */
export type CookieMirrorOp =
  | {
      op: 'set';
      name: string;
      value: string;
      path: string;
      /** Epoch milliseconds, or null for a session cookie. */
      expires: number | null;
      sameSite: 'strict' | 'lax' | 'none';
    }
  | { op: 'delete'; name: string; path: string };

/** The context of one request, as the preview worker observed it. */
export interface CookieRequest {
  /** The request path, without query. */
  path: string;
  /**
   * True for a navigation into the preview started by another origin, or with
   * no referrer. Origin stands in for site: a same-site, cross-origin initiator
   * (the host page or a sibling preview on a parent domain) counts as cross-site.
   */
  crossSite: boolean;
  /** True for a document navigation. */
  navigation: boolean;
  method: string;
}

interface StoredCookie {
  name: string;
  value: string;
  path: string;
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
  created: number;
  lastAccess: number;
  /** Insertion order, which breaks ties between equal creation times. */
  order: number;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
// RFC 6265bis: a cookie whose name or value has a control character other than HTAB is ignored.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** RFC 6265 section 5.1.1: epoch milliseconds, or undefined when the date is unusable. */
export function parseCookieDate(text: string): number | undefined {
  let time: [number, number, number] | undefined;
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  // Delimiters: %x09 / %x20-2F / %x3B-40 / %x5B-60 / %x7B-7E.
  for (const token of text.split(/[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/)) {
    if (!token) continue;
    const clock = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[^\d]|$)/.exec(token);
    if (!time && clock) {
      time = [Number(clock[1]), Number(clock[2]), Number(clock[3])];
      continue;
    }
    const dayMatch = /^(\d{1,2})(?:[^\d]|$)/.exec(token);
    if (day === undefined && dayMatch) {
      day = Number(dayMatch[1]);
      continue;
    }
    const monthIndex = MONTHS.indexOf(token.slice(0, 3).toLowerCase());
    if (month === undefined && monthIndex >= 0) {
      month = monthIndex;
      continue;
    }
    const yearMatch = /^(\d{2,4})(?:[^\d]|$)/.exec(token);
    if (year === undefined && yearMatch) {
      year = Number(yearMatch[1]);
    }
  }
  if (year !== undefined && year >= 70 && year <= 99) year += 1900;
  if (year !== undefined && year >= 0 && year <= 69) year += 2000;
  if (
    !time ||
    day === undefined ||
    month === undefined ||
    year === undefined ||
    day < 1 ||
    day > 31 ||
    year < 1601 ||
    time[0] > 23 ||
    time[1] > 59 ||
    time[2] > 59
  )
    return;
  const value = Date.UTC(year, month, day, time[0], time[1], time[2]);
  // Date.UTC rolls 31 Feb over into March; the algorithm calls that a failure.
  if (new Date(value).getUTCDate() !== day) return;
  return value;
}

/** RFC 6265 section 5.2 with the 6265bis bounds; undefined when the cookie is ignored. */
export function parseSetCookie(header: string): ParsedCookie | undefined {
  const [pair, ...attributes] = header.split(';');
  const equals = pair.indexOf('=');
  const name = (equals < 0 ? '' : pair.slice(0, equals)).trim();
  const value = (equals < 0 ? pair : pair.slice(equals + 1)).trim();
  if (!name && !value) return;
  if (CONTROL.test(name) || CONTROL.test(value)) return;
  if (bytes(name) + bytes(value) > PREVIEW_COOKIE_LIMITS.pairBytes) return;
  const cookie: ParsedCookie = {
    name,
    value,
    secure: false,
    httpOnly: false,
    sameSite: 'default',
  };
  for (const attribute of attributes) {
    const at = attribute.indexOf('=');
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const raw = at < 0 ? '' : attribute.slice(at + 1).trim();
    if (bytes(raw) > PREVIEW_COOKIE_LIMITS.attributeBytes) continue;
    if (key === 'expires') {
      const date = parseCookieDate(raw);
      if (date !== undefined) cookie.expires = date;
    } else if (key === 'max-age') {
      if (/^-?\d+$/.test(raw)) cookie.maxAge = Number(raw);
    } else if (key === 'domain') {
      const domain = raw.replace(/^\./, '').toLowerCase();
      if (domain) cookie.domain = domain;
    } else if (key === 'path') {
      if (raw.startsWith('/')) cookie.path = raw;
      else delete cookie.path;
    } else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') {
      const mode = raw.toLowerCase();
      cookie.sameSite = mode === 'strict' || mode === 'lax' || mode === 'none' ? mode : 'default';
    }
  }
  return cookie;
}

/** RFC 6265 section 5.1.4 default-path of a request path. */
function defaultPath(path: string): string {
  if (!path.startsWith('/')) return '/';
  const last = path.lastIndexOf('/');
  return last <= 0 ? '/' : path.slice(0, last);
}

/** RFC 6265 section 5.1.4 path-match. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** RFC 6265 section 5.1.3 domain-match of the preview host against a Domain attribute. */
function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return !IPV4.test(host) && !host.startsWith('[') && host.endsWith('.' + domain);
}

/** Secure contexts as Chromium treats them for cookies: https, localhost, *.localhost, loopback. */
function trustworthy(origin: URL): boolean {
  if (origin.protocol === 'https:') return true;
  const host = origin.hostname;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === '[::1]'
  );
}

/** What the Cookie Store API calls the effective SameSite of a stored cookie. */
const effectiveSameSite = (sameSite: CookieSameSite) => (sameSite === 'default' ? 'lax' : sameSite);

/** Whether a cookie with effective SameSite `mode` goes with a request in `context`. */
function sameSiteAllows(
  mode: 'strict' | 'lax' | 'none',
  context: Pick<CookieRequest, 'crossSite' | 'navigation' | 'method'>,
): boolean {
  if (!context.crossSite) return true;
  // The preview stands in for a top-level app: a cross-site navigation into it
  // is treated as a top-level one, so Lax applies to safe-method navigations.
  if (mode === 'none') return true;
  const safe = context.method === 'GET' || context.method === 'HEAD';
  return mode === 'lax' && context.navigation && safe;
}

/**
 * The Cookie header formed by cookies page script wrote, from the items the
 * preview worker's `cookieStore.getAll()` returned, filtered by path and
 * SameSite as the jar filters its own. Chromium answers a worker's `getAll()`
 * for its scope URL (`/`), so only `Path=/` cookies arrive, and it refuses a
 * `url` option naming any request path; a page cookie with a narrower Path
 * therefore never reaches the guest (docs/guide/limits.md). Items are
 * untrusted shapes: one without string name and value, or with a control
 * character, is skipped; one without a string `path` counts as `/`, the URL
 * the browser matched; one without a known `sameSite` counts as Strict.
 * Undefined when nothing is sent.
 */
export function pageCookieHeader(
  items: readonly unknown[],
  request: CookieRequest,
): string | undefined {
  const pairs: string[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const name: unknown = Reflect.get(item, 'name');
    const value: unknown = Reflect.get(item, 'value');
    const path: unknown = Reflect.get(item, 'path');
    const sameSite: unknown = Reflect.get(item, 'sameSite');
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    if (CONTROL.test(name) || CONTROL.test(value)) continue;
    if (!pathMatches(request.path, typeof path === 'string' ? path : '/')) continue;
    const mode = sameSite === 'lax' || sameSite === 'none' ? sameSite : 'strict';
    if (!sameSiteAllows(mode, request)) continue;
    pairs.push(name ? name + '=' + value : value);
  }
  return pairs.length ? pairs.join('; ') : undefined;
}

/** The cookie jar of one preview origin. */
export class PreviewCookieJar {
  private readonly host: string;
  private readonly secureOrigin: boolean;
  private cookies: StoredCookie[] = [];
  private order = 0;
  constructor(origin: string) {
    const url = new URL(origin);
    this.host = url.hostname.toLowerCase();
    this.secureOrigin = trustworthy(url);
  }

  /**
   * Applies the response's Set-Cookie values for a request to `requestPath`
   * (section 5.3) and returns the changes to mirror into the page-visible store.
   */
  store(values: readonly string[], requestPath: string, now = Date.now()): CookieMirrorOp[] {
    const mirror: CookieMirrorOp[] = [];
    for (const header of values) {
      const parsed = parseSetCookie(header);
      if (!parsed) continue;
      if (parsed.domain !== undefined && !domainMatches(this.host, parsed.domain)) continue;
      if (parsed.secure && !this.secureOrigin) continue;
      if (parsed.sameSite === 'none' && !parsed.secure) continue;
      const path = parsed.path ?? defaultPath(requestPath);
      if (parsed.name.startsWith('__Secure-') && !parsed.secure) continue;
      if (
        parsed.name.startsWith('__Host-') &&
        (!parsed.secure || parsed.domain !== undefined || parsed.path !== '/')
      )
        continue;
      const expires =
        parsed.maxAge !== undefined
          ? parsed.maxAge <= 0
            ? Number.NEGATIVE_INFINITY
            : now + parsed.maxAge * 1000
          : parsed.expires;
      const index = this.cookies.findIndex(
        (cookie) => cookie.name === parsed.name && cookie.path === path,
      );
      const previous = index >= 0 ? this.cookies[index] : undefined;
      // RFC 6265bis 5.7: a non-secure origin may not overwrite a Secure cookie.
      if (previous?.secure && !this.secureOrigin) continue;
      if (expires !== undefined && expires <= now) {
        if (previous) {
          this.cookies.splice(index, 1);
          if (!previous.httpOnly && previous.name)
            mirror.push({ op: 'delete', name: previous.name, path });
        }
        continue;
      }
      const cookie: StoredCookie = {
        name: parsed.name,
        value: parsed.value,
        path,
        ...(expires !== undefined ? { expires } : {}),
        secure: parsed.secure,
        httpOnly: parsed.httpOnly,
        sameSite: parsed.sameSite,
        created: previous?.created ?? now,
        lastAccess: now,
        order: previous?.order ?? this.order++,
      };
      if (previous) this.cookies[index] = cookie;
      else this.cookies.push(cookie);
      if (!cookie.name) continue;
      if (!cookie.httpOnly)
        mirror.push({
          op: 'set',
          name: cookie.name,
          value: cookie.value,
          path,
          expires: cookie.expires ?? null,
          sameSite: effectiveSameSite(cookie.sameSite),
        });
      else if (previous && !previous.httpOnly)
        mirror.push({ op: 'delete', name: cookie.name, path });
    }
    this.evict(now);
    return mirror;
  }

  private evict(now: number) {
    this.cookies = this.cookies.filter(
      (cookie) => cookie.expires === undefined || cookie.expires > now,
    );
    while (this.cookies.length > PREVIEW_COOKIE_LIMITS.cookies) {
      let oldest = 0;
      for (let index = 1; index < this.cookies.length; index++)
        if (this.cookies[index].lastAccess < this.cookies[oldest].lastAccess) oldest = index;
      this.cookies.splice(oldest, 1);
    }
  }

  /** The jar's Cookie header for one request (section 5.4), or undefined when none match. */
  header(request: CookieRequest, now = Date.now()): string | undefined {
    const pairs = this.matching(request, now).map(({ name, value }) =>
      name ? name + '=' + value : value,
    );
    return pairs.length ? pairs.join('; ') : undefined;
  }

  private matching(request: CookieRequest, now: number): StoredCookie[] {
    this.evict(now);
    const matched = this.cookies.filter((cookie) => {
      if (!pathMatches(request.path, cookie.path)) return false;
      if (cookie.secure && !this.secureOrigin) return false;
      return sameSiteAllows(effectiveSameSite(cookie.sameSite), request);
    });
    matched.sort(
      (a, b) => b.path.length - a.path.length || a.created - b.created || a.order - b.order,
    );
    for (const cookie of matched) cookie.lastAccess = now;
    return matched;
  }

  /**
   * The Cookie header the guest receives: the jar's cookies, then those page
   * script wrote (`page`, a Cookie header read from the page-visible store)
   * whose names the jar does not hold, bounded by `pageHeaderBytes`.
   */
  cookieHeader(
    request: CookieRequest,
    page: string | undefined,
    now = Date.now(),
  ): string | undefined {
    const own = this.matching(request, now);
    const held = new Set(this.cookies.map((cookie) => cookie.name));
    const pairs = own.map(({ name, value }) => (name ? name + '=' + value : value));
    let budget = PREVIEW_COOKIE_LIMITS.pageHeaderBytes;
    for (const entry of (page ?? '').split(';')) {
      const pair = entry.trim();
      if (!pair || pair.startsWith('=') || CONTROL.test(pair)) continue;
      const at = pair.indexOf('=');
      if (held.has(at < 0 ? '' : pair.slice(0, at).trim())) continue;
      const size = bytes(pair) + 2;
      if (size > budget) break;
      budget -= size;
      pairs.push(pair);
    }
    return pairs.length ? pairs.join('; ') : undefined;
  }
}
