/**
 * `createResumableClient` — relay-specialized reconnecting consumer of a
 * relay's `/inference/job` + `/inference/job/:id/stream` endpoints.
 *
 * A thin wrapper over the generic transport in `@inbrowser/resumable/client`,
 * typed to `InferenceEvent`: transport errors (start failed, job 404, gave up
 * reconnecting) surface as `{ kind: 'error' }` events on the stream, and the
 * `relay ` label reproduces the relay's error-message wording.
 */
import {
  type ClientMessage,
  createResumableClient as createGenericClient,
  installBrowserLifecycle,
} from '@inbrowser/resumable/client';
import type { InferenceEvent, NormalizedRequest } from '../types.js';

export interface ResumableClientOpts {
  /** URL the client POSTs to start a new job. */
  startUrl: string;
  /** Builds the stream URL given a jobId + resume offset. */
  streamUrl: (jobId: string, from: number) => string;
  /** Failsafe — give up after this many reconnect attempts. Default 300. */
  maxAttempts?: number;
  /** Gap before each reconnect, in ms. Default 300. */
  reconnectDelayMs?: number;
  /** Diagnostics for each reconnect decision. */
  onReconnect?: (info: {
    attempt: number;
    received: number;
    reason: 'connect_failed' | 'read_error' | 'stream_ended_no_done';
  }) => void;
  /** Called when the consumer aborts the controller. */
  onConsumerAbort?: () => void;
  /**
   * Hook for cutting the current connection from outside the stream (e.g.
   * page-visibility integration). See `installBrowserLifecycle`.
   */
  installLifecycle?: (abortCurrentConnection: () => void) => () => void;
  /** Inject a fetch implementation. Default uses the global. */
  fetchImpl?: typeof fetch;
}

export interface ResumableClient {
  /**
   * Start an inference job and yield every event until terminal. Survives
   * connection drops by reconnecting with `from=received`.
   */
  stream(req: NormalizedRequest): AsyncIterable<InferenceEvent>;
}

export function createResumableClient(opts: ResumableClientOpts): ResumableClient {
  const client = createGenericClient<InferenceEvent>({
    startUrl: opts.startUrl,
    streamUrl: opts.streamUrl,
    label: 'relay ',
    maxAttempts: opts.maxAttempts,
    reconnectDelayMs: opts.reconnectDelayMs,
    onReconnect: opts.onReconnect,
    onConsumerAbort: opts.onConsumerAbort,
    installLifecycle: opts.installLifecycle,
    fetchImpl: opts.fetchImpl,
  });
  return {
    async *stream(req: NormalizedRequest): AsyncIterable<InferenceEvent> {
      const { signal, ...rest } = req;
      for await (const msg of client.stream(rest, signal) as AsyncIterable<
        ClientMessage<InferenceEvent>
      >) {
        yield msg.type === 'event' ? msg.event : { kind: 'error', message: msg.message };
      }
    },
  };
}

export { installBrowserLifecycle };
