// url.urlToHttpOptions, ported from Node.js v22.18.0 lib/internal/url.js.
// Copyright Joyent, Inc. and other Node contributors. Released under the MIT
// license (see LICENSE in the Node.js repository). The `url` 0.11.4 polyfill
// predates it.

/** Converts a WHATWG URL (or URL-like object) into an http.request options object. */
export function urlToHttpOptions(url: Record<string, unknown>): Record<string, unknown> {
  // V8 words the destructuring failure with the parameter's source name, but the
  // bundler renames `url` (it collides with the `url` module import), so say it here.
  if (url == null)
    throw new TypeError(`Cannot destructure property 'hostname' of 'url' as it is ${url}.`);
  const { hostname, pathname, port, username, password, search } = url as {
    hostname: string;
    pathname: string;
    port: string;
    username: string;
    password: string;
    search: string;
  };
  const options: Record<string, unknown> = {
    __proto__: null,
    ...url, // In case the url object was extended by the user.
    protocol: url.protocol,
    hostname: hostname && hostname[0] === '[' ? hostname.slice(1, -1) : hostname,
    hash: url.hash,
    search: search,
    pathname: pathname,
    path: `${pathname || ''}${search || ''}`,
    href: url.href,
  };
  if (port !== '') options.port = Number(port);
  if (username || password)
    options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
  return options;
}
