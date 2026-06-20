/**
 * Browser-lifecycle helper for the reconnecting client.
 *
 * The implementation lives on the `@inbrowser/resumable` root barrel (the
 * generic transport relay builds on). This module re-exports it for the
 * relay-local client; both are surfaced from the `@inbrowser/relay` root.
 */
export { installBrowserLifecycle } from '@inbrowser/resumable';
