/**
 * Browser-lifecycle helper for the reconnecting client.
 *
 * The implementation now lives in `@inbrowser/resumable/client` (the generic
 * transport relay builds on). This module is kept as the public
 * `@inbrowser/relay/client/browser` subpath for backward compatibility, and
 * re-exports it unchanged.
 */
export { installBrowserLifecycle } from '@inbrowser/resumable/client';
