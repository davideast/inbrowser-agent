# How Resumable Jobs Work

`@inbrowser/resumable` treats streaming work as an event-log problem. The producer
does the work once. Subscribers can come and go because the events are written
to a store before they are consumed.

## Engine And Store

The package is split into two responsibilities:

- `JobEngine` drives producers, assigns sequence numbers, exposes
  subscriptions, and turns producer completion or failure into terminal job
  state.
- `JobStore` owns persistence, snapshots, watch notifications, deletion, and
  optional TTL sweeping.

This split keeps the engine generic. A store can be in-memory, RTDB, Redis,
Postgres, Firestore, or anything else that can preserve ordered event values
and notify watchers.

## Sequence Numbers Are The Resume Contract

Each yielded event is appended at a zero-based sequence number. A subscriber
tracks the next event it needs and passes that value as `from` when it
reconnects.

If a subscriber has received events `0`, `1`, and `2`, it reconnects with
`from: 3`. The store may use that value as an optimisation, but the engine
also deduplicates by sequence while walking snapshots.

## Terminal State Is Separate From Events

The stream ends with a terminal marker:

```ts
{ kind: 'terminal', status: 'done' }
```

That marker is derived from job status, not appended as a normal event. This
keeps the domain event log pure while still giving subscribers a clear end of
stream.

Producer outcomes map to terminal state:

- normal completion becomes `done`;
- a thrown error becomes `error` with a reason;
- an aborted producer becomes `cancelled`.

## TTL Is Post-Terminal Retention

`ttlMs` does not mean "delete this job after N milliseconds from creation".
It means "retain this job for N milliseconds after it reaches a terminal
state".

That distinction matters for long-running work. A running job has
`expiresAt: null`, so a sweep must not delete it. `expiresAt` is computed only
when the store finishes the job.

## Why The RTDB Store Serialises Events

RTDB can coerce arrays and objects in ways that are convenient for database
trees but unsafe for arbitrary event payloads. The RTDB store writes each event
as a JSON string under `events/{seq}`. That makes the event value opaque to
RTDB and lets snapshots reconstruct the original event shape.

## Why HTTP Is Not In This Package

HTTP is a consumer concern. `@inbrowser/resumable` knows how to run jobs and replay
events; it does not know whether those events become SSE, WebSocket messages,
CLI output, or another protocol.

`@inbrowser/relay` is one HTTP consumer. It uses the engine and store contract
to make LLM provider streams resumable, then adds Web handlers, SSE framing,
provider plug-ins, framework adapters, and a reconnecting client.
