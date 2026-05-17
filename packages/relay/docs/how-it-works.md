# How The Relay Works

`@inbrowser/relay` turns an LLM provider stream into a durable event log that
clients can tail through SSE.

## The Lifecycle

A relay request has two HTTP phases:

1. `handleStart(request)` parses a `NormalizedRequest`, chooses a provider, and
   starts a `@inbrowser/resumable` job.
2. `handleStream(request, { jobId, from })` reads that job log and streams each
   `InferenceEvent` as SSE.

The provider runs once on the server. Clients may connect, disconnect, and
reconnect while the job continues writing events to the store.

The relay is not a distributed job scheduler. If the process running the
provider is killed, the stored events remain durable, but this package does not
restart the upstream provider call.

## Providers And Adapters Are Different

A provider knows an upstream LLM protocol. It converts a normalised request into
Gemini, OpenRouter, Anthropic, or another provider's API and yields
`InferenceEvent`s.

An adapter knows an HTTP framework. It converts framework request and response
objects into the relay's Web-standard `Request` and `Response` shape.

Keeping these separate means adding a provider does not require changing Astro,
Express, or client code. Adding a framework adapter does not require knowing any
LLM protocol.

## What Is Stored

The relay stores:

- provider and model metadata on the job;
- streamed `InferenceEvent`s in sequence order;
- terminal job state from the underlying engine.

The relay passes `apiKey` to the selected provider but does not write it into
job metadata.

## Replay Is Offset-Based

The client counts delivered events. When the stream drops, it reconnects to the
same job with `from=<count>`.

For example, after receiving event sequences `0`, `1`, and `2`, the next
request uses `from=3`. The relay skips earlier events and continues from the
next one.

## `[DONE]` Means Terminal

SSE connections can close for many reasons. The relay distinguishes those cases
with a sentinel:

- `data: [DONE]` means the job reached terminal state and the client should
  stop reconnecting.
- A closed connection without `[DONE]` means the watch or transport ended before
  terminal state; the client should reconnect from its current offset.

This lets connection loss be treated as normal transport churn rather than a
failed generation.

## The First SSE Byte Is Intentional

The relay writes `: stream-open\n\n` before model events. That line is an SSE
comment, so clients ignore it. Its job is to put a body byte on the wire early
so proxies and hosting layers are more likely to flush response headers before
the first model token arrives.

The Express adapter also calls `flushHeaders()` when available so Node sends the
status and headers promptly.

## Why There Is A Browser Lifecycle Helper

Mobile browsers may leave a backgrounded fetch in a half-dead state. When the
tab becomes visible again, `installBrowserLifecycle()` aborts the current
connection. The reconnecting client then opens a fresh stream from the last
received offset.

The server job keeps running during that client-side churn because the producer
is independent of the browser connection.
