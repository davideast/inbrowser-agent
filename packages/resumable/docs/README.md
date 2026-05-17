# @inbrowser/resumable Docs

These docs use the Diataxis approach. Each page serves one user need instead of
mixing a lesson, a task guide, reference facts, and design discussion together.

## Learn By Doing

- [Tutorial: build a resumable stream](tutorial.md) walks through a complete
  memory-store example and shows how replay from an offset works.

## Work On A Task

- [How to use RTDB for durable jobs](how-to-use-rtdb.md) covers the production
  store, TTL sweeps, RTDB indexing, and verification probes.

## Look Up Facts

- [API reference](reference.md) describes the exports, core types, store
  contract, store implementations, and testing utilities.

## Understand The Design

- [How resumable jobs work](how-it-works.md) explains the event-log model,
  terminal markers, TTL ownership, and why this package stays below LLM and
  HTTP concerns.
