// A process Worker has one `process` object and so one set of
// `uncaughtException` consumers. A module that catches a guest throw in order
// to fail its own operation (an HTTP exchange) offers the error here first, the
// way context-hook.ts lends out the async context, instead of taking the
// process lifecycle as a parameter.

type Offer = (error: unknown) => boolean;

let offer: Offer | undefined;

/** Installed once by the process bootstrap, before any guest code runs. */
export function installUncaughtOffer(next: Offer): void {
  offer = next;
}

/**
 * Delivers `error` to the guest's capture callback or `uncaughtException`
 * listeners when it has any, and reports whether it did. With none the caller
 * keeps its own failure handling.
 */
export function offerUncaught(error: unknown): boolean {
  return offer ? offer(error) : false;
}
