/**
 * Browser-lifecycle helper for the reconnecting client.
 *
 * Returns a `ResumableClientOpts['installLifecycle']` callback that
 * proactively aborts the current connection when `visibilitychange`
 * fires with `document.visibilityState === 'visible'`. The connection
 * that was open while backgrounded is almost certainly a severed
 * socket (Android Chrome tears upstream sockets after a few minutes
 * in the background); cutting it on resume makes the client
 * reconnect immediately rather than waiting for the OS-level read
 * timeout, which is tens of seconds.
 *
 * SSR-safe: when `document` is undefined (Astro build time, Node),
 * the returned `installLifecycle` is a no-op.
 *
 * Wire it via:
 *
 *   import { createResumableClient } from '@inbrowser/relay/client';
 *   import { installBrowserLifecycle } from '@inbrowser/relay/client';
 *
 *   const client = createResumableClient({
 *     startUrl, streamUrl,
 *     installLifecycle: installBrowserLifecycle(),
 *   });
 */
export function installBrowserLifecycle(): (
  abortCurrentConnection: () => void,
) => () => void {
  return (abortCurrentConnection) => {
    if (typeof document === 'undefined') return () => {};
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') abortCurrentConnection();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  };
}
